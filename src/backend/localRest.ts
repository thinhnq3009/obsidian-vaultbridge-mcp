import type { AppConfig, PatchOperation } from "../types.js";
import { VaultError } from "../types.js";
import { LocalRestBackend as Client } from "../obsidian/client.js";
import type { BackendCapabilities, BackendStatus, NoteEdits, NoteEditsResult, SearchQuery, VaultBackend, WriteOptions } from "./types.js";

export class LocalRestBackend implements VaultBackend {
  public readonly capabilities: BackendCapabilities = { activeFile: true, openFile: true, searchIndex: false, filesystem: false };
  private readonly client: Client;

  public constructor(private readonly config: AppConfig) {
    this.client = new Client(config);
  }

  public async initialize(): Promise<void> { await this.client.checkConnection(); }
  public async close(): Promise<void> {}
  public status(): Promise<BackendStatus> {
    return Promise.resolve({ backend: "local-rest", vaultPath: null, readOnly: false, capabilities: this.capabilities, indexState: "disabled" });
  }
  public async health() {
    try { await this.client.checkConnection(); return { ok: true, checks: { localRest: "reachable" } }; }
    catch (error) { return { ok: false, checks: { localRest: error instanceof Error ? error.message : String(error) } }; }
  }
  public listFiles(path = "") { return this.client.listFiles(path); }
  public async statPath(path: string) {
    try {
      const metadata = await this.client.readNoteMetadata(path);
      return { path, exists: true, kind: "file" as const, size: metadata.stat?.size ?? null, ctime: metadata.stat?.ctime ?? null, mtime: metadata.stat?.mtime ?? null, revision: null };
    } catch (error) {
      if (isNotFound(error)) {
        try { await this.client.listFiles(path); return { path, exists: true, kind: "folder" as const, size: null, ctime: null, mtime: null, revision: null }; }
        catch (folderError) { if (isNotFound(folderError)) return { path, exists: false, kind: "missing" as const, size: null, ctime: null, mtime: null, revision: null }; throw folderError; }
      }
      throw error;
    }
  }
  public async readNote(path: string) {
    const note = await this.client.readNote(path);
    const revision = note.etag ?? note.lastModified;
    return revision ? { ...note, revision } : note;
  }
  public writeNote(path: string, content: string) { return this.client.writeNote(path, content); }
  public writeFile(path: string, content: string, options?: WriteOptions) { return this.client.writeFile(path, content, options?.contentType ? { contentType: options.contentType } : undefined); }
  public appendToNote(path: string, content: string) { return this.client.appendToNote(path, content); }
  public async deletePath(path: string, options?: { recursive?: boolean }) {
    const stat = await this.statPath(path);
    if (stat.kind === "folder" && options?.recursive) {
      for (const entry of (await this.client.listFiles(path)).entries) await this.deletePath(entry.path, { recursive: true });
    }
    await this.client.deletePath(path);
  }
  public createFolder(path: string): Promise<{ path: string; created: boolean }> {
    throw new VaultError(`Local REST backend cannot create empty folder: ${path}`, { code: "UNSUPPORTED_CAPABILITY" });
  }
  public async movePath(sourcePath: string, destinationPath: string, options?: { overwrite?: boolean; expectedDestinationRevision?: string }) {
    const stat = await this.statPath(sourcePath);
    if (!stat.exists) throw new VaultError(`Source path does not exist: ${sourcePath}`, { code: "NOT_FOUND" });
    if (stat.kind !== "file") throw new VaultError("Local REST migration backend only supports file moves.", { code: "UNSUPPORTED_CAPABILITY" });
    const destination = await this.statPath(destinationPath);
    if (destination.exists && !options?.overwrite) throw new VaultError(`Destination already exists: ${destinationPath}`, { code: "ALREADY_EXISTS" });
    if (destination.exists && options?.overwrite && !options.expectedDestinationRevision) throw new VaultError("expected_destination_revision is required when overwriting a destination.", { code: "CONFLICT" });
    const note = await this.client.readNote(sourcePath);
    await this.client.writeFile(destinationPath, note.content);
    await this.client.deletePath(sourcePath);
    return { sourcePath, destinationPath, kind: "file" as const, movedFiles: 1 };
  }
  public readNoteMetadata(path: string) { return this.client.readNoteMetadata(path); }
  public applyNoteEdits(_path: string, _expectedRevision: string, _edits: NoteEdits): Promise<NoteEditsResult> {
    return Promise.reject(new VaultError("Atomic multi-edit is unsupported on the Local REST backend.", { code: "UNSUPPORTED_CAPABILITY" }));
  }
  public async patchHeading(path: string, heading: string, content: string, operation: PatchOperation) {
    const result = await this.client.patchHeading(path, heading, content, operation);
    return result;
  }
  public async patchFrontmatter(path: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean) {
    const result = await this.client.patchFrontmatter(path, field, value, operation, createIfMissing);
    return result;
  }
  public async search(query: SearchQuery) {
    if (query.folder || query.tag || query.regex || query.frontmatter) {
      const expression = buildJsonLogic(query);
      return this.client.searchAdvanced(expression, query.limit);
    }
    const result = await this.client.search(query.query ?? "", query.limit);
    return { results: result.results };
  }
  public rebuildSearchIndex(): Promise<{ indexedFiles: number; mode: string }> {
    throw new VaultError("Local REST backend controls its own search index.", { code: "UNSUPPORTED_CAPABILITY" });
  }
  public getActiveFile() { return this.client.getActiveFile(); }
  public openFile(path: string) { return this.client.openFile(path); }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 404);
}

function buildJsonLogic(query: SearchQuery): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  if (query.query) clauses.push({ regexp: [escapeRegex(query.query), { var: "content" }] });
  if (query.regex) clauses.push({ regexp: [query.regex, { var: "content" }] });
  if (query.folder) clauses.push({ regexp: [`^${escapeRegex(query.folder)}(?:/|$)`, { var: "path" }] });
  if (query.tag) clauses.push({ in: [query.tag.replace(/^#/u, ""), { var: "tags" }] });
  return clauses.length === 0 ? { "!==": [{ var: "path" }, null] } : { and: clauses };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
