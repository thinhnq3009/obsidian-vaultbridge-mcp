import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { z } from "zod";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

import { LoginBudget } from "./loginBudget.js";
import { oauthPlugins, principalVerifier, type OAuthProviderOptions } from "./oauth.js";
import { migrateOwnerSchema, openAuthStorage } from "./storage.js";
import { SqliteGrantStore, vaultGrantSchema } from "./grants.js";
import { createVerifiedAuthContext, authorizationDenied } from "./requestContext.js";
import { assertVerifiedPrincipal, type VerifiedPrincipal } from "./oauth.js";
import { createRequestBackend } from "../backend/authorized.js";
import type { VaultBackend } from "../backend/types.js";

const DEFAULT_USERNAME = "obsidian-admin";
const DEFAULT_PASSWORD = "admin39145";
const usernameSchema = z.string().min(3).max(64).regex(/^[a-z][a-z0-9._-]*$/u);
function strongPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 128
    && [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^a-zA-Z0-9]/u].filter((pattern) => pattern.test(password)).length >= 3;
}
const recoveryPassword = z.object({ password: z.string().min(12).max(128).refine((value) => strongPassword(value) && value !== DEFAULT_PASSWORD) }).strict();

export async function createOwnerAuth(options: { directory: string; vaultPath: string; origin: string; ownerUsername?: string; ownerPassword?: string; recover?: boolean; maxFailures?: number; windowSeconds?: number; oauth?: Omit<OAuthProviderOptions, "ownerOrigin"> }) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) || !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("Owner auth requires a canonical loopback origin");
  }
  const maxFailures = z.number().int().min(1).max(20).parse(options.maxFailures ?? 5);
  const windowSeconds = z.number().int().min(1).max(86400).parse(options.windowSeconds ?? 900);
  const storage = await openAuthStorage(options.directory, options.vaultPath);
  const { database: db } = storage;
  try {
    // Refuse a future custom schema before asking the provider to migrate anything.
    const hasMigrations = db.prepare("SELECT name FROM sqlite_master WHERE name='vaultbridge_migration'").get();
    if (hasMigrations && Number(db.prepare("SELECT max(version) AS version FROM vaultbridge_migration").get()?.version) > 2) {
      throw new Error("Owner database is newer than this binary; restore a pre-upgrade backup");
    }
    const auth = betterAuth({
      appName: "Obsidian VaultBridge Owner",
      baseURL: options.oauth ? new URL(options.oauth.issuer).origin : options.origin,
      basePath: "/api/auth",
      secret: storage.secret,
      database: db,
      logger: { disabled: true },
      trustedOrigins: [options.origin, ...(options.oauth ? [new URL(options.oauth.issuer).origin] : [])],
      plugins: options.oauth ? oauthPlugins({ ...options.oauth, ownerOrigin: options.origin }) : [],
      emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
      session: { expiresIn: 8 * 60 * 60, updateAge: 60 * 60, cookieCache: { enabled: false } },
      advanced: {
        cookiePrefix: "vaultbridge-owner",
        useSecureCookies: origin.protocol === "https:",
        defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
        ipAddress: { ipAddressHeaders: ["x-vaultbridge-peer-ip"] },
      },
      rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    });
    const context = await auth.$context;
    await context.runMigrations();
    migrateOwnerSchema(db);
    const ownerId = (): string | undefined => {
      const id = db.prepare("SELECT user_id FROM vaultbridge_owner WHERE singleton=1").get()?.user_id;
      return typeof id === "string" ? id : undefined;
    };
    if (!ownerId() && Number(db.prepare('SELECT count(*) AS count FROM "user"').get()?.count) !== 0) {
      throw new Error("Unclaimed auth users exist; restore a consistent database backup");
    }
    if (options.recover && !ownerId()) throw new Error("No owner exists to recover");
    if (!ownerId()) {
      const username = usernameSchema.parse(options.ownerUsername ?? DEFAULT_USERNAME);
      const password = options.ownerPassword ?? DEFAULT_PASSWORD;
      if (password !== DEFAULT_PASSWORD && !strongPassword(password)) throw new Error("MCP_OWNER_PASSWORD must be a strong 12–128 character password");
      const hash = await context.password.hash(password);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (ownerId()) throw new Error("Owner already exists");
        const user = await context.internalAdapter.createUser({
          email: `${username}@owner.vaultbridge.example`, name: username, emailVerified: false,
        }, { method: "email-password" });
        await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
        db.prepare("INSERT INTO vaultbridge_owner (singleton, user_id, username, must_change_password) VALUES (1, ?, ?, ?)").run(user.id, username, password === DEFAULT_PASSWORD ? 1 : 0);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const tokenPath = path.join(options.directory, "setup-token");
    // Never overwrite an existing token file/symlink: a previous clean shutdown removes it.
    // A crashed process leaves an unusable token; the operator must remove it explicitly.
    let tokenHash: Buffer | undefined;
    let tokenExpires = 0;
    if (options.recover) {
      const token = randomBytes(32).toString("base64url");
      fs.writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
      tokenHash = createHash("sha256").update(token).digest();
      tokenExpires = Date.now() + 10 * 60_000;
    }
    const budget = new LoginBudget(db, maxFailures, windowSeconds);
    const verifyActivePrincipal = options.oauth ? principalVerifier(
      (token) => auth.api.verifyVaultAccess({ body: { token } }),
      { ...options.oauth, ownerId },
    ) : undefined;
    // Also open the application-owned grant store during standalone recovery:
    // provider session deletion can detach opaque tokens' session references.
    const grants = new SqliteGrantStore(db);
    let changingPassword = false;
    const mustChangePassword = () => db.prepare("SELECT must_change_password FROM vaultbridge_owner WHERE singleton=1").get()?.must_change_password !== 0;
    const ownerUsername = () => db.prepare("SELECT username FROM vaultbridge_owner WHERE singleton=1").get()?.username;
    const verifyPrincipal = verifyActivePrincipal ? async (authorization: string | undefined) => {
      if (mustChangePassword()) throw authorizationDenied();
      return verifyActivePrincipal(authorization);
    } : undefined;
    let recovering = false;
    function consumeToken() {
      tokenHash = undefined;
      fs.rmSync(tokenPath, { force: true });
    }
    return {
      tokenPath: tokenHash ? tokenPath : undefined,
      recovering: options.recover === true,
      hasOwner: () => Boolean(ownerId()),
      mustChangePassword,
      verifyPrincipal,
      backendForPrincipal(backend: VaultBackend, principal: VerifiedPrincipal, authorization: string): VaultBackend {
        if (mustChangePassword() || !options.oauth || !grants || !verifyPrincipal) throw authorizationDenied();
        assertVerifiedPrincipal(principal);
        const grant = grants.resolve(principal.principalId, principal.clientId, options.oauth.vaultId, options.oauth.resource);
        if (!grant) throw authorizationDenied();
        const context = createVerifiedAuthContext(principal, grant, randomUUID());
        return createRequestBackend(backend, {
          context, grants, vaultId: options.oauth.vaultId, resource: options.oauth.resource,
          async verifyRequest() {
            const current = await verifyPrincipal(authorization);
            if (current.principalId !== principal.principalId || current.clientId !== principal.clientId
              || current.resource !== principal.resource || JSON.stringify([...current.scopes].sort()) !== JSON.stringify([...principal.scopes].sort())) throw authorizationDenied();
          },
        });
      },
      /** Explicit public allowlist: never expose owner/session/admin APIs. */
      async handleOAuth(request: Request, peer: string): Promise<Response> {
        if (!options.oauth || !ownerId()) return Response.json({ error: "OAuth unavailable" }, { status: 503 });
        const url = new URL(request.url);
        if (url.origin !== new URL(options.oauth.issuer).origin) return Response.json({ error: "Forbidden" }, { status: 403 });
        const resourcePath = new URL(options.oauth.resource).pathname;
        const allowed = request.method === "GET" ? [
          `/.well-known/oauth-protected-resource${resourcePath}`,
          "/api/auth/.well-known/oauth-authorization-server",
          "/.well-known/oauth-authorization-server/api/auth",
          "/api/auth/oauth2/authorize",
        ] : request.method === "POST" ? ["/api/auth/oauth2/token", "/api/auth/oauth2/revoke"] : [];
        if (!allowed.includes(url.pathname)) return Response.json({ error: "Not found" }, { status: 404 });
        if (mustChangePassword() && !url.pathname.includes(".well-known")) return Response.json({ error: "Password change required" }, { status: 403 });
        const headers = new Headers(request.headers);
        // Public requests never authenticate as the owner using cookies.
        for (const name of ["cookie", "forwarded", "x-forwarded-for", "x-real-ip"]) headers.delete(name);
        headers.set("x-vaultbridge-peer-ip", peer);
        return auth.handler(new Request(request, { headers }));
      },
      async recoverPassword(input: unknown, token: string): Promise<boolean> {
        const parsed = recoveryPassword.safeParse(input);
        if (!parsed.success || recovering || !tokenHash || Date.now() >= tokenExpires) return false;
        const digest = createHash("sha256").update(token).digest();
        if (!timingSafeEqual(digest, tokenHash)) return false;
        recovering = true;
        try {
          const hash = await context.password.hash(parsed.data.password);
          db.exec("BEGIN IMMEDIATE");
          try {
            const existing = ownerId();
            if (options.recover && existing) {
              grants.revokePrincipal(existing);
              await context.internalAdapter.updatePassword(existing, hash);
              await context.internalAdapter.deleteUserSessions(existing);
              db.prepare("UPDATE vaultbridge_owner SET must_change_password=0 WHERE singleton=1").run();
            } else throw new Error("Recovery owner missing");
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          consumeToken();
          return true;
        } finally { recovering = false; }
      },
      async handle(request: Request, peer: string): Promise<Response> {
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)
          || (request.method === "POST" && (request.headers.get("origin") !== options.origin || request.headers.get("x-vaultbridge-csrf") !== "1"))) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        if (!ownerId() || recovering || (options.recover && tokenHash)) return Response.json({ error: "Owner unavailable" }, { status: 503 });
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set("x-vaultbridge-peer-ip", peer);
        // The auth library never receives spoofable forwarding headers.
        for (const name of ["forwarded", "x-forwarded-for", "x-real-ip"]) headers.delete(name);
        const forwarded = new Request(request, { headers });
        if (url.pathname === "/api/auth/sign-in/email" && request.method === "POST") {
          const body: unknown = await forwarded.clone().json();
          const parsed = z.union([
            z.object({ username: z.string().min(1).max(254), password: z.string().min(1).max(128) }).strict(),
            z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }).strict(),
          ]).safeParse(body);
          if (!parsed.success) return Response.json({ error: "Invalid credentials" }, { status: 401 });
          const identifier = ("username" in parsed.data ? parsed.data.username : parsed.data.email).trim().toLowerCase();
          const storedUsername = ownerUsername();
          const email = storedUsername === null ? identifier : `${identifier}@owner.vaultbridge.example`;
          const retry = budget.reserve(identifier, peer);
          if (retry) return Response.json({ error: "Try again later" }, { status: 429, headers: { "Retry-After": String(retry) } });
          let success = false;
          try {
            // The synthetic provider email is never a second login identifier.
            if (storedUsername !== null
              ? !("username" in parsed.data) || identifier !== storedUsername
              : !z.email().safeParse(identifier).success) return Response.json({ error: "Invalid credentials" }, { status: 401 });
            const login = new Request(forwarded, { body: JSON.stringify({ email, password: parsed.data.password }) });
            const result = await auth.handler(login);
            success = result.ok;
            // Do not expose a session token in JSON; browsers receive only the HttpOnly cookie.
            if (success) return new Response('{"success":true}', { status: 200, headers: result.headers });
            if (result.status === 429) return new Response('{"error":"Try again later"}', { status: 429, headers: { "Retry-After": result.headers.get("x-retry-after") ?? "60" } });
            return Response.json({ error: "Invalid credentials" }, { status: 401 });
          } finally { budget.finish(identifier, peer, success); }
        }
        const session = await auth.api.getSession({ headers });
        if (!session || session.user.id !== ownerId()) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
          const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) }).strict().safeParse(await forwarded.json());
          if (!body.success || !strongPassword(body.data.newPassword) || body.data.newPassword === DEFAULT_PASSWORD) return Response.json({ error: "Invalid password" }, { status: 400 });
          if (changingPassword) return Response.json({ error: "Password change in progress" }, { status: 409 });
          const retry = budget.reserve(session.user.id, peer);
          if (retry) return Response.json({ error: "Try again later" }, { status: 429, headers: { "Retry-After": String(retry) } });
          changingPassword = true;
          let success = false;
          try {
            const account = await context.internalAdapter.findCredentialAccount(session.user.id);
            if (!account?.password || !await context.password.verify({ hash: account.password, password: body.data.currentPassword })
              || body.data.currentPassword === body.data.newPassword) return Response.json({ error: "Invalid password" }, { status: 400 });
            const hash = await context.password.hash(body.data.newPassword);
            db.exec("BEGIN IMMEDIATE");
            try {
              await context.internalAdapter.updatePassword(session.user.id, hash);
              grants.revokePrincipal(session.user.id);
              await context.internalAdapter.deleteUserSessions(session.user.id);
              db.prepare("UPDATE vaultbridge_owner SET must_change_password=0 WHERE singleton=1").run();
              db.exec("COMMIT");
            } catch (error) { db.exec("ROLLBACK"); throw error; }
            success = true;
            return Response.json({ success: true });
          } finally { changingPassword = false; budget.finish(session.user.id, peer, success); }
        }
        if (mustChangePassword() && (url.pathname.startsWith("/oauth/") || url.pathname === "/api/auth/revoke-sessions")) {
          return Response.json({ error: "Password change required" }, { status: 403 });
        }
        if (options.oauth && grants) {
          if (url.pathname === "/oauth/grants" && request.method === "GET") return Response.json({
            vaultId: options.oauth.vaultId, resource: options.oauth.resource,
            grants: grants.list().filter((grant) => grant.principalId === session.user.id && grant.vaultId === options.oauth!.vaultId && grant.resource === options.oauth!.resource),
          });
          if (url.pathname === "/oauth/grants/revoke" && request.method === "POST") {
            const parsed = z.object({ grantId: z.string().min(1).max(512) }).strict().safeParse(await forwarded.json());
            const grant = parsed.success ? grants.get(parsed.data.grantId) : undefined;
            if (!grant || grant.principalId !== session.user.id || grant.vaultId !== options.oauth.vaultId || grant.resource !== options.oauth.resource) return Response.json({ error: "Invalid grant" }, { status: 400 });
            grants.revoke(grant.grantId);
            return Response.json({ success: true });
          }
          if (url.pathname === "/oauth/grants" && request.method === "POST") {
            const body = vaultGrantSchema.pick({ principalPermissions: true, clientPermissions: true }).extend({
              oauth_query: z.string().min(1).max(8192),
            }).strict().safeParse(await forwarded.json());
            if (!body.success || !await verifyOAuthQueryParams(body.data.oauth_query, storage.secret)) return Response.json({ error: "Invalid grant" }, { status: 400 });
            const query = new URLSearchParams(body.data.oauth_query);
            const clientId = query.get("client_id") ?? "";
            const scopes = (query.get("scope") ?? "").split(" ");
            if (query.get("resource") !== options.oauth.resource || query.getAll("resource").length !== 1
              || !scopes.some((scope) => scope === "vault:read" || scope === "vault:write")) return Response.json({ error: "Invalid grant" }, { status: 400 });
            const existing = grants.resolve(session.user.id, clientId, options.oauth.vaultId, options.oauth.resource);
            const grant = vaultGrantSchema.safeParse({
              version: 1, grantId: existing?.grantId ?? randomUUID(), principalId: session.user.id,
              clientId, vaultId: options.oauth.vaultId, resource: options.oauth.resource,
              consentScopes: scopes, principalPermissions: body.data.principalPermissions, clientPermissions: body.data.clientPermissions,
            });
            if (!grant.success) return Response.json({ error: "Invalid grant" }, { status: 400 });
            grants.put(grant.data);
            return Response.json({ grantId: grant.data.grantId });
          }
        }
        if (options.oauth && ["/oauth/authorize", "/oauth/consent", "/oauth/preview"].includes(url.pathname) && request.method === "POST") {
          const body = z.object({ oauth_query: z.string().min(1).max(8192), accept: z.boolean().optional() }).strict().safeParse(await forwarded.json());
          if (!body.success || !await verifyOAuthQueryParams(body.data.oauth_query, storage.secret)) return Response.json({ error: "Invalid authorization query" }, { status: 400 });
          const query = new URLSearchParams(body.data.oauth_query);
          if (url.pathname === "/oauth/preview") return Response.json({
            clientId: query.get("client_id"), scopes: query.get("scope"), resource: query.get("resource"),
          });
          const endpoint = url.pathname === "/oauth/consent" ? "consent" : "authorize";
          const providerHeaders = new Headers(headers);
          providerHeaders.set("origin", new URL(options.oauth.issuer).origin);
          providerHeaders.set("accept", "application/json");
          providerHeaders.set("content-type", "application/json");
          return auth.handler(new Request(`${options.oauth.issuer}/oauth2/${endpoint}${endpoint === "authorize" ? `?${body.data.oauth_query}` : ""}`, {
            method: endpoint === "authorize" ? "GET" : "POST", headers: providerHeaders,
            ...(endpoint === "consent" ? { body: JSON.stringify({ oauth_query: body.data.oauth_query, accept: body.data.accept === true }) } : {}),
          }));
        }
        if (url.pathname === "/api/auth/get-session" && request.method === "GET") {
          return Response.json({ username: ownerUsername() ?? session.user.email, mustChangePassword: mustChangePassword(), expiresAt: session.session.expiresAt });
        }
        if (url.pathname === "/api/auth/revoke-sessions" && request.method === "POST") {
          grants.revokePrincipal(session.user.id);
          await context.internalAdapter.deleteUserSessions(session.user.id);
          return Response.json({ success: true });
        }
        if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
          grants.revokePrincipal(session.user.id);
          return auth.handler(forwarded);
        }
        // No catch-all forwarding: public signup, resets, account mutation, OAuth etc. stay closed.
        return Response.json({ error: "Not found" }, { status: 404 });
      },
      async close() {
        if (tokenHash) consumeToken();
        await storage.close();
      },
    };
  } catch (error) { await storage.close(); throw error; }
}

export type OwnerAuth = Awaited<ReturnType<typeof createOwnerAuth>>;
