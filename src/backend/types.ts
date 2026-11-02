import type {
  NoteJsonMetadata,
  NoteReadResult,
  PatchOperation,
  SearchResult,
  VaultEntry,
} from "../types.js";

export type BackendCapabilities = {
  activeFile: boolean;
  openFile: boolean;
  searchIndex: boolean;
  filesystem: boolean;
};

export type WriteOptions = {
  mode?: "create" | "replace";
  expectedRevision?: string;
  contentType?: string;
};

export type FrontmatterNoteEdit = { field: string; value: unknown; operation: PatchOperation; createIfMissing: boolean };
export type SectionNoteEdit = { heading: string; content: string; operation: PatchOperation; occurrence?: number };
export type NoteEdits = { frontmatter: FrontmatterNoteEdit[]; sections: SectionNoteEdit[] };
export type NoteEditsResult = { path: string; message: string; revision: string; frontmatterEdits: number; sectionEdits: number; changed: boolean };

export type MutationResult = {
  path: string;
  message: string;
  revision?: string;
};

export type PathStat = {
  path: string;
  exists: boolean;
  kind: "file" | "folder" | "missing";
  size: number | null;
  ctime: number | null;
  mtime: number | null;
  revision: string | null;
};

export type SearchQuery = {
  /** Internal qualification mode used by advanced search; simple search keeps mode-specific ranking. */
  match?: "exact";
  query?: string;
  folder?: string;
  tag?: string;
  regex?: string;
  caseSensitive?: boolean;
  frontmatter?: Record<string, unknown>;
  limit: number;
  cursor?: string;
  sort?: "relevance" | "path";
};

export type SearchResponse = {
  results: SearchResult[];
  nextCursor?: string;
};

export type BackendStatus = {
  backend: "filesystem" | "local-rest";
  vaultPath: string | null;
  readOnly: boolean;
  capabilities: BackendCapabilities;
  indexState: "disabled" | "scan" | "ready" | "building" | "degraded";
  indexError?: string;
};

export interface VaultBackend {
  readonly capabilities: BackendCapabilities;
  readonly requestScoped?: boolean;
  runWithTool?<T>(name: string, callback: () => Promise<T>): Promise<T>;
  preflightWriteNotes?(paths: readonly string[]): Promise<void>;
  initialize(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<BackendStatus>;
  health(): Promise<{ ok: boolean; checks: Record<string, string> }>;
  listFiles(path?: string): Promise<{ entries: VaultEntry[]; root: string }>;
  statPath(path: string): Promise<PathStat>;
  readNote(path: string): Promise<NoteReadResult>;
  writeNote(path: string, content: string, options?: WriteOptions): Promise<MutationResult>;
  writeFile(path: string, content: string, options?: WriteOptions): Promise<MutationResult>;
  appendToNote(path: string, content: string, expectedRevision?: string): Promise<MutationResult>;
  deletePath(path: string, options?: { recursive?: boolean; expectedRevision?: string }): Promise<void>;
  createFolder(path: string): Promise<{ path: string; created: boolean }>;
  movePath(sourcePath: string, destinationPath: string, options?: { overwrite?: boolean; expectedRevision?: string; expectedDestinationRevision?: string }): Promise<{ sourcePath: string; destinationPath: string; kind: "file" | "folder"; movedFiles: number }>;
  readNoteMetadata(path: string): Promise<NoteJsonMetadata>;
  applyNoteEdits(path: string, expectedRevision: string, edits: NoteEdits): Promise<NoteEditsResult>;
  patchHeading(path: string, heading: string, content: string, operation: PatchOperation, options?: { occurrence?: number; expectedRevision?: string }): Promise<MutationResult & { heading: string; operation: PatchOperation }>;
  patchFrontmatter(path: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean, expectedRevision?: string): Promise<MutationResult & { field: string; operation: PatchOperation }>;
  search(query: SearchQuery): Promise<SearchResponse>;
  rebuildSearchIndex(): Promise<{ indexedFiles: number; mode: string }>;
  getActiveFile?(): Promise<NoteReadResult>;
  openFile?(path: string): Promise<{ path: string; message: string }>;
}
