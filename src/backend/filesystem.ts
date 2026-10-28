import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { RequestAccessPolicy } from "../auth/authorization.js";
import type { OperationAuthorization } from "../auth/authorization.js";
import { authorizationDenied } from "../auth/requestContext.js";
import type { AppConfig, NoteJsonMetadata, NoteReadResult, PatchOperation, VaultEntry } from "../types.js";
import { normalizeVaultPathInput, VaultError } from "../types.js";
import { VaultAccessPolicy } from "./accessPolicy.js";
import { agentEditField, prepareAgentEdit } from "./agentEditTimestamp.js";
import { parseMetadata, patchFrontmatterContent, patchHeadingContent } from "./markdown.js";
import { ensurePrivateDirectory } from "./privateCache.js";
import { VaultSearchService } from "./search.js";
import type { BackendCapabilities, BackendStatus, NoteEdits, NoteEditsResult, PathStat, SearchQuery, SearchResponse, VaultBackend, WriteOptions } from "./types.js";

export class FilesystemVaultBackend implements VaultBackend {
  public readonly capabilities: BackendCapabilities = { activeFile: false, openFile: false, searchIndex: true, filesystem: true };
  private vaultRoot = "";
  private vaultRealPath = "";
  private cacheRealPath = "";
  private searchService: VaultSearchService | undefined;
  private accessPolicy!: VaultAccessPolicy;

  public constructor(private readonly config: AppConfig) {
    if (!config.vaultPath) throw new VaultError("VAULT_PATH is required for filesystem backend.", { code: "INVALID_PATH" });
    this.vaultRoot = path.resolve(config.vaultPath);
  }

  /** Internal Phase A seam: short-lived operation view, never initialize/close it. */
  public withAuthorization(authorization: OperationAuthorization): FilesystemVaultBackend {
    if (!this.vaultRealPath || !this.cacheRealPath || !this.searchService
      || pathsOverlap(this.vaultRealPath, this.cacheRealPath)) throw authorizationDenied();
    const scoped = new FilesystemVaultBackend(this.config);
    scoped.vaultRealPath = this.vaultRealPath;
    scoped.cacheRealPath = this.cacheRealPath;
    scoped.searchService = this.searchService;
    scoped.accessPolicy = new RequestAccessPolicy(this.vaultRealPath, this.accessPolicy, authorization);
    return scoped;
  }

  private async revalidateAuthorization(): Promise<void> {
    if (this.accessPolicy instanceof RequestAccessPolicy) await this.accessPolicy.revalidate();
  }

  public async preflightWriteNotes(paths: readonly string[]): Promise<void> {
    for (const input of paths) await this.accessPolicy.resolve(input, "write", false);
    await this.revalidateAuthorization();
  }

  public async initialize(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.vaultRoot);
    } catch {
      throw new VaultError(`Vault path does not exist: ${this.vaultRoot}`, { code: "NOT_FOUND" });
    }
    if (!stat.isDirectory()) throw new VaultError(`Vault path is not a directory: ${this.vaultRoot}`, { code: "INVALID_PATH" });
    this.vaultRealPath = await fs.realpath(this.vaultRoot);
    await fs.access(this.vaultRealPath, this.config.readOnly ? constants.R_OK : constants.R_OK | constants.W_OK);
    this.accessPolicy = new VaultAccessPolicy(this.vaultRealPath, this.config.readOnly, this.config.readPaths, this.config.writePaths);
    const vaultCacheDir = path.join(this.config.cacheDir, createHash("sha256").update(this.vaultRealPath).digest("hex").slice(0, 16));
    this.searchService = new VaultSearchService(this.vaultRealPath, vaultCacheDir, this.config.indexMode, this.config.watchMode, this.config.maxFileSizeBytes, this.accessPolicy);
    await this.searchService.initialize();
    this.cacheRealPath = await fs.realpath(this.config.cacheDir);
  }

  public async close(): Promise<void> {
    await this.searchService?.close();
  }

  public status(): Promise<BackendStatus> {
    const index = this.searchService?.getStatus();
    return Promise.resolve({
      backend: "filesystem",
      vaultPath: this.vaultRealPath || this.vaultRoot,
      readOnly: this.config.readOnly,
      capabilities: this.capabilities,
      indexState: index?.state ?? "disabled",
      ...(index?.error ? { indexError: index.error } : {}),
    });
  }

  public async health(): Promise<{ ok: boolean; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    try {
      await fs.access(this.vaultRealPath);
      checks.vault = "readable";
      if (!this.config.readOnly) {
        const probe = path.join(this.config.cacheDir, `.health-${process.pid}`);
        await fs.mkdir(this.config.cacheDir, { recursive: true });
        await fs.writeFile(probe, "ok", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.unlink(probe);
        checks.cache = "writable";
      }
    } catch (error) {
      checks.error = error instanceof Error ? error.message : String(error);
    }
    checks.index = this.searchService?.getStatus().state ?? "disabled";
    return { ok: checks.error === undefined, checks };
  }

  public async listFiles(input = ""): Promise<{ entries: VaultEntry[]; root: string }> {
    const resolved = await this.accessPolicy.resolve(input, "read", true);
    const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
    if (entries.length > this.config.maxTreeEntries) throw new VaultError("Directory entry limit exceeded.", { code: "FILE_TOO_LARGE" });
    const result = {
      root: resolved.relative,
      entries: (await Promise.all(entries.map(async (entry) => {
        const relative = joinVaultPath(resolved.relative, entry.name);
        try { await this.accessPolicy.resolve(relative, "read", true); }
        catch (error) {
          // Broken/disappearing links cannot be authorized, but must not prevent
          // listing healthy siblings. Unexpected filesystem failures still fail.
          if (error instanceof VaultError && ["ACCESS_DENIED", "INVALID_PATH", "NOT_FOUND"].includes(error.code)) return [];
          if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR") || isCode(error, "ELOOP")) return [];
          throw error;
        }
        return [{ path: relative, name: entry.name, isFolder: entry.isDirectory() }];
      }))).flat(),
    };
    await this.revalidateAuthorization();
    return result;
  }

  public async statPath(input: string): Promise<PathStat> {
    try {
      const resolved = await this.accessPolicy.resolve(input, "read", true);
      const stat = await fs.stat(resolved.absolute);
      const result = {
        path: resolved.relative,
        exists: true,
        kind: stat.isDirectory() ? "folder" as const : "file" as const,
        size: stat.isFile() ? stat.size : null,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        revision: stat.isFile() ? await revisionForFile(resolved.absolute, this.config.maxFileSizeBytes) : null,
      };
      await this.revalidateAuthorization();
      return result;
    } catch (error) {
      if (error instanceof VaultError && error.code === "NOT_FOUND") return { path: normalizeVaultPathInput(input), exists: false, kind: "missing", size: null, ctime: null, mtime: null, revision: null };
      throw error;
    }
  }

  public async readNote(input: string): Promise<NoteReadResult> {
    const resolved = await this.accessPolicy.resolve(input, "read", true);
    const existing = await readExisting(resolved.absolute, this.config.maxFileSizeBytes);
    await this.revalidateAuthorization();
    if (!existing) throw new VaultError(`Path does not exist: ${resolved.relative}`, { code: "NOT_FOUND" });
    return {
      path: resolved.relative,
      content: existing.content,
      contentType: contentTypeFor(resolved.relative),
      etag: null,
      lastModified: existing.stat.mtime.toUTCString(),
      revision: existing.revision,
    };
  }

  public writeNote(input: string, content: string, options?: WriteOptions) {
    return this.writeFile(input, content, { contentType: "text/markdown; charset=utf-8", ...options });
  }

  public async writeFile(input: string, content: string, options: WriteOptions = {}) {
    if (Buffer.byteLength(content, "utf8") > this.config.maxFileSizeBytes) throw new VaultError("Content exceeds configured file size limit.", { code: "FILE_TOO_LARGE" });
    const resolved = await this.accessPolicy.resolve(input, "write", false);
    return this.withPathLock(resolved.relative, async () => {
      const existing = await readExisting(resolved.absolute, this.config.maxFileSizeBytes);
      const mode = options.mode ?? "create";
      if (mode === "create" && existing) throw new VaultError(`Path already exists: ${resolved.relative}`, { code: "ALREADY_EXISTS" });
      if (mode === "replace") {
        if (!existing) throw new VaultError(`Path does not exist: ${resolved.relative}`, { code: "NOT_FOUND" });
        requireRevision(options.expectedRevision, existing.revision);
      }
      const next = this.prepareWrite(resolved.relative, content, existing?.content);
      if (!existing || next !== existing.content) {
        await atomicWrite(resolved.absolute, next, existing?.mode, () => this.revalidateAuthorization());
        await this.synchronizeCommitted([resolved.absolute]);
      }
      return { path: resolved.relative, message: existing ? "File replaced successfully." : "File created successfully.", revision: revisionForContent(next) };
    });
  }

  public async appendToNote(input: string, content: string, expectedRevision?: string) {
    return this.updateTextFile(input, expectedRevision, (current) => current + content, "Content appended successfully.");
  }

  public async createFolder(input: string): Promise<{ path: string; created: boolean }> {
    const resolved = await this.accessPolicy.resolve(input, "write", false);
    return this.withPathLock(resolved.relative, async () => {
      try {
        await this.revalidateAuthorization();
        const created = await fs.mkdir(resolved.absolute, { recursive: true });
        return { path: resolved.relative, created: created !== undefined };
      } catch (error) {
        if (isCode(error, "EEXIST")) return { path: resolved.relative, created: false };
        throw mapFsError(error, resolved.relative);
      }
    });
  }

  public async deletePath(input: string, options: { recursive?: boolean; expectedRevision?: string } = {}): Promise<void> {
    const resolved = await this.accessPolicy.resolve(input, "write", true, true);
    await this.withPathLock(resolved.relative, async () => {
      const stat = await fs.stat(resolved.absolute);
      const canonical = await fs.realpath(resolved.absolute);
      if (stat.isFile()) {
        const revision = await revisionForFile(resolved.absolute, this.config.maxFileSizeBytes);
        requireRevision(options.expectedRevision, revision);
        await this.revalidateAuthorization();
        await fs.unlink(resolved.absolute);
      } else {
        if (!options.recursive) throw new VaultError("Folder deletion requires recursive=true.", { code: "ACCESS_DENIED" });
        await this.assertWritableTree(resolved.absolute);
        await this.revalidateAuthorization();
        await fs.rm(resolved.absolute, { recursive: true, force: false });
      }
      await this.synchronizeCommitted([resolved.absolute, canonical], stat.isDirectory());
    });
  }

  public async movePath(sourceInput: string, destinationInput: string, options: { overwrite?: boolean; expectedRevision?: string; expectedDestinationRevision?: string } = {}) {
    const source = await this.accessPolicy.resolve(sourceInput, "write", true, true);
    const destination = await this.accessPolicy.resolve(destinationInput, "write", false, true);
    return this.withPathLock(`${source.relative}->${destination.relative}`, async () => {
      const sourceStat = await fs.stat(source.absolute);
      if (sourceStat.isFile()) requireRevision(options.expectedRevision, await revisionForFile(source.absolute, this.config.maxFileSizeBytes));
      const destinationExists = await exists(destination.absolute);
      if (destinationExists && !options.overwrite) throw new VaultError(`Destination already exists: ${destination.relative}`, { code: "ALREADY_EXISTS" });
      if (destinationExists && options.overwrite) {
        const destinationStat = await fs.stat(destination.absolute);
        if (!destinationStat.isFile()) throw new VaultError("Overwriting a destination folder is not supported.", { code: "ACCESS_DENIED" });
        requireRevision(options.expectedDestinationRevision, await revisionForFile(destination.absolute, this.config.maxFileSizeBytes));
      }
      if (sourceStat.isDirectory()) await this.assertWritableTree(source.absolute);
      await this.revalidateAuthorization();
      await fs.mkdir(path.dirname(destination.absolute), { recursive: true });
      const movedFiles = sourceStat.isDirectory() ? await countFiles(source.absolute, this.config.maxTreeEntries) : 1;
      if (source.absolute !== destination.absolute) {
        const canonicalSource = await fs.realpath(source.absolute);
        await this.revalidateAuthorization();
        await fs.rename(source.absolute, destination.absolute);
        await this.synchronizeCommitted([source.absolute, canonicalSource, destination.absolute], sourceStat.isDirectory());
      }
      return { sourcePath: source.relative, destinationPath: destination.relative, kind: sourceStat.isDirectory() ? "folder" as const : "file" as const, movedFiles };
    });
  }

  private async assertWritableTree(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      await this.accessPolicy.resolve(path.relative(this.vaultRealPath, absolute), "write", true, true);
      if (entry.isDirectory()) await this.assertWritableTree(absolute);
    }
  }

  public async readNoteMetadata(input: string): Promise<NoteJsonMetadata> {
    const note = await this.readNote(input);
    const metadata = parseMetadata(note.content);
    const stat = await fs.stat((await this.accessPolicy.resolve(input, "read", true)).absolute);
    await this.revalidateAuthorization();
    return { path: note.path ?? normalizeVaultPathInput(input), ...metadata, stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }, ...(note.revision ? { revision: note.revision } : {}) };
  }

  public async applyNoteEdits(input: string, expectedRevision: string, edits: NoteEdits): Promise<NoteEditsResult> {
    if (!input.toLowerCase().endsWith(".md")) throw new VaultError("Atomic note edits require a Markdown (.md) file.", { code: "INVALID_PATH" });
    if (edits.frontmatter.length + edits.sections.length === 0) throw new VaultError("At least one edit is required.", { code: "INVALID_QUERY" });

    const result = await this.updateTextFile(input, expectedRevision, (current) => {
      let next = current;
      for (const edit of edits.frontmatter) {
        if (!edit.field.trim() || edit.field.split(".").some((part) => !part.trim())) {
          throw new VaultError("Frontmatter field path must not contain empty segments.", { code: "INVALID_QUERY" });
        }
        if (edit.field.split(".")[0] === agentEditField) {
          throw new VaultError(`${agentEditField} is server-managed.`, { code: "ACCESS_DENIED" });
        }
        next = patchFrontmatterContent(next, edit.field, edit.value, edit.operation, edit.createIfMissing);
      }
      for (const edit of edits.sections) {
        next = patchHeadingContent(next, edit.heading, edit.content, edit.operation, edit.occurrence);
      }
      return next;
    }, "Note edits applied successfully.");

    return {
      ...result,
      frontmatterEdits: edits.frontmatter.length,
      sectionEdits: edits.sections.length,
      changed: result.revision !== expectedRevision,
      revision: result.revision,
    };
  }

  public async patchHeading(input: string, heading: string, content: string, operation: PatchOperation, options: { occurrence?: number; expectedRevision?: string } = {}) {
    const result = await this.updateTextFile(input, options.expectedRevision, (current) => patchHeadingContent(current, heading, content, operation, options.occurrence), "Heading patched successfully.");
    return { ...result, heading, operation };
  }

  public async patchFrontmatter(input: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean, expectedRevision?: string) {
    const result = await this.updateTextFile(input, expectedRevision, (current) => {
      if (field.split(".")[0] === agentEditField) throw new VaultError(`${agentEditField} is server-managed.`, { code: "ACCESS_DENIED" });
      return patchFrontmatterContent(current, field, value, operation, createIfMissing);
    }, "Frontmatter patched successfully.");
    return { ...result, field, operation };
  }

  public async search(query: SearchQuery): Promise<SearchResponse> {
    const policy = this.accessPolicy;
    const authorization = policy instanceof RequestAccessPolicy ? policy.authorization : undefined;
    const fingerprint = authorization?.fingerprint();
    return this.searchService!.search({ ...query, limit: Math.min(query.limit, this.config.maxSearchResults) }, authorization ? {
      fingerprint: fingerprint!,
      allowsPath: (absolute) => policy.allowsSearchPath(absolute),
      assertActive: () => {
        if (authorization.fingerprint() !== fingerprint) throw authorizationDenied();
      },
    } : undefined);
  }

  public rebuildSearchIndex() {
    return this.searchService!.rebuild();
  }

  private async updateTextFile(input: string, expectedRevision: string | undefined, transform: (content: string) => string, message: string) {
    const resolved = await this.accessPolicy.resolve(input, "write", true);
    return this.withPathLock(resolved.relative, async () => {
      const existing = await readExisting(resolved.absolute, this.config.maxFileSizeBytes);
      if (!existing) throw new VaultError(`Path does not exist: ${resolved.relative}`, { code: "NOT_FOUND" });
      requireRevision(expectedRevision, existing.revision);
      const next = this.prepareWrite(resolved.relative, transform(existing.content), existing.content);
      if (next !== existing.content) {
        await atomicWrite(resolved.absolute, next, existing.mode, () => this.revalidateAuthorization());
        await this.synchronizeCommitted([resolved.absolute]);
      }
      return { path: resolved.relative, message, revision: revisionForContent(next) };
    });
  }

  private async synchronizeCommitted(absolutePaths: string[], subtree = false): Promise<void> {
    if (!subtree && !absolutePaths.some((absolute) => absolute.toLowerCase().endsWith(".md"))) return;
    try {
      await this.searchService!.synchronize(absolutePaths, subtree);
    } catch (error) {
      throw new VaultError("Filesystem mutation committed, but search synchronization failed. Read the current state/revision before retrying; rebuild the search index to recover.", {
        code: "INDEX_ERROR",
        details: { committed: true, paths: absolutePaths.map((absolute) => path.relative(this.vaultRealPath, absolute)), cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private prepareWrite(relative: string, content: string, previous?: string): string {
    const next = relative.toLowerCase().endsWith(".md")
      ? prepareAgentEdit(content, previous, this.config.autoAgentEditAt ?? true)
      : content;
    if (Buffer.byteLength(next, "utf8") > this.config.maxFileSizeBytes) throw new VaultError("Content exceeds configured file size limit.", { code: "FILE_TOO_LARGE" });
    return next;
  }

  private async withPathLock<T>(relative: string, callback: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.config.cacheDir);
    const lockDir = path.join(await fs.realpath(this.config.cacheDir), "locks");
    await ensurePrivateDirectory(lockDir);
    const target = path.join(lockDir, createHash("sha256").update(`${this.vaultRealPath}:${relative}`).digest("hex"));
    // proper-lockfile atomically creates `${target}.lock`; the target itself
    // need not exist. Avoid creating or following a predictable sentinel file.
    const release = await lockfile.lock(target, { retries: { retries: 20, minTimeout: 25, maxTimeout: 250 }, stale: 15_000, update: 5_000, realpath: false });
    try {
      await this.revalidateAuthorization();
      return await callback();
    } finally {
      await release();
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

function requireRevision(expected: string | undefined, actual: string): void {
  if (!expected) throw new VaultError("expected_revision is required when modifying an existing file.", { code: "CONFLICT", details: { actualRevision: actual } });
  if (expected !== actual) throw new VaultError("File changed since it was read.", { code: "CONFLICT", details: { expectedRevision: expected, actualRevision: actual } });
}

async function atomicWrite(destination: string, content: string, mode?: number, authorize?: () => Promise<void>): Promise<void> {
  await authorize?.();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // Stage on the destination filesystem, in a private directory. A shared
  // destination's permissions must not expose the staging file while writing.
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(destination), ".obsidian-vault-mcp-"));
  const temporary = path.join(temporaryDirectory, "note.tmp");
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      if (mode !== undefined) await handle.chmod(mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await authorize?.();
    await fs.rename(temporary, destination);
  } catch (error) {
    throw mapFsError(error, destination);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readExisting(absolute: string, maxFileSizeBytes: number): Promise<{ content: string; revision: string; mode: number; stat: Stats } | undefined> {
  try {
    // Opening before stat must not block on a FIFO substituted for a note.
    const handle = await fs.open(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new VaultError("Target is not a file.", { code: "INVALID_PATH" });
      if (stat.size > maxFileSizeBytes) throw new VaultError("File exceeds configured size limit.", { code: "FILE_TOO_LARGE" });
      const content = await readBounded(handle, maxFileSizeBytes);
      return { content, revision: revisionForContent(content), mode: stat.mode, stat };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    if (isCode(error, "EISDIR")) throw new VaultError("Target is not a file.", { code: "INVALID_PATH" });
    throw error;
  }
}

async function readBounded(handle: FileHandle, maxFileSizeBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxFileSizeBytes) {
    // Read at most one byte beyond the limit, even if the file grows after stat.
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxFileSizeBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
    total += bytesRead;
    if (total > maxFileSizeBytes) throw new VaultError("File exceeds configured size limit.", { code: "FILE_TOO_LARGE" });
    chunks.push(buffer.subarray(0, bytesRead));
  }
  throw new VaultError("File exceeds configured size limit.", { code: "FILE_TOO_LARGE" });
}

function revisionForContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function revisionForFile(absolute: string, maxFileSizeBytes: number): Promise<string> {
  const existing = await readExisting(absolute, maxFileSizeBytes);
  if (!existing) throw new VaultError("File does not exist.", { code: "NOT_FOUND" });
  return existing.revision;
}

async function exists(candidate: string): Promise<boolean> {
  try { await fs.lstat(candidate); return true; } catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

async function countFiles(directory: string, limit: number): Promise<number> {
  let count = 0;
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
      else count += 1;
      if (count > limit) throw new VaultError("Tree entry limit exceeded.", { code: "FILE_TOO_LARGE" });
    }
  };
  await walk(directory);
  return count;
}

function joinVaultPath(...segments: string[]): string {
  return segments.filter(Boolean).join("/").replace(/\\/gu, "/");
}

function contentTypeFor(relative: string): string {
  if (relative.toLowerCase().endsWith(".md")) return "text/markdown; charset=utf-8";
  if (relative.toLowerCase().endsWith(".canvas")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function mapFsError(error: unknown, target: string): VaultError {
  if (error instanceof VaultError) return error;
  if (isCode(error, "ENOENT")) return new VaultError(`Path does not exist: ${target}`, { code: "NOT_FOUND" });
  if (isCode(error, "EACCES") || isCode(error, "EPERM")) return new VaultError(`Access denied: ${target}`, { code: "ACCESS_DENIED" });
  return new VaultError(error instanceof Error ? error.message : "Filesystem operation failed.", { code: "TOOL_ERROR" });
}

export function defaultCacheDir(): string {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "obsidian-vault-mcp");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "obsidian-vault-mcp");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "obsidian-vault-mcp");
}
