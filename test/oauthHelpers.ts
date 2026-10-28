import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";

import { startOwnerServer } from "../src/auth/http.js";
import { startHttpServer } from "../src/http.js";
import { createTempVault, makeConfig } from "./helpers.js";
import type { AppConfig } from "../src/types.js";

export const clientA = "https://client-a.example/metadata.json";
export const clientB = "https://client-b.example/metadata.json";
export const redirectUri = "http://127.0.0.1:49152/callback";
export const password = "disposable-oauth-owner-password";

export async function oauthHarness(overrides: Partial<AppConfig> = {}) {
  const vault = await createTempVault();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-oauth-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-oauth-cache-"));
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    const bootstrap = await startOwnerServer({ directory, vaultPath: vault, port: 0 });
    try {
      const token = await fs.readFile(bootstrap.tokenPath!, "utf8");
      expect(await bootstrap.owner.enroll({ email: "owner@example.test", password }, token)).toBe(true);
    } finally { await bootstrap.close(); }
    // Reserve an OS-selected port so the canonical issuer is known at startup.
    const reservation = http.createServer();
    await new Promise<void>((resolve) => { reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Expected port");
    await new Promise<void>((resolve) => { reservation.close(() => { resolve(); }); });
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const config = makeConfig({
      vaultPath: vault, cacheDir: cache, mcpTransport: "http",
      mcpHttpPort: address.port, mcpAuthMode: "oauth", mcpOauthEnabled: true,
      mcpOauthIssuer: `${origin}/api/auth`, mcpAuthDirectory: directory,
      mcpVaultId: "test-vault", mcpOwnerPort: 0, mcpAllowedHosts: ["127.0.0.1"],
      ...overrides,
    });
    server = await startHttpServer(config);
    const ownerOrigin = server.ownerOrigin!;
    async function post(endpoint: string, body: unknown, cookie = "") {
      return fetch(`${ownerOrigin}${endpoint}`, {
        method: "POST", redirect: "manual", headers: {
          "content-type": "application/json", "x-vaultbridge-csrf": "1", origin: ownerOrigin, cookie,
        }, body: JSON.stringify(body),
      });
    }
    const login = await post("/api/auth/sign-in/email", { email: "owner@example.test", password });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).not.toBe("");
    async function form(endpoint: string, body: Record<string, string>, clientId = clientA) {
      return fetch(`${origin}/api/auth/oauth2/${endpoint}`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, ...body }),
      });
    }
    async function begin(clientId = clientA, scope = "vault:read offline_access", changes: Record<string, string> = {}) {
      const verifier = randomBytes(32).toString("base64url");
      const params = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope,
        resource: `${origin}/mcp`, state: randomBytes(24).toString("base64url"), prompt: "consent",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", ...changes,
      });
      const response = await fetch(`${origin}/api/auth/oauth2/authorize?${params}`, {
        headers: { accept: "application/json" }, redirect: "manual",
      });
      const body = await response.json() as { url?: string };
      return { response, body, verifier, state: params.get("state") };
    }
    async function consent(clientId = clientA, scope = "vault:read offline_access") {
      const initial = await begin(clientId, scope);
      expect(initial.response.status).toBe(200);
      const loginURL = new URL(initial.body.url!);
      expect(loginURL.origin).toBe(ownerOrigin);
      expect(loginURL.pathname).toBe("/login");
      const resumed = await post("/oauth/authorize", { oauth_query: loginURL.search.slice(1) }, cookie);
      expect(resumed.status).toBe(200);
      const consentURL = new URL((await resumed.json() as { url: string }).url, ownerOrigin);
      expect(consentURL.pathname).toBe("/consent");
      return { ...initial, query: consentURL.search.slice(1) };
    }
    async function grant(clientId = clientA, scope = "vault:read offline_access") {
      const pending = await consent(clientId, scope);
      const approved = await post("/oauth/consent", { oauth_query: pending.query, accept: true }, cookie);
      expect(approved.status).toBe(200);
      const callback = new URL((await approved.json() as { url: string }).url);
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get("state")).toBe(pending.state);
      expect(callback.searchParams.get("iss")).toBe(`${origin}/api/auth`);
      return { verifier: pending.verifier, code: callback.searchParams.get("code")! };
    }
    async function exchange(code: { code: string; verifier: string }, clientId = clientA) {
      const result = await form("token", {
        grant_type: "authorization_code", code: code.code, code_verifier: code.verifier,
        redirect_uri: redirectUri, resource: `${origin}/mcp`,
      }, clientId);
      expect(result.status).toBe(200);
      return await result.json() as { access_token: string; refresh_token: string; scope: string };
    }
    return {
      vault, directory, config, origin, ownerOrigin, cookie, post, form, begin, consent, grant, exchange,
      async close() {
        if (server) {
          await new Promise<void>((resolve) => { server!.close(() => { resolve(); }); server!.closeIdleConnections(); });
          await server.closed;
        }
        await Promise.all([vault, directory, cache].map((file) => fs.rm(file, { recursive: true, force: true })));
      },
    };
  } catch (error) {
    if (server) { server.close(); await server.closed; }
    await Promise.all([vault, directory, cache].map((file) => fs.rm(file, { recursive: true, force: true })));
    throw error;
  }
}
