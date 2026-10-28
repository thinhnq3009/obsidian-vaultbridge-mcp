import http from "node:http";

import type { Request, Response } from "express";
import express from "express";
import { MemoryStore, rateLimit } from "express-rate-limit";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { timingSafeEqual } from "node:crypto";
import { assertSupportedNode } from "./runtime.js";
import { httpAuthMode, validateHttpDeployment } from "./config.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createApplication, createMcpServer, type ApplicationContext } from "./server.js";
import type { AppConfig } from "./types.js";
import { RequestBudgets } from "./auth/budgets.js";
import type { startOwnerServer } from "./auth/http.js";

type ApplicationFactory = (config: AppConfig) => Promise<ApplicationContext>;

export async function startHttpServer(config: AppConfig, options: { createApplication?: ApplicationFactory } = {}): Promise<http.Server & { closed: Promise<void>; ownerOrigin?: string }> {
  assertSupportedNode();
  validateHttpDeployment(config);
  const application = await (options.createApplication ?? createApplication)(config);
  const mode = httpAuthMode(config);
  let ownerService: Awaited<ReturnType<typeof startOwnerServer>> | undefined;
  const resource = config.mcpOauthIssuer ? `${new URL(config.mcpOauthIssuer).origin}${config.mcpHttpPath}` : undefined;
  try {
    if (mode === "oauth") {
      // Legacy none/token/STDIO must not even load SQLite/owner modules.
      const { startOwnerServer } = await import("./auth/http.js");
      const { authDataDirectory } = await import("./auth/storage.js");
      ownerService = await startOwnerServer({
        directory: config.mcpAuthDirectory ?? authDataDirectory(), vaultPath: config.vaultPath!,
        port: config.mcpOwnerPort ?? 39146, requireOwner: true,
        oauth: { issuer: config.mcpOauthIssuer!, resource: resource! },
      });
    }
  } catch (error) { await application.close(); throw error; }
  if (mode === "none") process.stderr.write("[vaultbridge] WARNING: unauthenticated MCP access; global vault policy only.\n");
  if (mode === "token" && !config.mcpAuthMode) process.stderr.write("[vaultbridge] Legacy MCP_AUTH_TOKEN selected token mode; set MCP_AUTH_MODE=token explicitly.\n");
  if (ownerService) process.stderr.write(`[vaultbridge] EXPERIMENTAL OAuth (#60 unresolved); owner login/consent: ${ownerService.origin}/login\n`);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(hostHeaderValidation(config.mcpAllowedHosts ?? ["127.0.0.1", "localhost", "[::1]"]));
  let active = 0;
  const budgets = new RequestBudgets();
  app.use(async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        const protocol = config.mcpHttpTlsProxy ? "https:" : "http:";
        if (parsed.origin !== origin || parsed.protocol !== protocol || parsed.host !== request.headers.host) throw new Error("origin");
      } catch { response.status(403).json({ error: "Forbidden origin" }); return; }
    }
    const oauthRoute = ownerService && (request.path.startsWith("/api/auth/") || request.path.startsWith("/.well-known/"));
    const fail = () => {
      if (mode === "oauth") response.set("WWW-Authenticate", `Bearer resource_metadata="${new URL(resource!).origin}/.well-known/oauth-protected-resource${config.mcpHttpPath}"`);
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }); return;
    };
    const throttle = () => {
      response.setHeader("Retry-After", "60");
      response.status(429).json({ error: "Request budget exceeded" });
    };
    // Reserve capacity before any asynchronous provider/database/network work.
    if (active >= (config.mcpMaxConcurrent ?? 32)) { throttle(); return; }
    active++;
    response.once("close", () => { active--; });
    const peer = request.socket.remoteAddress ?? "unknown";
    if (!oauthRoute && mode !== "none" && !budgets.take(`attempt:${peer}`, config.mcpUnauthenticatedAttemptRpm ?? 60)) { throttle(); return; }
    if (!oauthRoute && mode === "token" && !validToken(request.headers.authorization, config.mcpAuthToken!)) { fail(); return; }
    if (!oauthRoute && mode === "oauth") {
      try {
        const principal = await ownerService!.owner.verifyPrincipal!(request.headers.authorization);
        response.locals.principal = principal;
        budgets.refund(`attempt:${peer}`);
        if (!budgets.take(`client:${JSON.stringify([principal.principalId, principal.clientId])}`, config.mcpAuthenticatedClientRpm ?? 600)) { throttle(); return; }
      } catch { fail(); return; }
    }
    if (!oauthRoute && mode === "token") budgets.refund(`attempt:${peer}`);
    if (request.headers["content-encoding"] && request.headers["content-encoding"].trim().toLowerCase() !== "identity") {
      response.status(415).json({ error: "Compressed request bodies are disabled" }); return;
    }
    if (!budgets.take(oauthRoute ? `oauth:${peer}` : "global", config.mcpRateLimitRpm ?? 1200, config.mcpRateLimitBurst ?? 120)) { throttle(); return; }
    next();
  });
  const oauthLimitStore = ownerService ? new MemoryStore() : undefined;
  if (ownerService) app.use(["/api/auth", "/.well-known"], rateLimit({
    windowMs: 60000, limit: config.mcpOauthEndpointRpm ?? 60,
    // Bounded aggregate admission for this single-process OAuth provider. Do
    // not use caller-controlled forwarding/client headers to allocate buckets.
    keyGenerator: () => "oauth-provider", store: oauthLimitStore!,
    standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_request, response) => { response.status(429).json({ error: "OAuth endpoint budget exceeded" }); },
  }), express.json({ limit: "16kb", inflate: false }),
  express.urlencoded({ limit: "16kb", extended: false, inflate: false }),
  async (request: Request<Record<string, string>, unknown, unknown>, response) => {
    const headers = new Headers();
    for (const name of ["content-type", "origin", "accept"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const body = request.body;
    const result = await ownerService.owner.handleOAuth(new globalThis.Request(new URL(request.originalUrl, new URL(resource!).origin), {
      method: request.method, headers,
      ...(["GET", "HEAD"].includes(request.method) ? {} : {
        body: request.is("application/x-www-form-urlencoded")
          ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
      }),
    }), request.socket.remoteAddress ?? "unknown");
    response.status(result.status);
    result.headers.forEach((value, name) => { if (name !== "set-cookie") response.setHeader(name, value); });
    if (result.status === 429) response.setHeader("Retry-After", result.headers.get("x-retry-after") ?? "60");
    response.send(Buffer.from(await result.arrayBuffer()));
  });

  app.use(express.json({ limit: 100 * 1024, inflate: false }));
  app.all(config.mcpHttpPath, async (request: Request<Record<string, string>, unknown, unknown>, response: Response) => {
    // AUTH-003 verifies identity only. Until Phase B supplies a live scoped
    // backend, no OAuth identity may fall through to the global backend.
    if (mode === "oauth") { response.status(403).json({ error: "No authorized vault grant" }); return; }
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
  const server = Object.assign(http.createServer({ maxHeaderSize: 16 * 1024 }, app), {
    closed: Promise.resolve(),
    ...(ownerService ? { ownerOrigin: ownerService.origin } : {}),
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.closed = new Promise<void>((resolve, reject) => {
    server.on("close", () => {
      oauthLimitStore?.shutdown();
      void (async () => { try { await ownerService?.close(); } finally { await application.close(); } })().then(resolve, reject);
    });
  });
  // Callers can await closed; avoid an unhandled rejection during CLI shutdown.
  void server.closed.catch(() => { process.stderr.write("[vaultbridge] HTTP cleanup failed.\n"); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.mcpHttpPort, config.mcpHttpHost, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { oauthLimitStore?.shutdown(); await ownerService?.close(); await application.close(); throw error; }
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
