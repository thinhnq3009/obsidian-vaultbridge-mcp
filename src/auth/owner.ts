import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { z } from "zod";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

import { LoginBudget } from "./loginBudget.js";
import { oauthPlugins, principalVerifier, type OAuthProviderOptions } from "./oauth.js";
import { migrateOwnerSchema, openAuthStorage } from "./storage.js";

const credentials = z.object({ email: z.email().max(254).transform((email) => email.trim().toLowerCase()), password: z.string().min(12).max(128) }).strict();
const recoveryPassword = z.object({ password: z.string().min(12).max(128) }).strict();

export async function createOwnerAuth(options: { directory: string; vaultPath: string; origin: string; recover?: boolean; maxFailures?: number; windowSeconds?: number; oauth?: Omit<OAuthProviderOptions, "ownerOrigin">; requireOwner?: boolean }) {
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
    if (hasMigrations && Number(db.prepare("SELECT max(version) AS version FROM vaultbridge_migration").get()?.version) > 1) {
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
    if (options.requireOwner && !ownerId()) throw new Error("OAuth requires prior local owner-auth setup");
    if (options.recover && !ownerId()) throw new Error("No owner exists to recover; run normal owner setup");
    const tokenPath = path.join(options.directory, "setup-token");
    // Never overwrite an existing token file/symlink: a previous clean shutdown removes it.
    // A crashed process leaves an unusable token; the operator must remove it explicitly.
    let tokenHash: Buffer | undefined;
    let tokenExpires = 0;
    if (!ownerId() || options.recover) {
      const token = randomBytes(32).toString("base64url");
      fs.writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
      tokenHash = createHash("sha256").update(token).digest();
      tokenExpires = Date.now() + 10 * 60_000;
    }
    const budget = new LoginBudget(db, maxFailures, windowSeconds);
    const verifyPrincipal = options.oauth ? principalVerifier(
      (token) => auth.api.verifyVaultAccess({ body: { token } }),
      { ...options.oauth, ownerId },
    ) : undefined;
    let enrolling = false;
    function consumeToken() {
      tokenHash = undefined;
      fs.rmSync(tokenPath, { force: true });
    }
    return {
      tokenPath: tokenHash ? tokenPath : undefined,
      recovering: options.recover === true,
      hasOwner: () => Boolean(ownerId()),
      verifyPrincipal,
      /** Explicit public allowlist: never expose owner/session/admin APIs. */
      async handleOAuth(request: Request, peer: string): Promise<Response> {
        if (!options.oauth || !ownerId()) return Response.json({ error: "OAuth unavailable" }, { status: 503 });
        const url = new URL(request.url);
        const resourcePath = new URL(options.oauth.resource).pathname;
        const allowed = request.method === "GET" ? [
          `/.well-known/oauth-protected-resource${resourcePath}`,
          "/api/auth/.well-known/oauth-authorization-server",
          "/.well-known/oauth-authorization-server/api/auth",
          "/api/auth/oauth2/authorize",
        ] : request.method === "POST" ? ["/api/auth/oauth2/token", "/api/auth/oauth2/revoke"] : [];
        if (!allowed.includes(url.pathname)) return Response.json({ error: "Not found" }, { status: 404 });
        const headers = new Headers(request.headers);
        // Public requests never authenticate as the owner using cookies.
        for (const name of ["cookie", "forwarded", "x-forwarded-for", "x-real-ip"]) headers.delete(name);
        headers.set("x-vaultbridge-peer-ip", peer);
        return auth.handler(new Request(request, { headers }));
      },
      async enroll(input: unknown, token: string): Promise<boolean> {
        const parsed = options.recover ? recoveryPassword.safeParse(input) : credentials.safeParse(input);
        if (!parsed.success || enrolling || !tokenHash || Date.now() >= tokenExpires) return false;
        const digest = createHash("sha256").update(token).digest();
        if (!timingSafeEqual(digest, tokenHash)) return false;
        enrolling = true;
        try {
          const hash = await context.password.hash(parsed.data.password);
          db.exec("BEGIN IMMEDIATE");
          try {
            const existing = ownerId();
            if (options.recover && existing) {
              await context.internalAdapter.updatePassword(existing, hash);
              await context.internalAdapter.deleteUserSessions(existing);
            } else {
              if (existing || !("email" in parsed.data) || typeof parsed.data.email !== "string") throw new Error("Owner already enrolled");
              const user = await context.internalAdapter.createUser({ email: parsed.data.email, name: "Owner", emailVerified: false }, { method: "email-password" });
              await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
              db.prepare("INSERT INTO vaultbridge_owner VALUES (1, ?)").run(user.id);
            }
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          consumeToken();
          return true;
        } finally { enrolling = false; }
      },
      async handle(request: Request, peer: string): Promise<Response> {
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)
          || (request.method === "POST" && (request.headers.get("origin") !== options.origin || request.headers.get("x-vaultbridge-csrf") !== "1"))) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        if (!ownerId() || enrolling || (options.recover && tokenHash)) return Response.json({ error: "Owner setup required" }, { status: 503 });
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set("x-vaultbridge-peer-ip", peer);
        // The auth library never receives spoofable forwarding headers.
        for (const name of ["forwarded", "x-forwarded-for", "x-real-ip"]) headers.delete(name);
        const forwarded = new Request(request, { headers });
        if (url.pathname === "/api/auth/sign-in/email" && request.method === "POST") {
          const body: unknown = await forwarded.clone().json();
          const parsed = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }).strict().safeParse(body);
          if (!parsed.success) return Response.json({ error: "Invalid credentials" }, { status: 401 });
          const email = parsed.data.email.trim().toLowerCase();
          const retry = budget.reserve(email, peer);
          if (retry) return Response.json({ error: "Try again later" }, { status: 429, headers: { "Retry-After": String(retry) } });
          let success = false;
          try {
            const result = await auth.handler(forwarded);
            success = result.ok;
            // Do not expose a session token in JSON; browsers receive only the HttpOnly cookie.
            if (success) return new Response('{"success":true}', { status: 200, headers: result.headers });
            if (result.status === 429) return new Response('{"error":"Try again later"}', { status: 429, headers: { "Retry-After": result.headers.get("x-retry-after") ?? "60" } });
            return Response.json({ error: "Invalid credentials" }, { status: 401 });
          } finally { budget.finish(email, peer, success); }
        }
        const session = await auth.api.getSession({ headers });
        if (!session || session.user.id !== ownerId()) return Response.json({ error: "Unauthorized" }, { status: 401 });
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
          return Response.json({ email: session.user.email, expiresAt: session.session.expiresAt });
        }
        if (url.pathname === "/api/auth/revoke-sessions" && request.method === "POST") {
          await context.internalAdapter.deleteUserSessions(session.user.id);
          return Response.json({ success: true });
        }
        if (url.pathname === "/api/auth/sign-out" && request.method === "POST") return auth.handler(forwarded);
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
