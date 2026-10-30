import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../src/http.js";
import { makeConfig } from "./helpers.js";
import { clientA, oauthHarness, password, redirectUri } from "./oauthHelpers.js";

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL) => {
    const clientId = String(input);
    if (clientId === "https://chatgpt.com/oauth/client.json") {
      return Promise.resolve(Response.json({
        client_id: "https://chatgpt.com/oauth/client.json",
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        jwks_uri: "https://chatgpt.com/oauth/jwks.json",
      }));
    }
    if (!["https://client-a.example/metadata.json", "https://client-b.example/metadata.json"].includes(clientId)) {
      throw new Error("Unrecognized fixture client");
    }
    return Promise.resolve(Response.json({
      client_id: clientId,
      client_name: "Disposable test client",
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }));
  },
}));

type Harness = Awaited<ReturnType<typeof oauthHarness>>;
const runningHarnesses: Harness[] = [];
const runningClients: Client[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of runningClients.splice(0)) await client.close();
  for (const harness of runningHarnesses.splice(0)) await harness.close();
});

async function setupSingleTunnel(overrides: Record<string, unknown> = {}) {
  const harness = await oauthHarness({
    mcpHttpTlsProxy: false,
    ...overrides,
  });
  runningHarnesses.push(harness);

  await fs.mkdir(path.join(harness.vault, "Notes"), { recursive: true });
  await fs.mkdir(path.join(harness.vault, "Secret"), { recursive: true });
  await fs.writeFile(path.join(harness.vault, "Notes", "Doc.md"), "# Allowed Doc\nPermitted content.");
  await fs.writeFile(path.join(harness.vault, "Secret", "Denied.md"), "# Denied Doc\nSecret content.");
  await harness.restart();
  return harness;
}

describe("AUTH-005A Single Tunnel OAuth Architecture (39145 public / 39146 private owner)", () => {
  it("enforces 401 challenge with public-origin resource metadata on unauthenticated /mcp access", async () => {
    const h = await setupSingleTunnel();
    const challengeRes = await fetch(`${h.origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    expect(challengeRes.status).toBe(401);
    const wwwAuth = challengeRes.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain(`resource_metadata="${h.origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(wwwAuth).not.toContain(h.ownerOrigin);
  });

  it("serves public-origin consistent discovery metadata without leaking private owner port", async () => {
    const h = await setupSingleTunnel();

    // Protected resource metadata
    const resourceRes = await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`);
    expect(resourceRes.status).toBe(200);
    const resourceMeta = await resourceRes.json() as { resource: string; authorization_servers: string[] };
    expect(resourceMeta.resource).toBe(`${h.origin}/mcp`);
    expect(resourceMeta.authorization_servers).toEqual([`${h.origin}/api/auth`]);

    // Authorization server metadata via /api/auth/.well-known
    const authServerRes = await fetch(`${h.origin}/api/auth/.well-known/oauth-authorization-server`);
    expect(authServerRes.status).toBe(200);
    const authMeta = await authServerRes.json() as Record<string, unknown>;
    expect(authMeta.issuer).toBe(`${h.origin}/api/auth`);
    expect(authMeta.authorization_endpoint).toBe(`${h.origin}/api/auth/oauth2/authorize`);
    expect(authMeta.token_endpoint).toBe(`${h.origin}/api/auth/oauth2/token`);
    expect(authMeta.revocation_endpoint).toBe(`${h.origin}/api/auth/oauth2/revoke`);
    expect(authMeta.code_challenge_methods_supported).toContain("S256");

    // Authorization server metadata via RFC 8414 /.well-known/.../api/auth
    const rfc8414Res = await fetch(`${h.origin}/.well-known/oauth-authorization-server/api/auth`);
    expect(rfc8414Res.status).toBe(200);
    const rfc8414Meta = await rfc8414Res.json() as Record<string, unknown>;
    expect(rfc8414Meta.issuer).toBe(`${h.origin}/api/auth`);

    // Ensure discovery metadata contains zero occurrences of owner origin/port
    const metaStr = JSON.stringify(authMeta) + JSON.stringify(resourceMeta);
    expect(metaStr).not.toContain(h.ownerOrigin);
  });

  it("redirects browser on public authorize endpoint (302) to private loopback owner login", async () => {
    const h = await setupSingleTunnel();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const params = new URLSearchParams({
      client_id: clientA,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "vault:read offline_access",
      resource: `${h.origin}/mcp`,
      state,
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authorizeRes = await fetch(`${h.origin}/api/auth/oauth2/authorize?${params}`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      redirect: "manual",
    });

    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toMatch(new RegExp(`^${h.ownerOrigin}/login\\?`));

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe(h.ownerOrigin);
    expect(redirectUrl.pathname).toBe("/login");
    expect(redirectUrl.searchParams.get("client_id")).toBe(clientA);
    expect(redirectUrl.searchParams.get("state")).toBe(state);
    expect(redirectUrl.searchParams.get("sig")).toBeTruthy();
  });

  it("completes full E2E flow: 401 -> discovery -> authorize -> login -> consent -> PKCE exchange -> MCP tool -> refresh -> revoke", async () => {
    const h = await setupSingleTunnel();

    // 1. Authorize initiate
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const params = new URLSearchParams({
      client_id: clientA,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "vault:read offline_access",
      resource: `${h.origin}/mcp`,
      state,
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authRes = await fetch(`${h.origin}/api/auth/oauth2/authorize?${params}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("location")!);
    const oauthQuery = location.search.slice(1);

    // 2. Owner Login on private owner port
    const loginRes = await h.post("/api/auth/sign-in/email", {
      username: "owner@example.test",
      password,
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toBeTruthy();

    // 3. Resume authorize to reach consent
    const resumeRes = await h.post("/oauth/authorize", { oauth_query: oauthQuery }, cookie);
    expect(resumeRes.status).toBe(200);
    const consentTarget = new URL((await resumeRes.json() as { url: string }).url, h.ownerOrigin);
    expect(consentTarget.pathname).toBe("/consent");

    // 4. Create scoped grant (Notes only, readNote + listFiles)
    const grantRes = await h.post("/oauth/grants", {
      oauth_query: oauthQuery,
      principalPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"] }],
      clientPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"], tools: ["obsidian_read_note", "obsidian_list_files"] }],
    }, cookie);
    expect(grantRes.status).toBe(200);
    const { grantId } = await grantRes.json() as { grantId: string };
    expect(grantId).toBeTruthy();

    // 5. Consent approve -> callback with code
    const consentRes = await h.post("/oauth/consent", { oauth_query: oauthQuery, accept: true }, cookie);
    expect(consentRes.status).toBe(200);
    const callback = new URL((await consentRes.json() as { url: string }).url);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    const code = callback.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(`${h.origin}/api/auth`);

    // 6. PKCE Token Exchange on public port
    const tokenRes = await h.form("token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${h.origin}/mcp`,
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // 7. MCP Tool Execution on public port
    const client = new Client({ name: "single-tunnel-test-client", version: "1.0.0" });
    runningClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }));

    // Allowed read
    const allowed = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/Doc.md" } });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain("Permitted content");

    // Denied read (outside granted subtree)
    const deniedSubtree = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Secret/Denied.md" } });
    expect(deniedSubtree.isError).toBe(true);

    // Denied tool (write was not granted)
    const deniedTool = await client.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/Doc.md", content: "overwritten" } });
    expect(deniedTool.isError).toBe(true);

    // 8. Refresh Token Exchange
    const refreshRes = await h.form("token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource: `${h.origin}/mcp`,
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json() as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // Verify refreshed token can call MCP tool
    await client.close();
    const refreshedClient = new Client({ name: "refreshed-client", version: "1.0.0" });
    runningClients.push(refreshedClient);
    await refreshedClient.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${refreshed.access_token}` } },
    }));
    const refreshedRead = await refreshedClient.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/Doc.md" } });
    expect(refreshedRead.isError).not.toBe(true);

    // 9. Revocation
    const revokeRes = await h.post("/oauth/grants/revoke", { grantId }, cookie);
    expect(revokeRes.status).toBe(200);

    // Subsequent tool call fails with 403
    const postRevoke = await fetch(`${h.origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshed.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "obsidian_read_note", arguments: { path: "Notes/Doc.md" } }, id: 2 }),
    });
    expect(postRevoke.status).toBe(403);
  });

  it("never exposes private owner UI or admin API routes on the public port", async () => {
    const h = await setupSingleTunnel();

    const privateRoutes = [
      "/login",
      "/consent",
      "/admin",
      "/owner-state",
      "/api/auth/sign-in/email",
      "/api/auth/get-session",
      "/api/auth/revoke-sessions",
      "/api/auth/change-password",
      "/oauth/grants",
      "/oauth/grants/revoke",
      "/oauth/consent",
    ];

    for (const route of privateRoutes) {
      const getRes = await fetch(`${h.origin}${route}`);
      expect([401, 404]).toContain(getRes.status);

      const postRes = await fetch(`${h.origin}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect([401, 404]).toContain(postRes.status);
    }
  });

  it("rejects forged Host header or cross-origin requests on public listener", async () => {
    const h = await setupSingleTunnel();
    const port = new URL(h.origin).port;

    // Direct HTTP request with spoofed Host
    const wrongHostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { host: "evil-spoofed-host.example:39145" },
      }, (res) => {
        res.resume();
        res.on("end", () => { resolve(res.statusCode!); });
      });
      req.on("error", reject);
      req.end();
    });
    expect(wrongHostStatus).toBe(403);

    // Request with mismatched Origin header
    const crossOriginRes = await fetch(`${h.origin}/mcp`, {
      method: "POST",
      headers: {
        host: new URL(h.origin).host,
        origin: "https://malicious-site.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(crossOriginRes.status).toBe(403);
  });
});
