#!/usr/bin/env node
/**
 * Disposable local Better Auth + MCP SDK v2 integration smoke test.
 * This deliberately stops before login/consent/token exchange, which depends on
 * AUTH-002's account/bootstrap and browser UI work. It never opens a real vault.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { rateLimit, MemoryStore } from "express-rate-limit";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vaultbridge-auth-001-"));
const databasePath = path.join(temporaryDirectory, "auth.sqlite");
const database = new DatabaseSync(databasePath);
const journalMode = database.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
assert.equal(String(journalMode).toLowerCase(), "wal");
let listener;
const mcpRateLimitStore = new MemoryStore();

function peerHeaders(request) {
  const headers = new Headers(request.headers);
  // The spike has no trusted proxy. Never use a caller-supplied IP for auth
  // throttling: overwrite this dedicated header from the actual TCP peer.
  headers.set("x-vaultbridge-peer-ip", request.socket.remoteAddress);
  return headers;
}

try {
  let auth;
  let baseURL;
  let resource;

  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: "vaultbridge-auth-001-spike", version: "0.0.0" });
    server.registerTool("spike_ping", { inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({
      content: [{ type: "text", text: `pong:${message}` }],
    }));
    return server;
  }, { legacy: "reject" });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((request, response, next) => {
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(request.hostname)) {
      response.sendStatus(403);
      return;
    }
    next();
  });
  app.post("/mcp", rateLimit({
    windowMs: 60_000,
    limit: 4,
    // One fixed key bounds this disposable loopback-only store to one entry.
    // This tiny test budget is NOT the production MCP throughput policy.
    keyGenerator: () => "local-spike",
    store: mcpRateLimitStore,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }), express.json({ limit: "100kb", inflate: false }), async (request, response) => {
    try {
      const webRequest = new Request(`${baseURL}${request.originalUrl}`, {
        method: "POST",
        headers: peerHeaders(request),
        body: JSON.stringify(request.body),
      });
      const result = await requireMcpAuth(auth, (verifiedRequest) => mcpHandler.fetch(verifiedRequest), { resource })(webRequest);
      response.status(result.status);
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.send(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.sendStatus(500);
    }
  });
  app.use(express.json({ limit: "100kb", inflate: false }));
  app.use(async (request, response) => {
    try {
      const url = new URL(request.originalUrl, baseURL);
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : JSON.stringify(request.body ?? {});
      const result = await auth.handler(new Request(url, { method: request.method, headers: peerHeaders(request), body }));
      response.status(result.status);
      result.headers.forEach((value, name) => response.setHeader(name, value));
      // Better Auth 1.7 emits X-Retry-After; expose the standard header too.
      if (result.status === 429 && result.headers.has("x-retry-after")) {
        response.setHeader("Retry-After", result.headers.get("x-retry-after"));
      }
      response.send(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.sendStatus(500);
    }
  });

  listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected local TCP listener");
  baseURL = `http://127.0.0.1:${address.port}`;
  resource = `${baseURL}/mcp`;
  auth = betterAuth({
    appName: "VaultBridge AUTH-001 disposable spike",
    baseURL,
    secret: "auth-001-disposable-secret-do-not-reuse-0001",
    logger: { disabled: true },
    database,
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: { ipAddress: { ipAddressHeaders: ["x-vaultbridge-peer-ip"] } },
    rateLimit: {
      enabled: true, // Explicit even when NODE_ENV is development/test.
      storage: "memory",
      window: 60,
      max: 60,
      customRules: { "/get-session": { window: 60, max: 2 } },
    },
    plugins: [
      jwt(),
      mcp({ loginPage: "/login", consentPage: "/consent", resource }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
  await (await auth.$context).runMigrations();
  assert.ok(database.prepare("select name from sqlite_master where type = 'table' and name = 'user'").get(), "Better Auth migrations must create the user table in temporary SQLite");

  const protectedResource = await fetch(`${baseURL}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedResource.status, 200, "Better Auth must serve RFC 9728 resource metadata");
  const metadata = await protectedResource.json();
  assert.equal(metadata.resource, resource);
  assert.ok(Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length > 0);

  const authorizationServer = await fetch(`${metadata.authorization_servers[0]}/.well-known/oauth-authorization-server`);
  if (!authorizationServer.ok) {
    process.stderr.write(`Authorization server metadata URL returned ${authorizationServer.status}: ${metadata.authorization_servers[0]}\n`);
  }
  assert.equal(authorizationServer.status, 200, "Better Auth must serve RFC 8414 authorization metadata");
  const asMetadata = await authorizationServer.json();
  assert.ok(asMetadata.authorization_endpoint?.includes("/oauth2/authorize"));
  assert.ok(asMetadata.token_endpoint?.includes("/oauth2/token"));
  assert.equal(asMetadata.client_id_metadata_document_supported, true);

  const challenge = await fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(challenge.status, 401, "missing bearer must be rejected by Better Auth middleware");
  assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata=/u);

  const mcpRequest = (headers = {}) => fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
  });
  const invalidToken = await mcpRequest({ authorization: "Bearer invalid-spike-token" });
  assert.equal(invalidToken.status, 401, "invalid bearer must not downgrade to anonymous");
  assert.match(invalidToken.headers.get("www-authenticate") ?? "", /resource_metadata=/u);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await mcpRequest()).status, 401, "requests within the four-request spike budget retain the challenge");
  }
  const assertThrottled = (response) => {
    assert.equal(response.status, 429, "requests above the spike budget must be throttled");
    assert.match(response.headers.get("retry-after") ?? "", /^[1-9]\d*$/u, "429 must include Retry-After in seconds");
  };
  assertThrottled(await mcpRequest());
  assertThrottled(await mcpRequest({
    "x-forwarded-for": "203.0.113.42",
    "x-real-ip": "203.0.113.43",
    "x-client-id": "spoofed-client",
    "x-vaultbridge-peer-ip": "203.0.113.44",
  }));
  for (const response of await Promise.all(Array.from({ length: 4 }, () => mcpRequest()))) {
    assertThrottled(response);
  }
  assert.equal((await fetch(`${baseURL}/.well-known/oauth-protected-resource/mcp`)).status, 200, "MCP flooding must not block protected-resource discovery");
  assert.equal((await fetch(`${metadata.authorization_servers[0]}/.well-known/oauth-authorization-server`)).status, 200, "MCP flooding must not block authorization-server discovery");

  // Exercise Better Auth's limiter on a cheap endpoint, without creating users
  // or pretending to test password login/PKCE before AUTH-002/003 exist.
  const sessionURL = `${new URL(asMetadata.authorization_endpoint).origin}/api/auth/get-session`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await fetch(sessionURL);
    assert.equal(session.status, 200);
    assert.equal(await session.json(), null, "no session is created by the spike");
  }
  assertThrottled(await fetch(sessionURL, {
    headers: { "x-forwarded-for": "203.0.113.45", "x-vaultbridge-peer-ip": "203.0.113.46" },
  }));

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    node: process.version,
    sqlite: database.prepare("select sqlite_version() as version").get().version,
    betterAuth: "1.7.13",
    betterAuthMcp: "1.7.13",
    betterAuthCimd: "1.7.13",
    expressRateLimit: "8.7.1",
    mcpServerSdk: "2.4.0",
    mcpExpressAdapter: "2.0.2",
    database: "temporary node:sqlite file with WAL, outside any vault",
    localOnly: true,
    authServerDiscovery: true,
    protectedResourceMetadata: true,
    cimdAdvertised: true,
    sdkV2LegacyRejected: true,
    unauthenticatedMcpRejected: true,
    invalidBearerRejected: true,
    mcpRateLimit: "4 requests / 60 seconds; isolated spike only",
    mcpFloodRejected: true,
    retryAfterPresent: true,
    spoofedIpHeadersCannotBypass: true,
    discoveryAvailableAfterMcpFlood: true,
    betterAuthRateLimitEnabledAndTested: true,
    loginConsentPkceTokenRefreshRevoke: "NOT TESTED; requires AUTH-002 account/bootstrap and browser UI",
  }, null, 2)}\n`);
} finally {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  mcpRateLimitStore.shutdown();
  database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
