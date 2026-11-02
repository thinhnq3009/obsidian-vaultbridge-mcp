import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { E2ELifecycle } from "./e2eLifecycle.js";

interface NativeFlowOptions {
  lifecycle: E2ELifecycle;
  authDirectory: string;
  publicOrigin: string;
  ownerOrigin: string;
  cookie: string;
  notePath: string;
  deniedPath: string;
  expectedContent: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

/** A pre-provisioned disposable native client, NOT DCR or a real ChatGPT client. */
export async function verifyNativeFlow(options: NativeFlowOptions): Promise<void> {
  const { lifecycle, publicOrigin, ownerOrigin, cookie } = options;
  const fetch = lifecycle.fetch;
  const clientId = `native-e2e-${randomUUID()}`;
  const redirectUri = "http://127.0.0.1:49152/callback";
  const resource = `${publicOrigin}/mcp`;
  const database = new DatabaseSync(path.join(options.authDirectory, "auth.sqlite"));
  try {
    database.prepare(`
      INSERT INTO oauthClient (
        id, clientId, name, redirectUris, tokenEndpointAuthMethod, applicationType,
        grantTypes, responseTypes, requirePKCE, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, 'none', 'native', ?, ?, 1, datetime('now'), datetime('now'))
    `).run(clientId, clientId, "Disposable native E2E", JSON.stringify([redirectUri]),
      JSON.stringify(["authorization_code", "refresh_token"]), JSON.stringify(["code"]));
    database.prepare(`
      INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt)
      VALUES (?, ?, ?, datetime('now'))
    `).run(randomUUID(), clientId, resource);
  } finally {
    database.close();
  }

  async function ownerPost(endpoint: string, body: unknown) {
    const response = await fetch(`${ownerOrigin}${endpoint}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", "x-vaultbridge-csrf": "1", origin: ownerOrigin, cookie },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `Owner ${endpoint}`);
    return await response.json() as { url: string; grantId: string };
  }

  async function authorize() {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: "vault:read offline_access", resource, state, prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${publicOrigin}/api/auth/oauth2/authorize?${params}`, {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin, ownerOrigin);
    assert.equal(location.pathname, "/login");
    const query = location.search.slice(1);
    const resumed = new URL((await ownerPost("/oauth/authorize", { oauth_query: query })).url, ownerOrigin);
    assert.equal(resumed.origin, ownerOrigin);
    assert.equal(resumed.pathname, "/consent");
    return { verifier, state, query: resumed.search.slice(1) };
  }

  async function approve(pending: Awaited<ReturnType<typeof authorize>>) {
    const result = await ownerPost("/oauth/consent", { oauth_query: pending.query, accept: true });
    const callback = new URL(result.url);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), pending.state);
    assert.equal(callback.searchParams.get("iss"), `${publicOrigin}/api/auth`);
    const code = callback.searchParams.get("code");
    assert.ok(code, "Fresh authorization code");
    return code;
  }

  async function token(body: Record<string, string>) {
    return fetch(`${publicOrigin}/api/auth/oauth2/token`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, resource, ...body }),
    });
  }

  const pending = await authorize();
  const grant = await ownerPost("/oauth/grants", {
    oauth_query: pending.query,
    principalPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"] }],
    clientPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"], tools: ["obsidian_read_note", "obsidian_list_files"] }],
  });
  assert.ok(grant.grantId);
  const wrongVerifier = await token({
    grant_type: "authorization_code", code: await approve(pending),
    code_verifier: randomBytes(32).toString("base64url"), redirect_uri: redirectUri,
  });
  assert.equal(wrongVerifier.status, 400);
  const error = await wrongVerifier.json() as { error: string; error_description: string };
  assert.equal(error.error, "invalid_grant");
  assert.match(error.error_description, /code verification failed/);
  console.log("  ✓ Isolated PKCE mismatch rejected with invalid_grant / code verification failed");

  const valid = await authorize();
  const exchanged = await token({
    grant_type: "authorization_code", code: await approve(valid),
    code_verifier: valid.verifier, redirect_uri: redirectUri,
  });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json() as TokenResponse;
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  async function checkTools(accessToken: string) {
    const client = new Client({ name: "disposable-native-e2e", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
        fetch, requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }));
      const allowed = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
      assert.notEqual(allowed.isError, true);
      assert.ok(JSON.stringify(allowed).includes(options.expectedContent), "Allowed note content");
      const denied = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.deniedPath } });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /ACCESS_DENIED/);
      const write = await client.callTool({
        name: "obsidian_write_note", arguments: { path: options.notePath, content: "must not write" },
      });
      assert.equal(write.isError, true);
      const unchanged = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
      assert.notEqual(unchanged.isError, true);
      assert.ok(JSON.stringify(unchanged).includes(options.expectedContent), "Denied write must not modify the note");
    } finally {
      await client.close();
    }
  }
  await checkTools(tokens.access_token);
  for (const route of [
    "/login", "/consent", "/admin", "/owner-state", "/api/auth/sign-in/email",
    "/api/auth/get-session", "/api/auth/revoke-sessions", "/api/auth/change-password",
    "/oauth/grants", "/oauth/grants/revoke", "/oauth/consent",
  ]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${publicOrigin}${route}`, {
        method, redirect: "manual",
        headers: {
          authorization: `Bearer ${tokens.access_token}`, cookie, origin: publicOrigin,
          "x-vaultbridge-csrf": "1", "content-type": "application/json",
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(response.status, 404, `Private route ${method} ${route} with valid credentials`);
      await response.arrayBuffer();
    }
  }
  const refreshResponse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json() as TokenResponse;
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  await checkTools(refreshed.access_token);
  await ownerPost("/oauth/grants/revoke", { grantId: grant.grantId });
  for (const accessToken of [tokens.access_token, refreshed.access_token]) {
    const revoked = await fetch(resource, {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    assert.equal(revoked.status, 403, "Revoked grant must invalidate all access tokens");
  }
  console.log("  ✓ Native client: PKCE → scoped MCP read/deny → refresh rotation → grant revocation");
}
