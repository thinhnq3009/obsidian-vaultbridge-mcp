import { z } from "zod";
import { loadConfig, loadDotEnvFile } from "../config.js";
import { authDataDirectory } from "./storage.js";
import { startOwnerServer } from "./http.js";

export function ownerOptions(env: NodeJS.ProcessEnv, argv: string[]) {
  const merged: Record<string, string | undefined> = { ...env };
  const mapping: Record<string, string> = { "--owner-port": "MCP_OWNER_PORT", "--auth-login-max-failures": "MCP_AUTH_LOGIN_MAX_FAILURES", "--auth-login-window-seconds": "MCP_AUTH_LOGIN_WINDOW_SECONDS" };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i]!.split("=", 2);
    if (key && mapping[key]) {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      merged[mapping[key]] = value;
    }
  }
  const parsed = z.object({
    MCP_OWNER_PORT: z.coerce.number().int().min(1).max(65535).default(39146),
    MCP_AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(20).default(5),
    MCP_AUTH_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),
  }).parse(merged);
  return { port: parsed.MCP_OWNER_PORT, maxFailures: parsed.MCP_AUTH_LOGIN_MAX_FAILURES, windowSeconds: parsed.MCP_AUTH_LOGIN_WINDOW_SECONDS, recover: argv.includes("--recover-owner"),
    ...(env.MCP_OWNER_USERNAME !== undefined ? { ownerUsername: env.MCP_OWNER_USERNAME } : {}),
    ...(env.MCP_OWNER_PASSWORD !== undefined ? { ownerPassword: env.MCP_OWNER_PASSWORD } : {}) };
}

export async function runOwnerCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    process.stderr.write("owner-auth --vault /absolute/test-vault [--owner-port 39146] [--recover-owner]\n  --auth-login-max-failures 5 (1–20)\n  --auth-login-window-seconds 900 (1–86400)\nLocal owner identity only; does not enable MCP OAuth. No proxy/network access.\n");
    return;
  }
  const env = { ...loadDotEnvFile(), ...process.env };
  if (env.MCP_AUTH_MODE === "none") throw new Error("Anonymous mode does not need owner setup. Omit owner-auth; no database is opened.");
  const config = loadConfig(env, argv);
  if (!config.vaultPath) throw new Error("Owner auth requires --vault to validate out-of-vault storage");
  const options = ownerOptions(env, argv);
  const service = await startOwnerServer({ ...options, vaultPath: config.vaultPath,
    directory: config.mcpAuthDirectory ?? authDataDirectory(process.platform, env) });
  process.stderr.write(`[vaultbridge] Local owner UI: ${service.origin}/login\n`);
  if (service.tokenPath) process.stderr.write(`[vaultbridge] One-time recovery token file: ${service.tokenPath} (expires in 10 minutes; do not share)\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void service.close().catch(() => { process.stderr.write("Owner shutdown failed; stop the process before backup/recovery.\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
