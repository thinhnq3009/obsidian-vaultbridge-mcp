import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../src/types.js";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    backend: "filesystem",
    vaultPath: process.cwd(),
    readOnly: false,
    // Historical byte-exact suites deliberately exercise the disabled baseline.
    // OBS-003 tests opt in; config.test.ts verifies the production default.
    autoAgentEditAt: false,
    readPaths: [],
    writePaths: [],
    indexMode: "scan",
    watchMode: "off",
    cacheDir: path.join(os.tmpdir(), "obsidian-vault-mcp-tests"),
    maxFileSizeBytes: 1024 * 1024,
    maxTreeEntries: 1000,
    maxSearchResults: 100,
    obsidianVerifySsl: false,
    requestTimeoutMs: 10_000,
    retryCount: 0,
    mcpTransport: "stdio",
    colorfulLogs: false,
    mcpHttpHost: "127.0.0.1",
    mcpHttpPort: 39145,
    mcpHttpPath: "/mcp",
    ...overrides,
  };
}

export async function createTempVault(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-")));
}
