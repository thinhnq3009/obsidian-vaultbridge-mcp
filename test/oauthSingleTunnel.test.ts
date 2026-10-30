import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

import { clientA, oauthHarness, password, redirectUri } from "./oauthHelpers.js";

let chatGptJwks: { keys: Record<string, unknown>[] } = { keys: [] };

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL) => {
    const urlStr = String(input);
    if (urlStr === "https://chatgpt.com/oauth/client.json") {
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
    if (urlStr === "https://chatgpt.com/oauth/jwks.json") {
      return Promise.resolve(Response.json(chatGptJwks));
    }
    if (!["https://client-a.example/metadata.json", "https://client-b.example/metadata.json"].includes(urlStr)) {
      throw new Error(`Unrecognized fixture client: ${urlStr}`);
    }
    return Promise.resolve(Response.json({
      client_id: urlStr,
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

    // Compressed request (Content-Encoding != identity)
    const compressedRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        host: new URL(h.origin).host,
        "content-type": "application/x-www-form-urlencoded",
        "content-encoding": "gzip",
      },
      body: "grant_type=authorization_code",
    });
    expect(compressedRes.status).toBe(415);
  });

  it("enforces CSRF and origin defense on private owner listener", async () => {
    const h = await setupSingleTunnel();

    // Missing CSRF header
    const noCsrfRes = await fetch(`${h.ownerOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: h.ownerOrigin,
      },
      body: JSON.stringify({ username: "owner@example.test", password }),
    });
    expect(noCsrfRes.status).toBe(403);

    // Mismatched origin
    const badOriginRes = await fetch(`${h.ownerOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: "https://evil-site.example",
      },
      body: JSON.stringify({ username: "owner@example.test", password }),
    });
    expect(badOriginRes.status).toBe(403);
  });

  it("rejects token exchange with invalid PKCE code_verifier", async () => {
    const h = await setupSingleTunnel();
    const code = await h.grant();

    const badTokenRes = await h.form("token", {
      grant_type: "authorization_code",
      code: code.code,
      code_verifier: "wrong-pkce-verifier-does-not-match",
      redirect_uri: redirectUri,
      resource: `${h.origin}/mcp`,
    });
    expect(badTokenRes.status).toBe(400);
    const body = await badTokenRes.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("code verification failed");
  });

  it("authenticates simulated ChatGPT client using RFC 7523 private_key_jwt assertions without bypass", async () => {
    const h = await setupSingleTunnel();

    // Setup simulated RSA keys for ChatGPT
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "chatgpt-simulated-key-1";
    jwk.use = "sig";
    jwk.alg = "RS256";
    chatGptJwks = { keys: [jwk] };

    const chatGptClientId = "https://chatgpt.com/oauth/client.json";
    const chatGptRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

    // 1. Initiate authorization with ChatGPT client metadata
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const params = new URLSearchParams({
      client_id: chatGptClientId,
      redirect_uri: chatGptRedirectUri,
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

    // 2. Owner login on private port 39146
    const loginRes = await h.post("/api/auth/sign-in/email", {
      username: "owner@example.test",
      password,
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // 3. Grant & Consent
    await h.post("/oauth/authorize", { oauth_query: oauthQuery }, cookie);
    await h.post("/oauth/grants", {
      oauth_query: oauthQuery,
      principalPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"] }],
      clientPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"], tools: ["obsidian_read_note", "obsidian_list_files"] }],
    }, cookie);

    const consentRes = await h.post("/oauth/consent", { oauth_query: oauthQuery, accept: true }, cookie);
    const callbackUrl = new URL((await consentRes.json() as { url: string }).url);
    const code = callbackUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 4. Negative test: Attempting token exchange with 'none' must fail closed
    const noneRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${h.origin}/mcp`,
      }),
    });
    expect(noneRes.status).toBe(400);
    const noneBody = await noneRes.json() as { error: string; error_description: string };
    expect(noneBody.error).toBe("invalid_client");
    expect(noneBody.error_description).toContain("private_key_jwt");

    // 5. Negative test: Attempting exchange with forged key assertion must fail
    const { privateKey: attackerKey } = await generateKeyPair("RS256");
    const forgedAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "attacker-key" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience([`${h.origin}/api/auth/oauth2/token`])
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(attackerKey);

    const forgedRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: forgedAssertion,
      }),
    });
    expect([400, 401]).toContain(forgedRes.status);

    // 5b. Negative test: Mismatched audience must fail
    const wrongAudAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chatgpt-simulated-key-1" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience(["https://wrong-audience.example/token"])
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const wrongAudRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: wrongAudAssertion,
      }),
    });
    expect([400, 401]).toContain(wrongAudRes.status);

    // 5c. Negative test: Expired assertion must fail
    const expiredAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chatgpt-simulated-key-1" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience([`${h.origin}/api/auth/oauth2/token`])
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);

    const expiredRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: expiredAssertion,
      }),
    });
    expect([400, 401]).toContain(expiredRes.status);

    // 6. Positive test: Valid client assertion signed with ChatGPT's simulated private key
    const validJti = randomUUID();
    const validAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chatgpt-simulated-key-1" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience([`${h.origin}/api/auth/oauth2/token`])
      .setJti(validJti)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const tokenRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: validAssertion,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // 7. Execute MCP tool with issued token
    const client = new Client({ name: "simulated-chatgpt-client", version: "1.0.0" });
    runningClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }));
    const toolCall = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/Doc.md" } });
    expect(toolCall.isError).not.toBe(true);
    expect(JSON.stringify(toolCall)).toContain("Permitted content");

    // 8. Negative test: Replay prevention - reusing validJti must be rejected
    const replayedAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chatgpt-simulated-key-1" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience([`${h.origin}/api/auth/oauth2/token`])
      .setJti(validJti)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const replayRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: replayedAssertion,
      }),
    });
    expect(replayRes.status).toBe(400);
    const replayBody = await replayRes.json() as { error_description: string };
    expect(replayBody.error_description).toContain("jti has already been used");

    // 9. Positive test: Refresh token exchange with a new fresh client assertion
    const refreshAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chatgpt-simulated-key-1" })
      .setIssuer(chatGptClientId)
      .setSubject(chatGptClientId)
      .setAudience([`${h.origin}/api/auth/oauth2/token`])
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const refreshRes = await fetch(`${h.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: `${h.origin}/mcp`,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: refreshAssertion,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json() as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });
});
