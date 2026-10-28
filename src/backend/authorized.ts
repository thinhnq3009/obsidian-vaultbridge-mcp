import { AsyncLocalStorage } from "node:async_hooks";

import { OperationAuthorization } from "../auth/authorization.js";
import type { GrantReader, PathAction } from "../auth/grants.js";
import { pathActions } from "../auth/grants.js";
import type { AuthContext, OAuthContext } from "../auth/requestContext.js";
import { assertTrustedContext, authorizationDenied } from "../auth/requestContext.js";
import type { PatchOperation } from "../types.js";
import { VaultError } from "../types.js";
import { FilesystemVaultBackend } from "./filesystem.js";
import type { BackendStatus, NoteEdits, NoteEditsResult, SearchQuery, VaultBackend, WriteOptions } from "./types.js";

export type RequestBackendOptions = {
  context: AuthContext;
  grants: GrantReader;
  vaultId: string;
  resource: string;
  audit?: (event: Readonly<{ action: PathAction; allowed: boolean }>) => void;
};

/** Not wired to HTTP in Phase A. Caller must choose mode from trusted configuration. */
export function createRequestBackend(backend: VaultBackend, options: RequestBackendOptions): VaultBackend {
  if (!["oauth", "token", "none", "stdio"].includes(options.context.mode)) throw authorizationDenied();
  if (options.context.mode !== "oauth") return backend;
  assertTrustedContext(options.context);
  // No remote canonical/symlink proof is available. Do not probe the REST API.
  if (!(backend instanceof FilesystemVaultBackend)) throw authorizationDenied();
  return new AuthorizedVaultBackend(backend, options.context, Object.freeze({ ...options }));
}

/** All VaultBackend entry points are explicit; future additions must typecheck here. */
class AuthorizedVaultBackend implements VaultBackend {
  public readonly requestScoped = true;
  public readonly capabilities = Object.freeze({ activeFile: false, openFile: false, searchIndex: false, filesystem: true });
  // Tool identity is process-owned, established by registerTool, never tool input.
  private readonly tool = new AsyncLocalStorage<string>();
  public constructor(private readonly backend: FilesystemVaultBackend, private readonly context: OAuthContext, private readonly options: RequestBackendOptions) {}

  public async runWithTool<T>(name: string, callback: () => Promise<T>): Promise<T> {
    // Admission also covers tool-level no-ops (e.g. rename to the same name).
    // Actual backend calls still enforce their exact action and paths.
    const permitted = pathActions.some((action) => {
      try {
        new OperationAuthorization(this.context, this.options.grants, this.options.vaultId, this.options.resource, name, action);
        return true;
      } catch { return false; }
    });
    if (!permitted) throw authorizationDenied();
    return this.tool.run(name, callback);
  }

  private async invoke<T>(action: PathAction, execute: (backend: FilesystemVaultBackend) => Promise<T>): Promise<T> {
    let allowed = false;
    try {
      const authorization = new OperationAuthorization(this.context, this.options.grants, this.options.vaultId, this.options.resource, this.tool.getStore() ?? "", action);
      const result = await execute(this.backend.withAuthorization(authorization));
      authorization.assertActive();
      allowed = true;
      return result;
    } catch (error) {
      // Never expose filesystem paths, cached bodies, token claims, raw adapter
      // failures, or revisions in details from a denied/failed operation.
      const code = error instanceof VaultError ? error.code : "TOOL_ERROR";
      const safeCode = ["CONFLICT", "READ_ONLY", "INVALID_QUERY", "UNSUPPORTED_CAPABILITY", "INDEX_ERROR", "NOT_FOUND", "ALREADY_EXISTS", "FILE_TOO_LARGE"].includes(code) ? code : "ACCESS_DENIED";
      throw new VaultError(safeCode === "ACCESS_DENIED" ? "Request authorization denied." : "Authorized vault operation failed.", { code: safeCode });
    } finally {
      // Optional owner-side audit sink sees only fixed action + outcome.
      try { this.options.audit?.(Object.freeze({ action, allowed })); } catch { /* Audit must not expose sink errors to clients. */ }
    }
  }

  // Scoped callers cannot manage shared lifecycle, observe vault-wide metadata,
  // enumerate the active note before authorizing it, or rebuild a shared index.
  public initialize(): Promise<void> { return Promise.reject(authorizationDenied()); }
  public close(): Promise<void> { return Promise.reject(authorizationDenied()); }
  public status(): Promise<BackendStatus> { return Promise.reject(authorizationDenied()); }
  public health(): ReturnType<VaultBackend["health"]> { return Promise.reject(authorizationDenied()); }
  public rebuildSearchIndex(): ReturnType<VaultBackend["rebuildSearchIndex"]> { return Promise.reject(authorizationDenied()); }
  public getActiveFile(): ReturnType<NonNullable<VaultBackend["getActiveFile"]>> { return Promise.reject(authorizationDenied()); }
  public openFile(_path: string): ReturnType<NonNullable<VaultBackend["openFile"]>> { void _path; return Promise.reject(authorizationDenied()); }

  public listFiles(path = "") { return this.invoke("listFiles", (backend) => backend.listFiles(path)); }
  public statPath(path: string) { return this.invoke("statPath", (backend) => backend.statPath(path)); }
  public readNote(path: string) { return this.invoke("readNote", (backend) => backend.readNote(path)); }
  public readNoteMetadata(path: string) { return this.invoke("readNoteMetadata", (backend) => backend.readNoteMetadata(path)); }
  public writeNote(path: string, content: string, options?: WriteOptions) { return this.invoke("writeNote", (backend) => backend.writeNote(path, content, options)); }
  public writeFile(path: string, content: string, options?: WriteOptions) { return this.invoke("writeFile", (backend) => backend.writeFile(path, content, options)); }
  public preflightWriteNotes(paths: readonly string[]) { return this.invoke("writeNote", (backend) => backend.preflightWriteNotes(paths)); }
  public appendToNote(path: string, content: string, expectedRevision?: string) { return this.invoke("appendToNote", (backend) => backend.appendToNote(path, content, expectedRevision)); }
  public createFolder(path: string) { return this.invoke("createFolder", (backend) => backend.createFolder(path)); }
  public deletePath(path: string, options?: Parameters<VaultBackend["deletePath"]>[1]) { return this.invoke("deletePath", (backend) => backend.deletePath(path, options)); }
  public movePath(source: string, destination: string, options?: Parameters<VaultBackend["movePath"]>[2]) { return this.invoke("movePath", (backend) => backend.movePath(source, destination, options)); }
  public applyNoteEdits(path: string, expectedRevision: string, edits: NoteEdits): Promise<NoteEditsResult> { return this.invoke("applyNoteEdits", (backend) => backend.applyNoteEdits(path, expectedRevision, edits)); }
  public patchHeading(path: string, heading: string, content: string, operation: PatchOperation, options?: Parameters<VaultBackend["patchHeading"]>[4]) { return this.invoke("patchHeading", (backend) => backend.patchHeading(path, heading, content, operation, options)); }
  public patchFrontmatter(path: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean, expectedRevision?: string) { return this.invoke("patchFrontmatter", (backend) => backend.patchFrontmatter(path, field, value, operation, createIfMissing, expectedRevision)); }
  public search(query: SearchQuery) {
    return this.invoke("search", (backend) => {
      // Explicit denied folders fail generically, never enumerate their contents.
      if (query.folder) {
        const authorization = new OperationAuthorization(this.context, this.options.grants, this.options.vaultId, this.options.resource, this.tool.getStore() ?? "", "search");
        authorization.assertPath(query.folder);
      }
      return backend.search(query);
    });
  }
}
