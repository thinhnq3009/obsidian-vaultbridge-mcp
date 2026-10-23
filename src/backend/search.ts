import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import chokidar, { type FSWatcher } from "chokidar";
import MiniSearch from "minisearch";

import type { IndexMode, WatchMode } from "../types.js";
import { VaultError } from "../types.js";
import type { VaultAccessPolicy } from "./accessPolicy.js";
import { parseMetadata } from "./markdown.js";
import { matchRegex } from "./regex.js";
import type { SearchQuery, SearchResponse } from "./types.js";

type SearchDocument = {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
};

type PersistedIndex = {
  documents: SearchDocument[];
  savedAt: string;
};

type SearchRequest = {
  query: SearchQuery;
  resolve: (response: SearchResponse) => void;
  reject: (error: unknown) => void;
};

const INDEX_FILE = "search-index.json";
const MAX_SEARCH_BATCH = 50;

export class VaultSearchService {
  private readonly documents = new Map<string, SearchDocument>();
  private miniSearch = createMiniSearch();
  private watcher: FSWatcher | undefined;
  private effectiveMode: "scan" | "indexed" = "scan";
  private state: "scan" | "ready" | "building" | "degraded" = "scan";
  private error: string | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly pendingEvents = new Set<Promise<void>>();
  // Every index read/refresh shares one queue. Events describe paths to reconcile,
  // never historical document contents or a blind instruction to delete an ID.
  private operationChain: Promise<unknown> = Promise.resolve();
  private consistencyError: string | undefined;
  private cacheDirty = false;
  private searchBatch: SearchRequest[] | undefined;

  public constructor(
    private readonly vaultRoot: string,
    private readonly cacheDir: string,
    private readonly indexMode: IndexMode,
    private readonly watchMode: WatchMode,
    private readonly maxFileSizeBytes: number,
    private readonly accessPolicy: VaultAccessPolicy,
  ) {}

  public async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    // Never load cached note bodies: a previous process may have had broader scopes.
    await fs.rm(path.join(this.cacheDir, INDEX_FILE), { force: true });
    try {
      await this.loadOrBuild();
    } catch (error) {
      this.state = "degraded";
      this.error = error instanceof Error ? error.message : String(error);
      this.effectiveMode = "scan";
      await this.scanDocuments();
    }
    if (this.watchMode !== "off") await this.startWatcher();
  }

  public async close(): Promise<void> {
    await this.watcher?.close();
    await Promise.allSettled(this.pendingEvents);
    await this.operationChain;
    if (this.cacheDirty && !this.consistencyError && this.effectiveMode === "indexed") await this.persist();
    await this.persistChain;
  }

  public getStatus() {
    return { state: this.state, mode: this.effectiveMode, error: this.error };
  }

  public rebuild(): Promise<{ indexedFiles: number; mode: string }> {
    this.searchBatch = undefined;
    return this.enqueue(async () => {
      try {
        const result = await this.rebuildNow();
        this.consistencyError = undefined;
        return result;
      } catch (error) {
        this.failConsistency(error);
        throw error;
      }
    });
  }

  private async rebuildNow(): Promise<{ indexedFiles: number; mode: string }> {
    this.state = "building";
    this.error = undefined;
    await this.scanDocuments();
    this.effectiveMode = this.resolveMode(this.documents.size);
    if (this.effectiveMode === "indexed") await this.persist();
    this.state = this.effectiveMode === "indexed" ? "ready" : "scan";
    return { indexedFiles: this.documents.size, mode: this.effectiveMode };
  }

  public search(query: SearchQuery): Promise<SearchResponse> {
    return new Promise<SearchResponse>((resolve, reject) => {
      const request = { query, resolve, reject };
      if (this.searchBatch && this.searchBatch.length < MAX_SEARCH_BATCH) {
        this.searchBatch.push(request);
        return;
      }
      const batch = [request];
      this.searchBatch = batch;
      void this.enqueue(async () => {
        // Seal before authorization starts: later arrivals need a fresh pass.
        if (this.searchBatch === batch) this.searchBatch = undefined;
        if (this.consistencyError) throw new VaultError(`Search index is unavailable: ${this.consistencyError}. Rebuild the search index before searching.`, { code: "INDEX_ERROR" });
        if (await this.pruneUnauthorized() && this.effectiveMode === "indexed") await this.persist();
        // Hold the operation queue while regex workers run against this snapshot.
        // Mutations/rebuilds seal the batch and cannot interleave with projections.
        for (const pending of batch) {
          try { pending.resolve(await this.searchNow(pending.query)); }
          catch (error) { pending.reject(error); }
        }
      }).catch((error: unknown) => { for (const pending of batch) pending.reject(error); });
    });
  }

  private async searchNow(query: SearchQuery): Promise<SearchResponse> {
    const offset = decodeCursor(query.cursor);
    const exact = query.match === "exact" || query.caseSensitive === true;
    let results = this.effectiveMode === "indexed" && !exact && query.query?.trim()
      ? this.miniSearch.search(query.query, { prefix: true, fuzzy: 0.2 }).map((result) => ({ document: this.documents.get(String(result.id)), score: result.score }))
      : [...this.documents.values()].map((document) => ({ document, score: 1 }));

    const needle = query.query?.trim();
    results = results.filter((candidate) => {
      const document = candidate.document;
      if (!document) return false;
      if (query.folder && !(document.path === query.folder || document.path.startsWith(`${query.folder.replace(/\/$/u, "")}/`))) return false;
      if (query.tag && !document.tags.includes(query.tag.replace(/^#/u, ""))) return false;
      if (query.frontmatter && !Object.entries(query.frontmatter).every(([key, value]) => deepEqual(document.frontmatter[key], value))) return false;
      if (needle && (this.effectiveMode === "scan" || exact)) {
        const haystack = `${document.path}\n${document.content}`;
        if (query.caseSensitive ? !haystack.includes(needle) : !haystack.toLowerCase().includes(needle.toLowerCase())) return false;
      }
      return true;
    });

    if (query.regex) {
      const matches = await matchRegex(query.regex, query.caseSensitive === true, results.map((candidate) => candidate.document!.content));
      // External filesystem changes can revoke access while the worker runs.
      // Recheck before publishing captured bodies/snippets or serving the batch.
      if (await this.pruneUnauthorized() && this.effectiveMode === "indexed") await this.persist();
      results = results.filter((candidate, index) => matches.has(index) && this.documents.has(candidate.document!.path));
    }

    if (query.sort === "path") results.sort((left, right) => left.document!.path.localeCompare(right.document!.path));
    else results.sort((left, right) => right.score - left.score || left.document!.path.localeCompare(right.document!.path));

    const page = results.slice(offset, offset + query.limit);
    const output = page.map(({ document, score }) => ({
      path: document!.path,
      score,
      snippet: buildSnippet(document!.content, needle ?? query.regex ?? ""),
    }));
    const nextOffset = offset + output.length;
    return {
      results: output,
      ...(nextOffset < results.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  }

  /** Reconcile committed mutations (under their lock) and watcher paths. */
  public synchronize(absolutePaths: string[], subtree = false): Promise<void> {
    this.searchBatch = undefined;
    return this.enqueue(async () => {
      try {
        if (this.consistencyError) throw new VaultError("Search index requires a successful rebuild.", { code: "INDEX_ERROR" });
        // Persisted bodies are never loaded at startup. Invalidate the old cache
        // once, then write a fresh snapshot on close/rebuild, not on every note.
        if (!this.cacheDirty) {
          await fs.rm(path.join(this.cacheDir, INDEX_FILE), { force: true });
          this.cacheDirty = true;
        }
        const affected = new Set(absolutePaths);
        // Reconcile canonical targets too when writes use an allowed in-vault
        // directory alias. Search continues to exclude the alias itself.
        for (const absolute of absolutePaths) {
          try {
            // Final-component links are never indexable. Parent aliases still
            // resolve so committed writes refresh their canonical note target.
            if (!(await fs.lstat(absolute)).isSymbolicLink()) affected.add(await fs.realpath(absolute));
          } catch (error) { if (!isUnavailablePath(error)) throw error; }
        }
        for (const absolute of affected) await this.reconcile(absolute, subtree);
      } catch (error) {
        this.failConsistency(error);
        throw error;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationChain.then(operation);
    this.operationChain = pending.catch(() => undefined);
    return pending;
  }

  private failConsistency(error: unknown): void {
    this.consistencyError = error instanceof Error ? error.message : String(error);
    this.state = "degraded";
    this.error = this.consistencyError;
  }

  private async reconcile(absolute: string, subtree: boolean): Promise<void> {
    const relative = toVaultPath(path.relative(this.vaultRoot, absolute));
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (!isUnavailablePath(error)) throw error;
    }
    // Remove stale descendants even when a directory disappeared or became a
    // file/link. A file edit only updates that one ID; no vault walk or rebuild.
    if (subtree || stat?.isDirectory()) {
      for (const documentPath of this.documents.keys()) {
        if (documentPath.startsWith(`${relative}/`)) this.remove(path.join(this.vaultRoot, documentPath));
      }
    }
    if (stat?.isDirectory()) {
      this.remove(absolute);
      const files = isExcluded(this.vaultRoot, absolute) ? []
        : await collectMarkdownFiles(absolute, this.maxFileSizeBytes, this.accessPolicy);
      for (const file of files) await this.upsert(file);
    } else {
      await this.upsert(absolute);
    }
  }

  private async loadOrBuild(): Promise<void> {
    const files = await collectMarkdownFiles(this.vaultRoot, this.maxFileSizeBytes, this.accessPolicy);
    this.effectiveMode = this.resolveMode(files.length);
    if (this.effectiveMode === "scan") {
      await this.scanDocuments(files);
      this.state = "scan";
      return;
    }

    await this.scanDocuments(files);
    await this.persist();
    this.state = "ready";
  }

  private resolveMode(fileCount: number): "scan" | "indexed" {
    if (this.indexMode === "scan") return "scan";
    if (this.indexMode === "indexed") return "indexed";
    return fileCount < 1000 ? "scan" : "indexed";
  }

  private async scanDocuments(files?: string[]): Promise<void> {
    this.documents.clear();
    this.miniSearch = createMiniSearch();
    const candidates = files ?? await collectMarkdownFiles(this.vaultRoot, this.maxFileSizeBytes, this.accessPolicy);
    for (const absolutePath of candidates) await this.upsert(absolutePath);
    this.rebuildMiniSearch();
  }

  private rebuildMiniSearch(): void {
    this.miniSearch = createMiniSearch();
    this.miniSearch.addAll([...this.documents.values()]);
  }

  private async upsert(absolutePath: string): Promise<void> {
    const relative = toVaultPath(path.relative(this.vaultRoot, absolutePath));
    try {
      if (!absolutePath.toLowerCase().endsWith(".md") || isExcluded(this.vaultRoot, absolutePath)
        || !(await this.accessPolicy.allowsSearchPath(absolutePath))) {
        this.remove(absolutePath);
        return;
      }
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile() || stat.size > this.maxFileSizeBytes) {
        this.remove(absolutePath);
        return;
      }
      // Open the final component without following links where supported. Validate
      // the descriptor and full canonical path again to catch replacement races.
      const handle = await fs.open(absolutePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let content: string;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > this.maxFileSizeBytes
          || !(await this.accessPolicy.allowsSearchPath(absolutePath))) {
          this.remove(absolutePath);
          return;
        }
        content = await handle.readFile("utf8");
        const current = await fs.lstat(absolutePath);
        if (Buffer.byteLength(content, "utf8") > this.maxFileSizeBytes || current.dev !== opened.dev || current.ino !== opened.ino
          || !(await this.accessPolicy.allowsSearchPath(absolutePath))) {
          this.remove(absolutePath);
          return;
        }
      } finally {
        await handle.close();
      }
      let metadata: ReturnType<typeof parseMetadata>;
      try {
        metadata = parseMetadata(content);
      } catch {
        metadata = { frontmatter: {}, headings: [], tags: [], links: [] };
      }
      const document: SearchDocument = {
        id: relative,
        path: relative,
        title: path.basename(relative, path.extname(relative)),
        content,
        tags: metadata.tags,
        frontmatter: metadata.frontmatter,
      };
      const previous = this.documents.get(relative);
      this.documents.set(relative, document);
      if (previous && this.miniSearch.has(previous.id)) this.miniSearch.replace(document);
      else this.miniSearch.add(document);
    } catch (error) {
      // A missing path/link can race with a commit. Unexpected read/index errors
      // must reach synchronize; success must never conceal a stale snapshot.
      if (!isUnavailablePath(error)) throw error;
      this.remove(absolutePath);
    }
  }

  private remove(absolutePath: string): void {
    const relative = toVaultPath(path.relative(this.vaultRoot, absolutePath));
    const previous = this.documents.get(relative);
    if (previous && this.miniSearch.has(previous.id)) this.miniSearch.discard(previous.id);
    this.documents.delete(relative);
  }

  private async pruneUnauthorized(): Promise<boolean> {
    let removed = false;
    for (const relative of this.documents.keys()) {
      const absolute = path.join(this.vaultRoot, relative);
      if (isExcluded(this.vaultRoot, absolute) || !(await this.accessPolicy.allowsSearchPath(absolute))) {
        this.remove(absolute);
        removed = true;
      }
    }
    return removed;
  }

  private async startWatcher(): Promise<void> {
    this.watcher = chokidar.watch(this.vaultRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (watchedPath) => isExcluded(this.vaultRoot, watchedPath) || !this.accessPolicy.mayTraverse(watchedPath),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    });
    const degrade = (error: unknown) => {
      this.state = "degraded";
      this.error = error instanceof Error ? error.message : String(error);
    };
    const track = (operation: Promise<void>) => {
      const pending = operation.catch(degrade).finally(() => { this.pendingEvents.delete(pending); });
      this.pendingEvents.add(pending);
    };
    const refreshFile = (file: string) => {
      if (file.toLowerCase().endsWith(".md")) track(this.synchronize([file]));
    };
    this.watcher.on("add", refreshFile);
    this.watcher.on("change", refreshFile);
    this.watcher.on("unlink", refreshFile);
    this.watcher.on("unlinkDir", (directory) => { track(this.synchronize([directory], true)); });
    this.watcher.on("error", degrade);
    await new Promise<void>((resolve) => {
      this.watcher!.once("ready", resolve);
      this.watcher!.once("error", () => { resolve(); });
    });
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.writePersistedIndex());
    return this.persistChain;
  }

  private async writePersistedIndex(): Promise<void> {
    await this.pruneUnauthorized();
    const destination = path.join(this.cacheDir, INDEX_FILE);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ documents: [...this.documents.values()], savedAt: new Date().toISOString() } satisfies PersistedIndex), "utf8");
      await fs.rename(temporary, destination);
      this.cacheDirty = false;
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function createMiniSearch(): MiniSearch<SearchDocument> {
  return new MiniSearch<SearchDocument>({ fields: ["title", "path", "content", "tags"], storeFields: ["path"], tokenize: (value) => value.toLowerCase().split(/[^\p{L}\p{N}_/-]+/u).filter(Boolean) });
}

async function collectMarkdownFiles(root: string, maxFileSizeBytes: number, policy: VaultAccessPolicy): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    if (!(await policy.allowsSearchPath(directory, true))) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (isExcluded(root, absolute)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (!(await policy.allowsSearchPath(absolute))) continue;
        const stat = await fs.lstat(absolute);
        if (stat.isFile() && stat.size <= maxFileSizeBytes) files.push(absolute);
      }
    }
  };
  await walk(root);
  return files;
}

function isExcluded(root: string, absolutePath: string): boolean {
  const parts = toVaultPath(path.relative(root, absolutePath)).split("/");
  return parts.some((part) => part === ".obsidian" || part === ".git" || part.startsWith(".obsidian-vault-mcp-"));
}

function buildSnippet(content: string, needle: string): string {
  const normalized = needle.replace(/[.*+?^${}()|[\]\\]/gu, "");
  const index = normalized ? content.toLowerCase().indexOf(normalized.toLowerCase()) : 0;
  const start = Math.max(0, index - 80);
  return content.slice(start, start + 240).replace(/\s+/gu, " ").trim();
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof value.offset === "number" && value.offset >= 0 ? value.offset : 0;
  } catch {
    return 0;
  }
}

function toVaultPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isUnavailablePath(error: unknown): boolean {
  return isMissing(error) || (error instanceof Error && "code" in error && error.code === "ELOOP");
}
