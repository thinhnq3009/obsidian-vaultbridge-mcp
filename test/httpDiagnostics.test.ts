import fs from "node:fs/promises";
import http from "node:http";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../src/http.js";
import { createHttpDiagnostics } from "../src/httpDiagnostics.js";
import { createTempVault, makeConfig } from "./helpers.js";
import { oauthHarness } from "./oauthHelpers.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

async function tokenServer() {
  const vault = await createTempVault();
  cleanup.push(() => fs.rm(vault, { recursive: true, force: true }));
  const server = await startHttpServer(makeConfig({
    vaultPath: vault, mcpTransport: "http", mcpHttpPort: 0, mcpAuthToken: "private-bearer-token",
  }));
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    });
    await server.closed;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("HTTP diagnostics", () => {
  it("logs requests rejected before tool dispatch without logging headers, query strings or bodies", async () => {
    const origin = await tokenServer();
    const lines = captureLogs();
    const result = await fetch(`${origin}/mcp?code=private-code&state=private-state`, {
      method: "POST", headers: {
        authorization: "Bearer private-wrong-token", cookie: "owner=private-cookie",
        "content-type": "application/json", "x-request-id": "private-request-id",
        "user-agent": "private-user-agent", "x-forwarded-for": "private-forwarded-peer",
      },
      body: JSON.stringify({ password: "private-password", text: "private-vault-content" }),
    });
    await result.text();
    expect(result.status).toBe(401);
    const requestId = result.headers.get("x-vaultbridge-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
    const logs = lines.join("");
    expect(logs).toContain(`http request=${requestId}`);
    expect(logs).toContain("method=POST route=/mcp");
    expect(logs).toContain("status=401 stage=authentication");
    expect(logs).toMatch(/duration=\d+ms/u);
    expect(logs).not.toContain("private-");
    expect(lines.filter((line) => line.includes("http request="))).toHaveLength(1);
  });

  it("logs Host rejections before the Host middleware returns", async () => {
    const origin = await tokenServer();
    const lines = captureLogs();
    const result = await new Promise<{ status: number; id: string | string[] | undefined }>((resolve, reject) => {
      const request = http.request(`${origin}/private-path?token=private-query`, {
        headers: { host: "private-host.invalid" },
      }, (response) => {
        response.resume();
        response.on("end", () => {
          resolve({ status: response.statusCode!, id: response.headers["x-vaultbridge-request-id"] });
        });
      });
      request.on("error", reject);
      request.end();
    });
    expect(result.status).toBe(403);
    expect(lines.join("")).toContain(`http request=${String(result.id)}`);
    expect(lines.join("")).toContain("route=<unmatched>");
    expect(lines.join("")).toContain("host=unexpected");
    expect(lines.join("")).toContain("status=403 stage=host_validation");
    expect(lines.join("")).not.toContain("private-");
  });

  it("distinguishes Origin rejection from body parsing errors", async () => {
    const origin = await tokenServer();
    const lines = captureLogs();
    for (const [headers, status, stage] of [
      [{ origin: "https://private-origin.invalid" }, 403, "origin_validation"],
      [{ authorization: "Bearer private-bearer-token" }, 400, "mcp_body"],
    ] as const) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{",
      });
      await response.text();
      expect(response.status).toBe(status);
      expect(lines.join("")).toContain(`status=${status} stage=${stage}`);
    }
    expect(lines.join("")).not.toContain("private-");
  });

  it("logs OAuth discovery, issuer Host mismatch, provider rejection and malformed provider bodies", async () => {
    const h = await oauthHarness({ mcpAllowedHosts: ["127.0.0.1", "localhost"], mcpOauthEndpointRpm: 3 });
    cleanup.push(() => h.close());
    const lines = captureLogs();
    const discovery = await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp?state=private-state`);
    await discovery.text();
    expect(discovery.status).toBe(200);
    expect(lines.join("")).toContain("route=/.well-known/oauth-protected-resource/mcp");
    expect(lines.join("")).toContain("status=200 stage=oauth_provider");
    const mismatch = await new Promise<number>((resolve, reject) => {
      const request = http.request(`${h.origin}/mcp`, {
        headers: { host: new URL(h.origin).host.replace("127.0.0.1", "localhost") },
      }, (response) => {
        response.resume();
        response.on("end", () => { resolve(response.statusCode!); });
      });
      request.on("error", reject);
      request.end();
    });
    expect(mismatch).toBe(403);
    expect(lines.join("")).toContain("status=403 stage=issuer_host");
    const denied = await fetch(`${h.origin}/api/auth/oauth2/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    await denied.text();
    expect(denied.status).toBe(404);
    expect(lines.join("")).toContain("status=404 stage=oauth_provider");
    const malformed = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    await malformed.text();
    expect(malformed.status).toBe(400);
    expect(lines.join("")).toContain("status=400 stage=oauth_body");
    const throttled = await fetch(`${h.origin}/api/auth/.well-known/oauth-authorization-server`);
    await throttled.text();
    expect(throttled.status).toBe(429);
    expect(lines.join("")).toContain("status=429 stage=oauth_budget");
    expect(lines.join("")).not.toContain("private-");
  });

  it("logs a disconnected streaming response once, without falsely reporting success", async () => {
    const diagnostics = createHttpDiagnostics(makeConfig());
    const app = express();
    app.use(diagnostics.observe);
    app.get("/mcp", (_request, response) => {
      diagnostics.stage(response, "mcp_transport");
      response.write("private-response-body");
    });
    const server = http.createServer(app);
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }));
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const lines = captureLogs();
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${String(address.port)}/mcp`, (response) => {
        response.once("data", () => { response.destroy(); });
        response.once("close", resolve);
      });
      request.on("error", reject);
    });
    await expect.poll(() => lines.join("")).toContain("status=aborted stage=mcp_transport");
    expect(lines.filter((line) => line.includes("http request="))).toHaveLength(1);
    expect(lines.join("")).not.toContain("private-");
  });
});
