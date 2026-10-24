import type { AppConfig, PatchOperation } from "../types.js";
import { VaultError } from "../types.js";
import { LocalRestBackend as Client } from "../obsidian/client.js";
import { VaultAccessPolicy } from "./accessPolicy.js";
import type { BackendCapabilities, BackendStatus, NoteEditsResult, SearchQuery, VaultBackend, WriteOptions } from "./types.js";

export class LocalRestBackend implements VaultBackend {
  public readonly capabilities: BackendCapabilities = { activeFile: false, openFile: true, searchIndex: false, filesystem: false };
  private readonly client: Client;
  private readonly policy: VaultAccessPolicy;
  public constructor(private readonly config: AppConfig) {
    this.client = new Client(config);
    this.policy = new VaultAccessPolicy("", config.readOnly, config.readPaths, config.writePaths);
  }
  public async initialize(): Promise<void> { await this.client.checkConnection(); }
  public async close(): Promise<void> {}
  public status(): Promise<BackendStatus> {
    return Promise.resolve({ backend: "local-rest", vaultPath: null, readOnly: this.config.readOnly, capabilities: this.capabilities, indexState: "disabled" });
  }
  public async health() {
    try { await this.client.checkConnection(); return { ok: true, checks: { localRest: "reachable" } }; }
    catch (error) { return { ok: false, checks: { localRest: error instanceof Error ? error.message : String(error) } }; }
  }
  public async listFiles(input = "") {
    const relative = this.policy.authorize(input, "read");
    const result = await this.client.listFiles(relative);
    return { root: relative, entries: result.entries.flatMap((entry) => {
      try {
        const target = this.policy.authorize(entry.path, "read");
        if (relative && !target.startsWith(`${relative}/`)) return [];
        return [{ ...entry, path: target }];
      } catch { return []; }
    }) };
  }
  public async statPath(input: string) {
    const path = this.policy.authorize(input, "read");
    try {
      const metadata = await this.readNoteMetadata(path);
      return { path, exists: true, kind: "file" as const, size: metadata.stat?.size ?? null, ctime: metadata.stat?.ctime ?? null, mtime: metadata.stat?.mtime ?? null, revision: null };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try { await this.listFiles(path); return { path, exists: true, kind: "folder" as const, size: null, ctime: null, mtime: null, revision: null }; }
      catch (folderError) { if (!isNotFound(folderError)) throw folderError; return { path, exists: false, kind: "missing" as const, size: null, ctime: null, mtime: null, revision: null }; }
    }
  }
  public async readNote(input: string) {
    const path = this.policy.authorize(input, "read");
    const note = await this.client.readNote(path);
    if (note.path) this.policy.authorize(note.path, "read");
    const revision = note.etag ?? note.lastModified;
    return { ...note, path, ...(revision ? { revision } : {}) };
  }
  public async writeNote(input: string, content: string, options?: WriteOptions) {
    const path = this.writable(input); this.requireLegacyWrite(options);
    return this.client.writeNote(path, content);
  }
  public async writeFile(input: string, content: string, options?: WriteOptions) {
    const path = this.writable(input); this.requireLegacyWrite(options);
    return this.client.writeFile(path, content, options?.contentType ? { contentType: options.contentType } : undefined);
  }
  public async appendToNote(input: string, content: string, expectedRevision?: string) {
    const path = this.writable(input); if (expectedRevision !== undefined) throw unsupported("revision-checked appends");
    return this.client.appendToNote(path, content);
  }
  public async deletePath(input: string, options?: { recursive?: boolean; expectedRevision?: string }) {
    const path = this.writable(input);
    if (options?.recursive || options?.expectedRevision !== undefined) throw unsupported("recursive or revision-checked deletion");
    if ((await this.statPath(path)).kind !== "file") throw unsupported("folder deletion");
    await this.client.deletePath(path);
  }
  public async createFolder(input: string): Promise<{ path: string; created: boolean }> { this.writable(input); throw unsupported("empty folders"); }
  public async movePath(sourcePath: string, destinationPath: string): Promise<{ sourcePath: string; destinationPath: string; kind: "file"; movedFiles: number }> {
    this.writable(sourcePath); this.writable(destinationPath); throw unsupported("atomic or revision-checked moves");
  }
  public async readNoteMetadata(input: string) {
    const path = this.policy.authorize(input, "read");
    const metadata = await this.client.readNoteMetadata(path);
    this.policy.authorize(metadata.path, "read");
    return { ...metadata, path };
  }
  public async applyNoteEdits(input: string): Promise<NoteEditsResult> { this.writable(input); throw unsupported("atomic multi-edit"); }
  public async patchHeading(input: string, heading: string, content: string, operation: PatchOperation, options?: { occurrence?: number; expectedRevision?: string }) {
    const path = this.writable(input);
    if (options?.expectedRevision !== undefined || options?.occurrence !== undefined) throw unsupported("revision/occurrence-checked patches");
    return this.client.patchHeading(path, heading, content, operation);
  }
  public async patchFrontmatter(input: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean, expectedRevision?: string) {
    const path = this.writable(input); if (expectedRevision !== undefined) throw unsupported("revision-checked patches");
    return this.client.patchFrontmatter(path, field, value, operation, createIfMissing);
  }
  public async search(_query: SearchQuery): Promise<Awaited<ReturnType<VaultBackend["search"]>>> { throw unsupported("ACL-safe remote search"); }
  public async rebuildSearchIndex(): Promise<{ indexedFiles: number; mode: string }> { throw unsupported("index rebuilds"); }
  public async getActiveFile(): Promise<Awaited<ReturnType<Client["getActiveFile"]>>> { throw unsupported("authorizing the active file before reading its body"); }
  public async openFile(input: string) { return this.client.openFile(this.policy.authorize(input, "read")); }
  private writable(input: string): string { return this.policy.authorize(input, "write"); }
  private requireLegacyWrite(options?: WriteOptions): void {
    if (options?.mode !== undefined || options?.expectedRevision !== undefined) throw unsupported("create/replace or revision-checked writes");
  }
}
function unsupported(operation: string): VaultError { return new VaultError(`Local REST cannot guarantee ${operation}; use the filesystem backend.`, { code: "UNSUPPORTED_CAPABILITY" }); }
function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 404);
}
