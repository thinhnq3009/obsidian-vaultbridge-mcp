import { loadConfig, loadDotEnvFile, parseCliArgs } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

/**
 * Dev-only convenience configuration. It never makes OAuth the production
 * default or exposes owner login on a public listener.
 */
export function createDevOauthConfig(source: NodeJS.ProcessEnv, argv: string[] = [], dotEnv: Record<string, string> = loadDotEnvFile()): AppConfig {
  const cli = parseCliArgs(argv);
  const supplied = { ...dotEnv, ...source, ...cli };
  if (cli.MCP_TRANSPORT && cli.MCP_TRANSPORT !== "http") {
    throw new Error("OAuth development requires HTTP transport; use npm run dev:stdio for STDIO.");
  }
  if (supplied.MCP_AUTH_MODE && supplied.MCP_AUTH_MODE !== "oauth") {
    throw new Error("OAuth development requires MCP_AUTH_MODE=oauth; remove conflicting auth settings.");
  }
  if (supplied.MCP_HTTP_HOST && supplied.MCP_HTTP_HOST !== "127.0.0.1") {
    throw new Error("OAuth development must listen only on 127.0.0.1; put HTTPS on a separate trusted tunnel.");
  }
  if (!supplied.MCP_OWNER_PASSWORD || supplied.MCP_OWNER_PASSWORD === "admin39145") {
    throw new Error("Set a strong MCP_OWNER_PASSWORD in an untracked .env before npm run dev (never use the public default).");
  }
  const port = supplied.MCP_HTTP_PORT ?? "39145";
  const issuer = supplied.MCP_OAUTH_ISSUER ?? `http://127.0.0.1:${port}/api/auth`;
  const issuerUrl = new URL(issuer);
  const configured = {
    ...supplied,
    MCP_TRANSPORT: "http",
    MCP_AUTH_MODE: "oauth",
    MCP_OAUTH_ENABLED: "true",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: port,
    MCP_OAUTH_ISSUER: issuer,
    MCP_ALLOWED_HOSTS: supplied.MCP_ALLOWED_HOSTS ?? issuerUrl.hostname,
    MCP_VAULT_ID: supplied.MCP_VAULT_ID ?? "local-development-vault",
  };
  const config = loadConfig(configured, argv);
  if (config.mcpTransport !== "http" || config.mcpAuthMode !== "oauth" || !config.mcpOauthEnabled) {
    throw new Error("OAuth development configuration was overridden by incompatible CLI arguments.");
  }
  if (config.mcpHttpHost !== "127.0.0.1") {
    throw new Error("OAuth development HTTP listener must remain on loopback.");
  }
  if (config.mcpHttpPort === config.mcpOwnerPort) {
    throw new Error("MCP_HTTP_PORT and MCP_OWNER_PORT must be different.");
  }
  if (issuerUrl.protocol === "http:" && (issuerUrl.hostname !== "127.0.0.1" || Number(issuerUrl.port || 80) !== config.mcpHttpPort)) {
    throw new Error("For local HTTP OAuth, use the same 127.0.0.1 port for the listener and MCP_OAUTH_ISSUER.");
  }
  if (issuerUrl.protocol === "https:" && !config.mcpHttpTlsProxy) {
    throw new Error("HTTPS tunnel OAuth requires explicit MCP_HTTP_TLS_PROXY=true and trusted TLS termination.");
  }
  return config;
}
