import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { defaultCacheDir } from "./backend/filesystem.js";
import type { AppConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://127.0.0.1:27124";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_MCP_HTTP_PORT = 39145;

const booleanString = (fallback: boolean) => z.preprocess(
  (value) => value ?? String(fallback),
  z.string().trim().toLowerCase().refine((value) => ["true", "false", "1", "0", "yes", "no"].includes(value), "must be a boolean string").transform((value) => ["true", "1", "yes"].includes(value)),
);

const envSchema = z.object({
  BACKEND: z.preprocess((value) => value ?? "filesystem", z.enum(["filesystem", "local-rest"])),
  VAULT_PATH: z.string().trim().optional(),
  READ_ONLY: booleanString(false),
  AUTO_AGENT_EDIT_AT: booleanString(true),
  READ_PATHS: z.string().optional(),
  WRITE_PATHS: z.string().optional(),
  INDEX_MODE: z.preprocess((value) => value ?? "auto", z.enum(["auto", "scan", "indexed"])),
  WATCH_MODE: z.preprocess((value) => value ?? "auto", z.enum(["auto", "on", "off"])),
  CACHE_DIR: z.preprocess((value) => value ?? defaultCacheDir(), z.string().trim().min(1)),
  MAX_FILE_SIZE_BYTES: z.preprocess((value) => value ?? 10 * 1024 * 1024, z.coerce.number().int().positive()),
  MAX_TREE_ENTRIES: z.preprocess((value) => value ?? 10_000, z.coerce.number().int().positive()),
  MAX_SEARCH_RESULTS: z.preprocess((value) => value ?? 100, z.coerce.number().int().min(1).max(1000)),
  OBSIDIAN_API_KEY: z.string().trim().optional(),
  OBSIDIAN_BASE_URL: z.preprocess((value) => value ?? DEFAULT_BASE_URL, z.url()),
  OBSIDIAN_VERIFY_SSL: booleanString(false),
  MCP_TRANSPORT: z.preprocess((value) => value ?? "stdio", z.enum(["stdio", "http"])),
  COLORFUL_LOGS: booleanString(false),
  MCP_HTTP_HOST: z.preprocess((value) => value ?? "127.0.0.1", z.string().trim().min(1)),
  MCP_HTTP_PORT: z.preprocess((value) => value ?? DEFAULT_MCP_HTTP_PORT, z.coerce.number().int().min(1).max(65_535)),
  MCP_HTTP_PATH: z.preprocess((value) => value ?? "/mcp", z.string().trim().min(1).refine((value) => value.startsWith("/"), "MCP_HTTP_PATH must start with /")),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_HTTP_TLS_PROXY: booleanString(false),
  MCP_AUTH_TOKEN: z.string().trim().optional(),
  MCP_AUTH_MODE: z.enum(["oauth", "token", "none"]).optional(),
  MCP_OAUTH_ENABLED: booleanString(false),
  MCP_OAUTH_ISSUER: z.url().optional(),
  MCP_AUTH_DIRECTORY: z.string().trim().min(1).optional(),
  MCP_VAULT_ID: z.string().trim().min(1).max(512).optional(),
  MCP_OWNER_PORT: z.coerce.number().int().min(1).max(65535).default(39146),
  MCP_OWNER_USERNAME: z.string().optional(),
  MCP_OWNER_PASSWORD: z.string().optional(),
  MCP_ALLOW_UNAUTHENTICATED_NETWORK: booleanString(false),
  MCP_RATE_LIMIT_RPM: z.coerce.number().int().min(1).max(100000).default(1200),
  MCP_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(10000).default(120),
  MCP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(128).default(32),
  MCP_AUTHENTICATED_CLIENT_RPM: z.coerce.number().int().min(1).max(100000).default(600),
  MCP_UNAUTHENTICATED_ATTEMPT_RPM: z.coerce.number().int().min(1).max(1000).default(60),
  MCP_OAUTH_ENDPOINT_RPM: z.coerce.number().int().min(1).max(1000).default(60),
});

type CliOverrides = Record<string, string | undefined>;
type VaultCandidate = { path: string; open: boolean };
type ObsidianRegistry = { vaults?: Record<string, { path?: unknown; open?: unknown }> };

export function loadConfig(source: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): AppConfig {
  const parsedArgs = parseCliArgs(argv);
  const merged: Record<string, string | undefined> = {
    ...(source === process.env ? loadDotEnvFile() : {}),
    ...source,
    ...parsedArgs,
  };
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const data = parsed.data;
  const vaultPath = data.BACKEND === "filesystem" ? resolveFilesystemVaultPath(data.VAULT_PATH, merged) : data.VAULT_PATH;
  if (data.BACKEND === "filesystem" && !vaultPath) throw new Error("Invalid filesystem configuration: VAULT_PATH is required and no Obsidian vault could be auto-detected. Pass --vault or set VAULT_PATH.");
  if (data.BACKEND === "local-rest" && !data.OBSIDIAN_API_KEY) throw new Error("Invalid Local REST configuration: OBSIDIAN_API_KEY is required");
  if (!isLoopbackHost(data.MCP_HTTP_HOST) && !data.MCP_AUTH_TOKEN && data.MCP_AUTH_MODE !== "oauth"
    && !(data.MCP_AUTH_MODE === "none" && data.MCP_ALLOW_UNAUTHENTICATED_NETWORK)) throw new Error("MCP_AUTH_TOKEN is required when MCP_HTTP_HOST is not loopback, unless an explicit safe alternative mode is configured");

  const config: AppConfig = {
    backend: data.BACKEND,
    ...(vaultPath ? { vaultPath: path.resolve(vaultPath) } : {}),
    readOnly: data.READ_ONLY,
    autoAgentEditAt: data.AUTO_AGENT_EDIT_AT,
    readPaths: splitList(data.READ_PATHS),
    writePaths: splitList(data.WRITE_PATHS),
    indexMode: data.INDEX_MODE,
    watchMode: data.WATCH_MODE,
    cacheDir: path.resolve(data.CACHE_DIR),
    maxFileSizeBytes: data.MAX_FILE_SIZE_BYTES,
    maxTreeEntries: data.MAX_TREE_ENTRIES,
    maxSearchResults: data.MAX_SEARCH_RESULTS,
    ...(data.OBSIDIAN_API_KEY ? { obsidianApiKey: data.OBSIDIAN_API_KEY } : {}),
    obsidianBaseUrl: data.OBSIDIAN_BASE_URL.replace(/\/+$/u, ""),
    obsidianVerifySsl: data.OBSIDIAN_VERIFY_SSL,
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
    retryCount: DEFAULT_RETRY_COUNT,
    mcpTransport: data.MCP_TRANSPORT,
    colorfulLogs: data.COLORFUL_LOGS,
    mcpHttpHost: data.MCP_HTTP_HOST,
    mcpHttpTlsProxy: data.MCP_HTTP_TLS_PROXY,
    mcpHttpPort: data.MCP_HTTP_PORT,
    mcpHttpPath: data.MCP_HTTP_PATH.replace(/\/+$/u, "") || "/",
    ...(splitList(data.MCP_ALLOWED_HOSTS).length > 0 ? { mcpAllowedHosts: splitList(data.MCP_ALLOWED_HOSTS) } : {}),
    ...(data.MCP_AUTH_TOKEN ? { mcpAuthToken: data.MCP_AUTH_TOKEN } : {}),
    ...(data.MCP_AUTH_MODE ? { mcpAuthMode: data.MCP_AUTH_MODE } : {}),
    mcpOauthEnabled: data.MCP_OAUTH_ENABLED,
    ...(data.MCP_OAUTH_ISSUER ? { mcpOauthIssuer: data.MCP_OAUTH_ISSUER } : {}),
    ...(data.MCP_AUTH_DIRECTORY ? { mcpAuthDirectory: path.resolve(data.MCP_AUTH_DIRECTORY) } : {}),
    ...(data.MCP_VAULT_ID ? { mcpVaultId: data.MCP_VAULT_ID } : {}),
    mcpOwnerPort: data.MCP_OWNER_PORT,
    ...(data.MCP_OWNER_USERNAME !== undefined ? { mcpOwnerUsername: data.MCP_OWNER_USERNAME } : {}),
    ...(data.MCP_OWNER_PASSWORD !== undefined ? { mcpOwnerPassword: data.MCP_OWNER_PASSWORD } : {}),
    mcpAllowUnauthenticatedNetwork: data.MCP_ALLOW_UNAUTHENTICATED_NETWORK,
    mcpRateLimitRpm: data.MCP_RATE_LIMIT_RPM,
    mcpRateLimitBurst: data.MCP_RATE_LIMIT_BURST,
    mcpMaxConcurrent: data.MCP_MAX_CONCURRENT,
    mcpAuthenticatedClientRpm: data.MCP_AUTHENTICATED_CLIENT_RPM,
    mcpUnauthenticatedAttemptRpm: data.MCP_UNAUTHENTICATED_ATTEMPT_RPM,
    mcpOauthEndpointRpm: data.MCP_OAUTH_ENDPOINT_RPM,
  };
  if (config.mcpTransport === "http") validateHttpDeployment(config);
  return config;
}

function resolveFilesystemVaultPath(configuredPath: string | undefined, environment: Record<string, string | undefined>): string | undefined {
  if (configuredPath) return configuredPath;
  const registryCandidates = readObsidianRegistryCandidates(environment);
  const openCandidates = registryCandidates.filter((candidate) => candidate.open);
  if (openCandidates.length === 1) return openCandidates[0]?.path;
  if (openCandidates.length > 1) throw new Error("Invalid filesystem configuration: multiple open Obsidian vaults were auto-detected. Pass --vault or set VAULT_PATH.");
  if (registryCandidates.length === 1) return registryCandidates[0]?.path;
  if (registryCandidates.length > 1) throw new Error("Invalid filesystem configuration: multiple Obsidian vaults were auto-detected. Pass --vault or set VAULT_PATH.");

  const currentDirectory = process.cwd();
  return isValidVaultPath(currentDirectory) ? currentDirectory : undefined;
}

function readObsidianRegistryCandidates(environment: Record<string, string | undefined>): VaultCandidate[] {
  const registryPath = obsidianRegistryPath(environment);
  if (!registryPath || !fs.existsSync(registryPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }
  if (!isObsidianRegistry(parsed) || !parsed.vaults) return [];
  return Object.values(parsed.vaults)
    .map((vault): VaultCandidate | undefined => {
      if (typeof vault.path !== "string" || vault.path.trim() === "") return undefined;
      const candidate = path.resolve(vault.path);
      if (!isValidVaultPath(candidate)) return undefined;
      return { path: candidate, open: vault.open === true };
    })
    .filter((candidate): candidate is VaultCandidate => candidate !== undefined);
}

function obsidianRegistryPath(environment: Record<string, string | undefined>): string | undefined {
  if (process.platform === "win32") {
    const appData = environment.APPDATA;
    return appData ? path.join(appData, "obsidian", "obsidian.json") : undefined;
  }
  if (process.platform === "darwin") {
    const home = environment.HOME;
    return home ? path.join(home, "Library", "Application Support", "obsidian", "obsidian.json") : undefined;
  }
  const configHome = environment.XDG_CONFIG_HOME ?? (environment.HOME ? path.join(environment.HOME, ".config") : undefined);
  return configHome ? path.join(configHome, "obsidian", "obsidian.json") : undefined;
}

function isObsidianRegistry(value: unknown): value is ObsidianRegistry {
  return Boolean(value && typeof value === "object" && ("vaults" in value));
}

function isValidVaultPath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory() && fs.statSync(path.join(candidate, ".obsidian")).isDirectory();
  } catch {
    return false;
  }
}

export function parseCliArgs(argv: string[]): CliOverrides {
  const overrides: CliOverrides = {};
  const mapping: Record<string, string> = {
    backend: "BACKEND", vault: "VAULT_PATH", "read-only": "READ_ONLY", "read-path": "READ_PATHS", "write-path": "WRITE_PATHS",
    "auto-agent-edit-at": "AUTO_AGENT_EDIT_AT",
    "index-mode": "INDEX_MODE", "watch-mode": "WATCH_MODE", "cache-dir": "CACHE_DIR", transport: "MCP_TRANSPORT", host: "MCP_HTTP_HOST",
    port: "MCP_HTTP_PORT", path: "MCP_HTTP_PATH", "auth-token": "MCP_AUTH_TOKEN", "api-key": "OBSIDIAN_API_KEY", "base-url": "OBSIDIAN_BASE_URL", "verify-ssl": "OBSIDIAN_VERIFY_SSL",
    "auth-mode": "MCP_AUTH_MODE", "oauth-enabled": "MCP_OAUTH_ENABLED", "oauth-issuer": "MCP_OAUTH_ISSUER",
    "auth-directory": "MCP_AUTH_DIRECTORY", "vault-id": "MCP_VAULT_ID", "owner-port": "MCP_OWNER_PORT",
    "allow-unauthenticated-network": "MCP_ALLOW_UNAUTHENTICATED_NETWORK",
    "mcp-rpm": "MCP_RATE_LIMIT_RPM", "mcp-burst": "MCP_RATE_LIMIT_BURST",
    "mcp-max-concurrent": "MCP_MAX_CONCURRENT", "authenticated-client-rpm": "MCP_AUTHENTICATED_CLIENT_RPM",
    "unauthenticated-attempt-rpm": "MCP_UNAUTHENTICATED_ATTEMPT_RPM",
    "oauth-endpoint-rpm": "MCP_OAUTH_ENDPOINT_RPM",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    if (argument === "--http" || argument === "--stdio") { overrides.MCP_TRANSPORT = argument.slice(2); continue; }
    if (argument === "--read-only") { overrides.READ_ONLY = "true"; continue; }
    if (argument === "--colorful") { overrides.COLORFUL_LOGS = "true"; continue; }
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const candidate = inlineValue ?? argv[index + 1];
    const value = inlineValue ?? (candidate && !candidate.startsWith("--") ? candidate : undefined);
    if (inlineValue === undefined && value !== undefined) index += 1;
    const key = rawKey ? mapping[rawKey] : undefined;
    if (!key || value === undefined) continue;
    if ((key === "READ_PATHS" || key === "WRITE_PATHS") && overrides[key]) overrides[key] = `${overrides[key]},${value}`;
    else overrides[key] = value;
  }
  return overrides;
}

export function loadDotEnvFile(): Record<string, string> {
  const filePath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
  }
  return result;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")).filter(Boolean) ?? [];
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function validateHttpDeployment(config: AppConfig): void {
  const mode = httpAuthMode(config);
  if ((mode !== "token" && config.mcpAuthToken) || (mode === "token" && !config.mcpAuthToken)) throw new Error("MCP_AUTH_TOKEN is required only in token mode; authentication modes cannot be combined.");
  if (mode === "oauth") {
    if (!config.mcpOauthEnabled) throw new Error("OAuth is default-off pending #60; explicitly set MCP_OAUTH_ENABLED=true for experimental use.");
    if (!config.vaultPath || config.backend !== "filesystem" || !config.mcpVaultId) throw new Error("OAuth requires a filesystem vault and explicit MCP_VAULT_ID.");
    const issuer = new URL(config.mcpOauthIssuer ?? "invalid:");
    if (!["https:", "http:"].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash
      || issuer.pathname !== "/api/auth" || issuer.href !== config.mcpOauthIssuer
      || (issuer.protocol !== "https:" && !isLoopbackHost(issuer.hostname))) throw new Error("OAuth requires a canonical HTTPS MCP_OAUTH_ISSUER ending in /api/auth (HTTP loopback only).");
    if (!config.mcpAllowedHosts?.includes(issuer.hostname)) throw new Error("OAuth issuer host must be in MCP_ALLOWED_HOSTS.");
    if (["/", "/api", "/api/auth", "/.well-known"].some((prefix) => config.mcpHttpPath === prefix)
      || config.mcpHttpPath.startsWith("/api/auth/") || config.mcpHttpPath.startsWith("/.well-known/")) throw new Error("MCP path overlaps OAuth endpoints.");
  }
  if (!isLoopbackHost(config.mcpHttpHost)) {
    if (!config.mcpHttpTlsProxy) throw new Error("Network HTTP requires TLS termination at a trusted proxy and MCP_HTTP_TLS_PROXY=true.");
    if (mode === "none" && !config.mcpAllowUnauthenticatedNetwork) throw new Error("Network HTTP requires MCP_AUTH_TOKEN or explicit MCP_ALLOW_UNAUTHENTICATED_NETWORK=true in none mode.");
    if (!config.mcpAllowedHosts?.length) throw new Error("Network HTTP requires an explicit MCP_ALLOWED_HOSTS allowlist.");
  }
}

/** Unconfigured legacy loopback stays anonymous; OAuth never activates implicitly. */
export function httpAuthMode(config: AppConfig): "oauth" | "token" | "none" {
  return config.mcpAuthMode ?? (config.mcpAuthToken ? "token" : "none");
}
