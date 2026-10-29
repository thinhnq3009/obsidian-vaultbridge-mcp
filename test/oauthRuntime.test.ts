import { afterEach, describe, expect, it, vi } from "vitest";

import { validateHttpDeployment } from "../src/config.js";
import { RequestBudgets } from "../src/auth/budgets.js";
import { makeConfig } from "./helpers.js";
import { clientA, clientB, oauthHarness, redirectUri } from "./oauthHelpers.js";

// Substitute only remote CIMD network IO. Auth, SQLite, HTTP, login, PKCE,
// consent, opaque access/refresh/revoke and verifier are the production code.
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL) => {
    const clientId = String(input);
    if (!["https://client-a.example/metadata.json", "https://client-b.example/metadata.json"].includes(clientId)) throw new Error("Unrecognized fixture client");
    return Promise.resolve(Response.json({
      client_id: clientId, client_name: "Disposable test client",
      redirect_uris: ["http://127.0.0.1:49152/callback"], application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    }));
  },
}));

const running: Awaited<ReturnType<typeof oauthHarness>>[] = [];
async function setup(overrides: Parameters<typeof oauthHarness>[0] = {}) {
  const harness = await oauthHarness(overrides); running.push(harness); return harness;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of running.splice(0)) await harness.close();
});

describe("experimental production Better Auth OAuth runtime", () => {
  it("limits provider routes before parsing/authentication without consuming MCP client capacity", async () => {
    const h = await setup({ mcpOauthEndpointRpm: 4 });
    const token = await h.exchange(await h.grant());
    expect((await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    expect((await fetch(`${h.origin}/api/auth/.well-known/oauth-authorization-server`)).status).toBe(200);
    // Four admitted requests: public authorize, token, and two discovery GETs.
    // Malformed JSON must be rejected by admission, not parsed or sent to auth.
    for (const endpoint of ["token", "revoke", "authorize"]) {
      const rejected = await fetch(`${h.origin}/api/auth/oauth2/${endpoint}`, {
        method: "POST", headers: {
          "content-type": "application/json", "x-forwarded-for": `198.51.100.${endpoint.length}`,
          "x-real-ip": "203.0.113.1", "x-client-id": endpoint,
        }, body: "{",
      });
      expect(rejected.status).toBe(429);
      expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await rejected.json()).toEqual({ error: "OAuth endpoint budget exceeded" });
    }
    const flood = await Promise.all(Array.from({ length: 8 }, () =>
      fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)));
    expect(flood.every((response) => response.status === 429)).toBe(true);
    // OAuth admission must never cap verified MCP calls or owner management.
    expect((await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).status).toBe(403);
    expect((await fetch(`${h.origin}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${h.ownerOrigin}/api/auth/get-session`, { headers: { cookie: h.cookie } })).status).toBe(200);
  });
  it("requires explicit opt-in and unambiguous safe deployment configuration", () => {
    const base = makeConfig({ mcpAuthMode: "oauth" });
    expect(() => validateHttpDeployment(base)).toThrow(/default-off/);
    expect(() => validateHttpDeployment({ ...base, mcpOauthEnabled: true })).toThrow(/MCP_VAULT_ID/);
    expect(() => validateHttpDeployment(makeConfig({ mcpAuthMode: "none", mcpAuthToken: "x" }))).toThrow(/combined/);
    expect(() => validateHttpDeployment(makeConfig({ mcpAuthMode: "token" }))).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => validateHttpDeployment(makeConfig({ mcpAuthMode: "none", mcpHttpHost: "0.0.0.0", mcpHttpTlsProxy: true, mcpAllowedHosts: ["example.com"] }))).toThrow(/ACK|MCP_ALLOW/);
  });

  it("discovers CIMD/PKCE, rejects anonymous/forged credentials and keeps admin private", async () => {
    const h = await setup();
    const metadata = await (await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
    expect(metadata.resource).toBe(`${h.origin}/mcp`);
    const discovery = await (await fetch(`${metadata.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(discovery.client_id_metadata_document_supported).toBe(true);
    expect(discovery.registration_endpoint).toBeUndefined();
    expect(discovery.code_challenge_methods_supported).toContain("S256");
    for (const token of ["", "Bearer fake-token-0000000000", "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.", "Basic garbage"]) {
      const response = await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: "{" });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
    for (const route of ["/api/auth/sign-up/email", "/api/auth/get-session", "/api/auth/vaultbridge/verify-access", "/api/auth/oauth2/register", "/api/auth/oauth2/consent"]) {
      expect((await fetch(`${h.origin}${route}`, { method: "POST", headers: { "content-type": "application/json", cookie: h.cookie }, body: "{}" })).status).toBe(404);
    }
    expect((await h.post("/oauth/consent", { oauth_query: "forged", accept: true })).status).toBe(401);
    expect((await fetch(`${h.ownerOrigin}/api/auth/get-session`, { headers: { cookie: h.cookie, origin: "https://attacker.example" } })).status).toBe(403);
  });

  it("completes owner login, signed consent, single-use S256, rotation and current-access revocation", async () => {
    const h = await setup();
    const code = await h.grant();
    const token = await h.exchange(code);
    expect(typeof token.refresh_token).toBe("string");
    const protectedRequest = (access: string) => fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access}` } });
    // Runtime prerequisite has no Phase B grant bridge: verified != authorized.
    expect((await protectedRequest(token.access_token)).status).toBe(403);
    const rotatedResponse = await h.form("token", { grant_type: "refresh_token", refresh_token: token.refresh_token, resource: `${h.origin}/mcp` });
    expect(rotatedResponse.status, rotatedResponse.ok ? "" : await rotatedResponse.text()).toBe(200);
    const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    expect((await protectedRequest(rotated.access_token)).status).toBe(403);
    expect((await h.form("revoke", { token: rotated.access_token, token_type_hint: "access_token" })).status).toBe(200);
    expect((await protectedRequest(rotated.access_token)).status).toBe(401);
    // Replay handling may revoke the underlying owner session too; do this
    // after the positive lifecycle rather than pretending it is read-only.
    expect((await h.form("token", { grant_type: "authorization_code", code: code.code, code_verifier: code.verifier, redirect_uri: redirectUri, resource: `${h.origin}/mcp` })).status).toBe(400);
    // No assertion that old/current/descendant FAMILY invalidation works (#60).
  });

  it("rejects tampered consent, wrong PKCE/redirect/resource/client and weak PKCE", async () => {
    const h = await setup();
    const pending = await h.consent();
    const tampered = new URLSearchParams(pending.query); tampered.set("state", "tampered");
    expect((await h.post("/oauth/consent", { oauth_query: tampered.toString(), accept: true }, h.cookie)).status).toBe(400);
    const code = await h.grant();
    for (const changed of [
      { code_verifier: "incorrect-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      { redirect_uri: "http://127.0.0.1:49152/wrong" },
      { resource: "https://other-resource.example/mcp" },
      { client_id: clientB },
    ]) {
      const response = await h.form("token", {
        grant_type: "authorization_code", code: code.code, code_verifier: code.verifier,
        redirect_uri: redirectUri, resource: `${h.origin}/mcp`, ...changed,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    const weak = await h.begin(clientA, "vault:read", { code_challenge_method: "plain" });
    expect(JSON.stringify(weak.body)).not.toContain("/login?");
    expect(JSON.stringify(weak.body)).not.toContain("/consent?");
  });

  it("separates verified-client budgets from invalid attempts and returns Retry-After", async () => {
    const h = await setup({ mcpAuthenticatedClientRpm: 2 });
    const a = await h.exchange(await h.grant(clientA));
    const b = await h.exchange(await h.grant(clientB), clientB);
    const send = (token: string) => fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-client-id": clientB } });
    expect((await send(a.access_token)).status).toBe(403);
    expect((await send(a.access_token)).status).toBe(403);
    const limited = await send(a.access_token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await send(b.access_token)).status).toBe(403);
  });

  it("bounds bucket memory and refills without accepting spoofable identities", () => {
    const b = new RequestBudgets();
    expect(b.take("global", 1)).toBe(true);
    expect(b.take("global", 1)).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
    expect(b.take("global", 1)).toBe(true);
    for (let i = 0; i < 4095; i++) expect(b.take(String(i), 1)).toBe(true);
    expect(b.take("overflow", 1)).toBe(false);
  });
});
