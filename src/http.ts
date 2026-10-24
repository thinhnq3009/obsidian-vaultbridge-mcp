import http from "node:http";

import type { Request, Response } from "express";
import express from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { timingSafeEqual } from "node:crypto";
import { assertSupportedNode } from "./runtime.js";
import { validateHttpDeployment } from "./config.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createApplication, createMcpServer, type ApplicationContext } from "./server.js";
import type { AppConfig } from "./types.js";

type ApplicationFactory = (config: AppConfig) => Promise<ApplicationContext>;

export async function startHttpServer(config: AppConfig, options: { createApplication?: ApplicationFactory } = {}): Promise<http.Server> {
  assertSupportedNode();
  validateHttpDeployment(config);
  const application = await (options.createApplication ?? createApplication)(config);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(hostHeaderValidation(config.mcpAllowedHosts ?? ["127.0.0.1", "localhost", "[::1]"]));
  let active = 0;
  let windowStart = Date.now();
  let requests = 0;
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        const protocol = config.mcpHttpTlsProxy ? "https:" : "http:";
        if (parsed.origin !== origin || parsed.protocol !== protocol || parsed.host !== request.headers.host) throw new Error("origin");
      } catch { response.status(403).json({ error: "Forbidden origin" }); return; }
    }
    if (config.mcpAuthToken && !validToken(request.headers.authorization, config.mcpAuthToken)) {
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }); return;
    }
    if (request.headers["content-encoding"] && request.headers["content-encoding"].trim().toLowerCase() !== "identity") {
      response.status(415).json({ error: "Compressed request bodies are disabled" }); return;
    }
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 120 || active >= 32) { response.setHeader("Retry-After", "60"); response.status(429).json({ error: "Request budget exceeded" }); return; }
    active++;
    response.once("close", () => { active--; });
    next();
  });
  app.use(express.json({ limit: 100 * 1024, inflate: false }));

  app.all(config.mcpHttpPath, async (request: Request<Record<string, string>, unknown, unknown>, response: Response) => {
    const server = createMcpServer(application.backend, { colorfulLogs: config.colorfulLogs });
    const transport = new StreamableHTTPServerTransport();
    response.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      await transport.close(); await server.close();
      if (!response.headersSent) response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    void _next;
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    response.status([400, 413, 415].includes(status) ? status : 500).json({ error: status === 413 ? "Request body too large" : "Invalid request" });
  });
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.on("close", () => { void application.close(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.mcpHttpPort, config.mcpHttpHost, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { await application.close(); throw error; }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.mcpHttpPort;
  const endpoint = `http://${config.mcpHttpHost}:${String(port)}${config.mcpHttpPath}`;
  process.stderr.write(`${httpLogSegment("[obsidian-vault-mcp]", "cyan", config.colorfulLogs)} ${httpLogSegment("HTTP transport listening", "green", config.colorfulLogs)} at ${httpLogSegment(endpoint, "yellow", config.colorfulLogs)}\n`);
  return server;
}

function httpLogSegment(value: string, color: "cyan" | "green" | "yellow", enabled: boolean): string {
  if (!enabled) return value;
  const codes = { cyan: 36, green: 32, yellow: 33 } as const;
  return `\u001B[${String(codes[color])}m${value}\u001B[0m`;
}

function validToken(authorization: string | undefined, token: string): boolean {
  const actual = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
