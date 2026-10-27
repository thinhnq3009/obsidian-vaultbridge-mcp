#!/usr/bin/env node
/**
 * AUTH-003 prerequisite/security-contract probe, NOT a production OAuth server.
 *
 * Uses only disposable identity data and a literal-loopback listener. CIMD uses
 * a deterministic fixture transport; this is not a metadata-network/SSRF test.
 * No token, password, cookie, authorization code or real vault data is printed.
 *
 * Exit 1 means the requested revocation contract is NOT met, even if the other
 * flow assertions pass. Do not add this as a passing release/CI smoke by
 * catching its exit code. It is intentionally separate from AUTH-001's smoke.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { MemoryStore, rateLimit } from "express-rate-limit";
import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { createResourceServerChallenge, getOAuthProviderApi } from "@better-auth/oauth-provider";
import { createMcpProtectedRequestHandler, mcp, requireMcpAuth } from "@better-auth/mcp";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { z } from "zod";

const directory = await mkdtemp(path.join(tmpdir(), "vaultbridge-auth-003-"));
const database = new DatabaseSync(path.join(directory, "auth.sqlite"));
database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
const limiterStore = new MemoryStore();
const clientId = "https://auth003-client.example/metadata.json";
const redirectUri = "http://127.0.0.1:49152/callback";
const failures = [];
const localOpaque = process.argv.includes("--opaque-local");
const opaque = localOpaque || process.argv.includes("--opaque");
const versionOf = (name) => JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve(name)), "utf8")).version;
const versions = {
  betterAuth: versionOf("better-auth"), mcp: versionOf("@better-auth/mcp"),
  cimd: versionOf("@better-auth/cimd"), oauthProvider: versionOf("@better-auth/oauth-provider"),
  sdk: versionOf("@modelcontextprotocol/server"),
};
let listener;
let mcpHandler;

try {
  let auth;
  let baseURL;
  let resource;
  let introspectionClient;
  function fetchLocal(input, init = {}) {
    const url = new URL(input);
    assert.equal(url.origin, baseURL, "Probe requests must stay on the disposable loopback listener");
    assert.ok(!url.username && !url.password, "No credentials in request URLs");
    return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((request, response, next) => {
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
      || request.headers.host !== new URL(baseURL).host) {
      response.sendStatus(403);
      return;
    }
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(rateLimit({
    windowMs: 60_000, limit: 240, keyGenerator: () => "disposable-loopback-probe",
    store: limiterStore, standardHeaders: "draft-8", legacyHeaders: false,
  }));
  app.use(express.json({ limit: "8kb", inflate: false }));
  app.use(express.urlencoded({ limit: "8kb", extended: false, inflate: false }));
  function webRequest(request) {
    const headers = new Headers();
    for (const name of ["cookie", "authorization", "origin", "accept", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    headers.set("x-vaultbridge-peer-ip", request.socket.remoteAddress);
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const body = !hasBody ? undefined
      : headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
        ? new URLSearchParams(request.body).toString() : JSON.stringify(request.body);
    return new Request(new URL(request.originalUrl, baseURL), {
      method: request.method, headers, ...(hasBody ? { body } : {}),
    });
  }
  async function send(result, response) {
    response.status(result.status);
    result.headers.forEach((value, name) => {
      if (name !== "set-cookie") response.setHeader(name, value);
    });
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader("Set-Cookie", cookies);
    if (result.status === 429) response.setHeader("Retry-After", result.headers.get("x-retry-after") ?? "60");
    response.send(Buffer.from(await result.arrayBuffer()));
  }
  mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: "auth-003-disposable-probe", version: "0.0.0" });
    server.registerTool("probe_ping", { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  }, { legacy: "reject" });
  async function protect(request, handler, options = {}) {
    if (!opaque) return requireMcpAuth(auth, handler, { resource, ...options })(request);
    if (localOpaque) {
      // A second, documented integration seam. The provider owns token lookup,
      // active/session/client checks and expiry; the resource server checks its
      // own required issuer/audience/scopes. No minting or revocation is added.
      try {
        const token = /^Bearer ([A-Za-z0-9_-]{1,8192})$/u.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!token) throw new APIError("UNAUTHORIZED", { message: "Invalid access token" });
        const claims = await auth.api.probeActiveAccessToken({ body: { token } });
        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (claims.iss !== (options.issuer ?? (await auth.$context).baseURL)
          || !audience.includes(options.resource ?? resource)
          || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000
          || typeof claims.sub !== "string" || typeof claims.azp !== "string"
          || claims.cnf !== undefined) {
          throw new APIError("UNAUTHORIZED", { message: "Invalid access token" });
        }
        const scopes = new Set(typeof claims.scope === "string" ? claims.scope.split(" ") : []);
        const missingScopes = (options.requiredScopes ?? []).filter((scope) => !scopes.has(scope));
        if (missingScopes.length) throw createInsufficientScopeError(missingScopes);
        return handler(request, claims);
      } catch (error) {
        if (!isAPIError(error)) throw error;
        const challenge = createResourceServerChallenge(error, resource);
        if (!challenge) throw error;
        return Response.json({ error: "Access denied" }, { status: challenge.statusCode, headers: challenge.headers });
      }
    }
    // Official MCP middleware + official RFC 7662 endpoint, not a custom token
    // validator. The confidential resource client is created via the provider's
    // server-only API, never through an exposed registration/admin route.
    return createMcpProtectedRequestHandler({
      issuer: options.issuer ?? (await auth.$context).baseURL,
      audience: options.resource ?? resource,
      requiredScopes: options.requiredScopes,
      remoteVerify: {
        introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
        clientId: introspectionClient.client_id,
        clientSecret: introspectionClient.client_secret,
        force: true,
      },
    }, handler)(request);
  }
  app.post("/mcp", async (request, response) => {
    const result = await protect(webRequest(request), (verified) => mcpHandler.fetch(verified), {
      requiredScopes: ["mcp:tools"],
    });
    await send(result, response);
  });
  if (opaque) {
    app.post("/negative/jwt-only", async (request, response) => {
      await send(await requireMcpAuth(auth, () => Response.json({ unexpected: true }), { resource })(webRequest(request)), response);
    });
  }
  // Exercise the same maintained verifier with deliberately wrong expectations.
  for (const [suffix, verification] of [
    ["wrong-audience", { resource: "https://other-resource.example/mcp" }],
    ["wrong-issuer", { issuer: "https://other-issuer.example/api/auth" }],
    ["wrong-scope", { requiredScopes: ["mcp:admin"] }],
  ]) {
    app.post(`/negative/${suffix}`, async (request, response) => {
      await send(await protect(webRequest(request), () => Response.json({ unexpected: true }), verification), response);
    });
  }
  // Only library routes needed by this isolated probe; no public signup/admin.
  const providerPaths = new Set([
    "/.well-known/oauth-protected-resource/mcp",
    "/api/auth/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/jwks", "/api/auth/sign-in/email", "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/consent", "/api/auth/oauth2/token", "/api/auth/oauth2/revoke",
  ]);
  if (opaque) providerPaths.add("/api/auth/oauth2/introspect");
  app.use(async (request, response) => {
    if (!providerPaths.has(request.path)) { response.sendStatus(404); return; }
    await send(await auth.handler(webRequest(request)), response);
  });
  app.use((_error, _request, response, _next) => {
    response.status(500).json({ error: "Disposable probe request failed" });
  });
  listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  baseURL = `http://127.0.0.1:${address.port}`;
  resource = `${baseURL}/mcp`;
  const provider = mcp({
    loginPage: "/login", consentPage: "/consent", resource,
    scopes: ["mcp:tools", "offline_access"],
    grantTypes: ["authorization_code", "refresh_token"],
    codeExpiresIn: 60, accessTokenExpiresIn: 300,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    disableJwtPlugin: opaque,
  });
  auth = betterAuth({
    appName: "AUTH-003 disposable prerequisite probe",
    baseURL, secret: randomBytes(48).toString("base64url"), database,
    logger: { disabled: true },
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: { ipAddress: { ipAddressHeaders: ["x-vaultbridge-peer-ip"] } },
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 60 },
    plugins: [
      jwt(),
      provider,
      cimd({
        metadataProfile: "mcp-2026-07-28",
        async fetchClientMetadataResource(input) {
          // Deliberately no network call. Production must use the Node SSRF-safe
          // transport; accepting this fixture transport there would be unsafe.
          assert.equal(String(input), clientId);
          return Response.json({
            client_id: clientId, client_name: "AUTH-003 fixture",
            redirect_uris: [redirectUri], application_type: "native",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"], token_endpoint_auth_method: "none",
          });
        },
      }),
      ...(localOpaque ? [{
        id: "auth-003-read-only-provider-probe",
        endpoints: {
          probeActiveAccessToken: createAuthEndpoint("/probe/active-access-token", {
            method: "POST", body: z.object({ token: z.string().max(8192) }),
            metadata: { SERVER_ONLY: true },
          }, async (ctx) => getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken(ctx.body.token)),
        },
      }] : []),
    ],
  });
  const context = await auth.$context;
  await context.runMigrations();
  // A disposable test identity, not an application bootstrap or sign-up route.
  const email = "auth003@example.test";
  const password = randomBytes(32).toString("base64url");
  const user = await context.internalAdapter.createUser({ email, name: "Probe", emailVerified: false });
  await context.internalAdapter.linkAccount({
    userId: user.id, providerId: "credential", accountId: user.id,
    password: await context.password.hash(password),
  });
  async function jsonPost(endpoint, body, cookie) {
    return fetchLocal(`${baseURL}${endpoint}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", origin: baseURL, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }
  async function formPost(endpoint, body) {
    return fetchLocal(`${baseURL}/api/auth/oauth2/${endpoint}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, ...body }),
    });
  }
  const login = await jsonPost("/api/auth/sign-in/email", { email, password });
  assert.equal(login.status, 200, "Disposable owner login");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie.length > 0, "Login must issue a browser session cookie");
  if (opaque && !localOpaque) {
    introspectionClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: baseURL }),
      body: {
        client_name: "Disposable resource-server introspection client",
        redirect_uris: ["https://auth003-resource.example/callback"],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:tools offline_access", resources: [resource],
      },
    });
    assert.equal(typeof introspectionClient.client_secret, "string", "Confidential introspection client required");
  }
  const metadataResponse = await fetchLocal(`${baseURL}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.resource, resource);
  const discovery = await fetchLocal(`${metadata.authorization_servers[0]}/.well-known/oauth-authorization-server`);
  assert.equal(discovery.status, 200);
  const asMetadata = await discovery.json();
  assert.equal(asMetadata.client_id_metadata_document_supported, true);
  assert.ok(!asMetadata.registration_endpoint, "DCR must not be advertised");
  const authorizeParameters = () => new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri,
    response_type: "code", scope: "mcp:tools offline_access",
    resource, state: randomBytes(24).toString("base64url"), prompt: "consent",
    code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
    code_challenge_method: "S256",
  });
  async function authorize(params) {
    return fetchLocal(`${asMetadata.authorization_endpoint}?${params}`, {
      headers: { cookie, accept: "application/json" }, redirect: "manual",
    });
  }
  async function expectAuthorizationDenied(change, label) {
    const params = authorizeParameters();
    change(params);
    const response = await authorize(params);
    assert.notEqual(response.status, 429, `${label}: probe must not hit rate limits`);
    if (response.status >= 400 && response.status < 500) return;
    const body = await response.json();
    const destination = new URL(body.url, baseURL);
    assert.ok(destination.searchParams.has("error"), label);
    assert.ok(!destination.searchParams.has("code"), label);
    assert.ok(!["/login", "/consent"].includes(destination.pathname), label);
  }
  await expectAuthorizationDenied((params) => params.delete("code_challenge"), "Missing PKCE rejected");
  await expectAuthorizationDenied((params) => params.set("code_challenge_method", "plain"), "Weak PKCE rejected");
  await expectAuthorizationDenied((params) => params.set("redirect_uri", "https://unregistered.example/callback"), "Unregistered redirect rejected");
  await expectAuthorizationDenied((params) => params.set("resource", "https://other-resource.example/mcp"), "Wrong resource rejected");

  async function grant() {
    const verifier = randomBytes(32).toString("base64url");
    const params = authorizeParameters();
    const state = params.get("state");
    params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    const authorization = await authorize(params);
    assert.equal(authorization.status, 200, "Authorization must produce a consent URL");
    const authorizationBody = await authorization.json();
    const consentURL = new URL(authorizationBody.url, baseURL);
    assert.equal(consentURL.pathname, "/consent");
    const signedQuery = consentURL.search.slice(1);
    // State tampering in the signed provider query must fail before consent.
    const tamperedQuery = new URLSearchParams(signedQuery);
    tamperedQuery.set("state", "attacker-state");
    const rejectedConsent = await jsonPost("/api/auth/oauth2/consent", {
      accept: true, oauth_query: tamperedQuery.toString(),
    }, cookie);
    assert.ok([400, 401].includes(rejectedConsent.status), "Tampered consent state rejected");
    const consent = await jsonPost("/api/auth/oauth2/consent", { accept: true, oauth_query: signedQuery }, cookie);
    assert.equal(consent.status, 200, "Consent must produce an authorization code");
    const consentBody = await consent.json();
    const callback = new URL(consentBody.url);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), state);
    assert.equal(callback.searchParams.get("iss"), asMetadata.issuer);
    const code = callback.searchParams.get("code");
    assert.ok(code, "Authorization code required");
    return { code, verifier };
  }
  async function exchange({ code, verifier }) {
    const result = await formPost("token", {
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: redirectUri, resource,
    });
    assert.equal(result.status, 200, "Authorization code + S256 exchange");
    const tokens = await result.json();
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(typeof tokens.refresh_token, "string");
    assert.equal(tokens.token_type, "Bearer");
    return tokens;
  }
  async function tool(accessToken) {
    return fetchLocal(resource, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call", "mcp-name": "probe_ping",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "probe_ping", arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "auth003-generic-client", version: "0.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
  }
  const missing = await tool();
  assert.equal(missing.status, 401, "Missing bearer must be challenged");
  assert.match(missing.headers.get("www-authenticate"), /resource_metadata=/u);
  const invalid = await tool("invalid");
  if (opaque && invalid.status !== 401) failures.push({
    contract: "Opaque invalid bearer gets a discovery challenge",
    expectedStatus: 401, actualStatus: invalid.status,
  });
  else assert.equal(invalid.status, 401, "Invalid bearer must be challenged");
  const tokens = await exchange(await grant());
  if (opaque) assert.ok(!tokens.access_token.includes("."), "Provider must issue opaque access tokens");
  if (localOpaque) {
    const internalEndpoint = await jsonPost("/api/auth/probe/active-access-token", { token: "invalid" });
    assert.equal(internalEndpoint.status, 404, "Server-only active-token capability must never be mounted publicly");
  }
  const accepted = await tool(tokens.access_token);
  assert.equal(accepted.status, 200, "Fresh access token must reach SDK v2");
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.result?.content?.[0]?.text, "pong", "Actual generic MCP tool invocation");
  if (opaque) {
    const jwtOnly = await fetchLocal(`${baseURL}/negative/jwt-only`, {
      method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(jwtOnly.status, 401, "JWT-only requireMcpAuth must not accept an opaque token");
  }
  for (const [suffix, status] of [["wrong-audience", 401], ["wrong-issuer", 401], ["wrong-scope", 403]]) {
    const rejected = await fetchLocal(`${baseURL}/negative/${suffix}`, {
      method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (opaque && rejected.status !== status) failures.push({
      contract: `Opaque ${suffix} rejection challenge`,
      expectedStatus: status, actualStatus: rejected.status,
    });
    else {
      assert.equal(rejected.status, status, `${suffix} denied by maintained verifier`);
      assert.match(rejected.headers.get("www-authenticate"), /resource_metadata=/u);
    }
  }
  const refresh = await formPost("token", {
    grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource,
  });
  assert.equal(refresh.status, 200, "Refresh rotation");
  const rotated = await refresh.json();
  assert.ok(rotated.refresh_token !== tokens.refresh_token, "Refresh token must rotate");
  const revokeAccess = await formPost("revoke", { token: rotated.access_token, token_type_hint: "access_token" });
  const revokeAccessBody = revokeAccess.status === 200 ? {} : await revokeAccess.json();
  if (revokeAccess.status !== 200) failures.push({
    contract: `${opaque ? "Opaque" : "JWT"} access-token revocation`,
    expectedStatus: 200, actualStatus: revokeAccess.status,
    error: revokeAccessBody.error,
    description: revokeAccessBody.error_description,
  });
  if (opaque) assert.equal((await tool(rotated.access_token)).status, 401, "Revoked opaque access token immediately denied");
  // Mint a fresh child before refresh revocation, so the earlier direct-access
  // revocation cannot make this independent refresh test pass accidentally.
  const secondRefresh = await formPost("token", {
    grant_type: "refresh_token", refresh_token: rotated.refresh_token, resource,
  });
  assert.equal(secondRefresh.status, 200, "Second rotation must mint a fresh access credential");
  const current = await secondRefresh.json();
  assert.equal((await tool(current.access_token)).status, 200, "Current family access starts active");
  const revokeRefresh = await formPost("revoke", { token: current.refresh_token, token_type_hint: "refresh_token" });
  assert.equal(revokeRefresh.status, 200, "Refresh token revocation");
  const afterRevocation = await tool(current.access_token);
  if (afterRevocation.status !== 401) {
    if (afterRevocation.status === 200) {
      assert.equal((await afterRevocation.json()).result?.content?.[0]?.text, "pong", "Revocation failure must demonstrate an actual tool call");
    }
    failures.push({
      contract: "Access token rejected after refresh-family revocation",
      expectedStatus: 401, actualStatus: afterRevocation.status,
    });
  }
  if (opaque) {
    for (const denied of await Promise.all(Array.from({ length: 3 }, () => tool(current.access_token)))) {
      assert.equal(denied.status, 401, "Concurrent calls with a revoked child credential denied");
    }
  }
  // A refresh family includes credentials issued before rotation, not just the
  // access token attached to the latest refresh row. Do not let direct access
  // revocation above mask this independent grant/family check.
  if (opaque) {
    const earlierCalls = await Promise.all(Array.from({ length: 3 }, () => tool(tokens.access_token)));
    for (const earlierAccess of earlierCalls) {
      if (earlierAccess.status === 200) assert.equal((await earlierAccess.json()).result?.content?.[0]?.text, "pong", "Earlier family access really reaches the tool");
    }
    const unexpected = earlierCalls.find((response) => response.status !== 401);
    if (unexpected) {
      failures.push({
        contract: "Pre-rotation access token rejected immediately after refresh-family revocation",
        expectedStatus: 401, actualStatus: unexpected.status,
        acceptedConcurrentToolCalls: earlierCalls.filter((response) => response.status === 200).length,
      });
    }
  }
  const revokedRefresh = await formPost("token", {
    grant_type: "refresh_token", refresh_token: current.refresh_token, resource,
  });
  assert.equal(revokedRefresh.status, 400, "Revoked refresh denied, not rate limited");
  // Separate grant: reuse detection must invalidate a still-live child, not
  // merely return an error for a family a previous revocation already removed.
  const reuseTokens = await exchange(await grant());
  const reuseRotation = await formPost("token", {
    grant_type: "refresh_token", refresh_token: reuseTokens.refresh_token, resource,
  });
  assert.equal(reuseRotation.status, 200, "Independent reuse family rotation");
  const reuseChild = await reuseRotation.json();
  assert.equal((await tool(reuseChild.access_token)).status, 200, "Reuse family child starts active");
  const reuse = await formPost("token", {
    grant_type: "refresh_token", refresh_token: reuseTokens.refresh_token, resource,
  });
  assert.equal(reuse.status, 400, "Rotated refresh reuse denied, not rate limited");
  const afterReuse = await tool(reuseChild.access_token);
  if (afterReuse.status !== 401) {
    if (afterReuse.status === 200) {
      assert.equal((await afterReuse.json()).result?.content?.[0]?.text, "pong", "Refresh reuse failure must demonstrate an actual tool call");
    }
    failures.push({
      contract: "Live child access token rejected after refresh reuse detection",
      expectedStatus: 401, actualStatus: afterReuse.status,
    });
  }
  const refreshAfterReuse = await formPost("token", {
    grant_type: "refresh_token", refresh_token: reuseChild.refresh_token, resource,
  });
  assert.equal(refreshAfterReuse.status, 400, "Reuse detection invalidates the live refresh child");
  const badVerifierGrant = await grant();
  const badVerifier = await formPost("token", {
    grant_type: "authorization_code", code: badVerifierGrant.code,
    code_verifier: randomBytes(32).toString("base64url"), redirect_uri: redirectUri, resource,
  });
  assert.equal(badVerifier.status, 400, "Wrong PKCE verifier denied");
  const badRedirectGrant = await grant();
  const badRedirect = await formPost("token", {
    grant_type: "authorization_code", code: badRedirectGrant.code,
    code_verifier: badRedirectGrant.verifier, redirect_uri: `${redirectUri}/wrong`, resource,
  });
  assert.equal(badRedirect.status, 400, "Mismatched token redirect denied");
  const replayGrant = await grant();
  await exchange(replayGrant);
  const replay = await formPost("token", {
    grant_type: "authorization_code", code: replayGrant.code,
    code_verifier: replayGrant.verifier, redirect_uri: redirectUri, resource,
  });
  assert.equal(replay.status, 400, "Consumed authorization code denied");
  const expiredGrant = await grant();
  // Move only the disposable provider-owned authorization-code row's expiry
  // into the past. This is a test fault injection, never an application migration.
  database.prepare("UPDATE verification SET expiresAt = ? WHERE value LIKE ?")
    .run(Date.now() - 60_000, '%"type":"authorization_code"%');
  const expired = await formPost("token", {
    grant_type: "authorization_code", code: expiredGrant.code,
    code_verifier: expiredGrant.verifier, redirect_uri: redirectUri, resource,
  });
  assert.equal(expired.status, 400, "Expired authorization code denied");
  if (opaque) {
    const expiringAccess = await exchange(await grant());
    // Disposable fault injection. Verification still goes through the provider
    // APIs and never accepts expired credentials or bypasses the normal flow.
    database.prepare("UPDATE oauthAccessToken SET expiresAt = ? WHERE clientId = ?")
      .run(Date.now() - 60_000, clientId);
    assert.equal((await tool(expiringAccess.access_token)).status, 401, "Expired opaque access token denied");
  }
  process.stdout.write(`${JSON.stringify({
    task: "AUTH-003", status: failures.length ? "BLOCKED" : "PASS", node: process.version,
    tokenFormat: opaque ? "opaque" : "jwt",
    verifier: localOpaque ? "getOAuthProviderApi.requireActiveAccessToken + resource policy"
      : opaque ? "createMcpProtectedRequestHandler + forced provider introspection" : "requireMcpAuth",
    ...versions,
    isolated: true, productionIntegrated: false, cimdTransport: "fixture, no remote network",
    exercised: [
      "temporary SQLite + provider migrations", "password login",
      "RFC 9728 and authorization-server discovery", "CIMD profile, DCR disabled",
      "signed consent query/state tampering denied", "S256 code exchange",
      "missing/plain PKCE denied", "wrong authorization resource/redirect denied",
      "wrong verifier and token redirect denied", "consumed/expired code denied",
      "missing/invalid bearer challenge", "generic SDK v2 tool invocation",
      "wrong issuer/audience/scope denied",
      "refresh rotation", "revoked refresh denied", "rotated refresh reuse denied",
      ...(opaque ? ["JWT-only middleware rejects opaque tokens", "immediate opaque access revocation", "concurrent revoked-child calls denied", "opaque access expiry denied"] : []),
    ],
    failures,
  }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} catch (error) {
  // Assertions and network errors may contain credentials. Never serialize them.
  const assertion = error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Setup or transport error";
  process.stderr.write(`AUTH-003 prerequisite probe did not reach its revocation assertions: ${assertion}\n`);
  process.exitCode = 2;
} finally {
  if (listener) await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  await mcpHandler?.close();
  limiterStore.shutdown();
  database.close();
  await rm(directory, { recursive: true, force: true });
}
