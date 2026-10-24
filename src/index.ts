#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertSupportedNode } from "./runtime.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";

async function main() {
  assertSupportedNode();
  const config = loadConfig();

  if (config.mcpTransport === "http") {
    const httpServer = await startHttpServer(config);

    const shutdown = () => {
      httpServer.close();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const { server, application } = await createServer(config);
  const shutdown = () => { void server.close(); void application.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[obsidian-vault-mcp] ${message}\n`);
  process.exitCode = 1;
});
