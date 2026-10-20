import { z } from "zod";

export const patchOperationSchema = z.enum(["append", "prepend", "replace"]);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

export type BackendKind = "filesystem" | "local-rest";
export type IndexMode = "auto" | "scan" | "indexed";
export type WatchMode = "auto" | "on" | "off";

export type AppConfig = {
  backend: BackendKind;
  vaultPath?: string;
  readOnly: boolean;
  autoAgentEditAt?: boolean;
  readPaths: string[];
  writePaths: string[];
  indexMode: IndexMode;
  watchMode: WatchMode;
  cacheDir: string;
  maxFileSizeBytes: number;
  maxTreeEntries: number;
  maxSearchResults: number;
  obsidianApiKey?: string;
  obsidianBaseUrl?: string;
  obsidianVerifySsl: boolean;
  requestTimeoutMs: number;
  retryCount: number;
  mcpTransport: "stdio" | "http";
  colorfulLogs: boolean;
  mcpHttpHost: string;
  mcpHttpPort: number;
  mcpHttpPath: string;
  mcpAllowedHosts?: string[];
  mcpAuthToken?: string;
};

export type VaultErrorCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "READ_ONLY"
  | "ACCESS_DENIED"
  | "CONFLICT"
  | "UNSUPPORTED_CAPABILITY"
  | "INDEX_ERROR"
  | "INVALID_QUERY"
  | "INVALID_MARKDOWN"
  | "AMBIGUOUS_HEADING"
  | "HEADING_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "TOOL_ERROR"
  | "OBSIDIAN_HTTP_ERROR"
  | "OBSIDIAN_TIMEOUT"
  | "OBSIDIAN_UNREACHABLE"
  | "OBSIDIAN_INVALID_RESPONSE"
  | "OBSIDIAN_UNKNOWN_ERROR";

export class VaultError extends Error {
  public readonly code: string;
  public readonly status: number | undefined;
  public readonly details: unknown;

  public constructor(message: string, options: { code: string; status?: number; details?: unknown }) {
    super(message);
    this.name = "VaultError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

/** @deprecated Use VaultError. Kept for the Local REST compatibility adapter. */
export class ObsidianClientError extends VaultError {
  public constructor(message: string, options: { code: string; status?: number; details?: unknown }) {
    super(message, options);
    this.name = "ObsidianClientError";
  }
}

export const vaultPathSchema = z
  .string()
  .min(1, "path is required")
  .refine((value) => value.trim().length > 0, "path is required")
  .refine((value) => !isUnsafeVaultPathInput(value), "path must stay inside the vault");

export const optionalVaultPathSchema = z
  .string()
  .default("")
  .refine((value) => value === "" || !isUnsafeVaultPathInput(value), "path must stay inside the vault");

export function normalizeVaultPathInput(input: string): string {
  return input.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").trim();
}

function isUnsafeVaultPathInput(input: string): boolean {
  if (input.includes("\0") || /^[a-zA-Z]:[\\/]/u.test(input) || /^[/\\]{1,2}/u.test(input)) {
    return true;
  }
  return input.replace(/\\/gu, "/").split("/").some((segment) => segment === "..");
}

export type VaultEntry = {
  path: string;
  name: string;
  isFolder: boolean;
};

export type NoteMetadata = {
  path?: string;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  revision?: string;
};

export type NoteReadResult = NoteMetadata & { content: string };

export type SearchResult = {
  path: string;
  score?: number;
  snippet?: string;
};

export type NoteStat = {
  ctime?: number;
  mtime?: number;
  size?: number;
};

export type NoteJsonMetadata = {
  path: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  stat: NoteStat | null;
  content?: string;
  headings?: Array<{ text: string; level: number }>;
  links?: string[];
  revision?: string;
};
