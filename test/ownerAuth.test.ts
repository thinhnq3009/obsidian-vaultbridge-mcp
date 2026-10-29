import fs from "node:fs";
import http from "node:http";
import { setTimeout } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOwnerAuth } from "../src/auth/owner.js";
import { startOwnerServer, isOwnerRequestAllowed } from "../src/auth/http.js";
import { assertOutsideVault, authDataDirectory, migrateOwnerSchema, openAuthStorage } from "../src/auth/storage.js";
import { ownerOptions } from "../src/auth/cli.js";
import { LoginBudget } from "../src/auth/loginBudget.js";
import { ownerHtml, ownerScript } from "../src/auth/ui.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

type Service = Awaited<ReturnType<typeof startOwnerServer>>;
let root: string;
let directory: string;
let vaultPath: string;
let service: Service | undefined;
const password = "disposable-owner-password-123!";
const email = "owner@example.test";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-owner-test-"));
  directory = path.join(root, "identity");
  vaultPath = path.join(root, "vault");
  fs.mkdirSync(vaultPath);
  fs.mkdirSync(path.join(vaultPath, ".obsidian"));
});
afterEach(async () => {
  await service?.close();
  service = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
async function start(extra: { recover?: boolean; maxFailures?: number; windowSeconds?: number } = {}) {
  service = await startOwnerServer({ directory, vaultPath, port: 0, ownerPassword: password, ...extra });
  if (!extra.recover) {
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    db.prepare('UPDATE "user" SET email=?').run(email);
    db.prepare("UPDATE vaultbridge_owner SET username=NULL").run();
    db.close();
  }
  return service;
}
async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${service!.origin}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: service!.origin, "X-VaultBridge-CSRF": "1", ...headers }, body: JSON.stringify(body),
  });
}
async function login() {
  const response = await post("/api/auth/sign-in/email", { username: email, password });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!).join("; ");
  expect(cookies).toContain("session_token=");
  return { response, cookies };
}

describe("local owner HTTP lifecycle", () => {
  it("automatically bootstraps the public default once, blocks OAuth and rotates through loopback only", async () => {
    service = await startOwnerServer({
      directory, vaultPath, port: 0,
      oauth: { issuer: "https://vault.example/api/auth", resource: "https://vault.example/mcp", vaultId: "vault" },
    });
    expect(service.tokenPath).toBeUndefined();
    expect(fs.existsSync(path.join(directory, "setup-token"))).toBe(false);
    expect(fs.existsSync(path.join(vaultPath, "auth.sqlite"))).toBe(false);
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(db.prepare('SELECT count(*) AS n FROM "user"').get()?.n).toBe(1);
    expect(db.prepare("SELECT must_change_password FROM vaultbridge_owner").get()?.must_change_password).toBe(1);
    const initial = await post("/api/auth/sign-in/email", { username: "obsidian-admin", password: "admin39145" });
    expect(initial.status).toBe(200);
    const cookie = initial.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    const state = await (await fetch(`${service.origin}/api/auth/get-session`, { headers: { cookie } })).json() as { mustChangePassword: boolean };
    expect(state.mustChangePassword).toBe(true);
    expect((await post("/oauth/grants", {}, { cookie })).status).toBe(403);
    expect((await post("/oauth/consent", {}, { cookie })).status).toBe(403);
    expect((await service.owner.handleOAuth(new Request("https://vault.example/api/auth/oauth2/token", { method: "POST" }), "127.0.0.1")).status).toBe(403);
    await expect(service.owner.verifyPrincipal!("Bearer fake")).rejects.toThrow();
    expect((await post("/setup", { token: "x", password })).status).toBe(404);
    expect((await post("/recover-owner", { token: "x", password })).status).toBe(404);
    for (const headers of [{ Origin: "https://evil.example" }, { "X-VaultBridge-CSRF": "" }]) {
      expect((await post("/api/auth/change-password", { currentPassword: "admin39145", newPassword: password }, { cookie, ...headers })).status).toBe(403);
    }
    expect((await post("/api/auth/change-password", { currentPassword: "wrong", newPassword: password }, { cookie })).status).toBe(400);
    expect((await post("/api/auth/change-password", { currentPassword: "admin39145", newPassword: "short" }, { cookie })).status).toBe(400);
    // Wrong-current backoff expires independently; exercise a fresh session's successful rotation.
    db.exec("DELETE FROM vaultbridge_login_budget");
    expect((await post("/api/auth/change-password", { currentPassword: "admin39145", newPassword: password }, { cookie })).status).toBe(200);
    expect(db.prepare("SELECT must_change_password FROM vaultbridge_owner").get()?.must_change_password).toBe(0);
    expect((await fetch(`${service.origin}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
    expect((await post("/api/auth/sign-in/email", { username: "obsidian-admin", password: "admin39145" })).status).toBe(401);
    db.close();
    await service.close(); service = undefined;
    service = await startOwnerServer({ directory, vaultPath, port: 0, ownerUsername: "other-owner", ownerPassword: "Different-Password-456!" });
    await setTimeout(1100); // Failed old-password attempt retains a persistent peer backoff.
    const fresh = await post("/api/auth/sign-in/email", { username: "obsidian-admin", password });
    expect(fresh.status).toBe(200);
    expect((await post("/api/auth/sign-in/email", { username: "other-owner", password: "Different-Password-456!" })).status).not.toBe(200);
    expect((await post("/api/auth/sign-in/email", { username: "obsidian-admin@owner.vaultbridge.example", password })).status).not.toBe(200);
  });

  it("uses custom ENV credentials only at first creation and rejects weak custom passwords", async () => {
    await expect(startOwnerServer({ directory, vaultPath, port: 0, ownerPassword: "too-short" })).rejects.toThrow("strong");
    service = await startOwnerServer({ directory, vaultPath, port: 0, ownerUsername: "my-owner", ownerPassword: password });
    expect((await post("/api/auth/sign-in/email", { username: "my-owner", password })).status).toBe(200);
    expect(service.owner.mustChangePassword()).toBe(false);
    await service.close(); service = undefined;
    service = await startOwnerServer({ directory, vaultPath, port: 0, ownerUsername: "changed", ownerPassword: "weak" });
    expect((await post("/api/auth/sign-in/email", { username: "my-owner", password })).status).toBe(200);
    expect((await post("/api/auth/sign-in/email", { username: "changed", password: "weak" })).status).toBe(401);
  });

  it("allows only safe top-level OAuth login/consent navigation from a different site", async () => {
    await start();
    const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    // Node fetch overwrites Sec-Fetch-Mode with "cors"; raw HTTP is needed
    // to reproduce browser navigation metadata faithfully.
    const navigate = (route: string, headers: Record<string, string>) => new Promise<{
      status: number; headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const request = http.request(new URL(route, service!.origin), { headers }, (response) => {
        response.resume();
        response.on("end", () => { resolve({ status: response.statusCode!, headers: response.headers }); });
      });
      request.on("error", reject); request.end();
    });
    for (const route of ["/login", "/consent"]) {
      const response = await navigate(`${route}?sig=invalid`, navigation);
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
    for (const route of ["/admin", "/owner-state", "/api/auth/get-session", "/oauth/grants", "/owner.js"]) {
      expect((await navigate(route, navigation)).status).toBe(403);
    }
    for (const headers of [
      { ...navigation, "sec-fetch-mode": "cors" },
      { ...navigation, "sec-fetch-dest": "iframe" },
      { ...navigation, origin: "https://attacker.example" },
      { "sec-fetch-site": "cross-site" },
    ]) expect((await navigate("/consent", headers)).status).toBe(403);
    expect((await post("/setup", {}, navigation)).status).toBe(403);
  });
  it("bootstraps once, hashes passwords, persists WAL/users/key/session across restart, logs out", async () => {
    await start();
    expect(service!.tokenPath).toBeUndefined();
    expect((await post("/setup", { token: "invalid", password })).status).toBe(404);
    const { response, cookies } = await login();
    expect(await response.json()).toEqual({ success: true });
    const setCookie = response.headers.getSetCookie().join(";");
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/SameSite=Strict/iu);
    expect(setCookie).not.toMatch(/; Secure/iu); // Local HTTP exception, never network.
    const key = fs.readFileSync(path.join(directory, "session.key"), "utf8");
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    const hash = db.prepare("SELECT password FROM account").get()?.password;
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe(password);
    expect(String(hash)).not.toContain(password);
    expect(db.prepare("SELECT count(*) AS n FROM vaultbridge_migration").get()?.n).toBe(2);
    db.close();
    await service!.close(); service = undefined;
    await start();
    expect(service!.tokenPath).toBeUndefined();
    expect(fs.readFileSync(path.join(directory, "session.key"), "utf8")).toBe(key);
    expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie: cookies } })).status).toBe(200);
    expect((await post("/api/auth/sign-out", {}, { cookie: cookies })).status).toBe(200);
    expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie: cookies } })).status).toBe(401);
  });

  it("rejects expired/tampered sessions and sets Secure for an HTTPS origin", async () => {
    const origin = "https://127.0.0.1:39146";
    const auth = await createOwnerAuth({ directory, vaultPath, origin, ownerPassword: password });
    try {
      const response = await auth.handle(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { origin, "content-type": "application/json", "x-vaultbridge-csrf": "1" }, body: JSON.stringify({ username: "obsidian-admin", password }),
      }), "127.0.0.1");
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie().join(";")).toMatch(/; Secure/iu);
      const cookie = response.headers.getSetCookie().map((item) => item.split(";")[0]!).join("; ");
      expect((await auth.handle(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: "__Secure-vaultbridge-owner.session_token=tampered" } }), "127.0.0.1")).status).toBe(401);
      const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
      db.exec('UPDATE "session" SET "expiresAt"=0'); db.close();
      expect((await auth.handle(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }), "127.0.0.1")).status).toBe(401);
    } finally { await auth.close(); }
  });

  it("denies missing/incorrect tokens, parallel bootstrap and public account creation", async () => {
    await start();
    expect((await post("/setup", { token: "wrong", password })).status).toBe(404);
    expect((await post("/setup", { token: "wrong", password: "short" })).status).toBe(404);
    const { cookies } = await login();
    for (const route of ["sign-up/email", "request-password-reset", "reset-password", "update-user", "change-password"]) {
      expect((await post(`/api/auth/${route}`, { username: email, password }, { cookie: cookies })).status).toBe(route === "change-password" ? 400 : 404);
    }
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(db.prepare('SELECT count(*) AS n FROM "user"').get()?.n).toBe(1);
    db.close();
  });

  it("requires same-origin JSON and a non-simple CSRF header for setup, login, logout and revoke", async () => {
    await start();
    for (const route of ["/setup", "/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/revoke-sessions"]) {
      expect((await post(route, {}, { Origin: "https://evil.test" })).status).toBe(403);
      expect((await post(route, {}, { Origin: "" })).status).toBe(403);
      expect((await post(route, {}, { "X-VaultBridge-CSRF": "" })).status).toBe(403);
      expect((await post(route, {}, { "Content-Type": "text/plain" })).status).toBe(403);
      expect((await post(route, {}, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    }
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${service!.origin}/admin`, { headers: { Host: "evil.test" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    expect(hostStatus).toBe(403);
  });

  it("revokes every session and supports local token recovery without public password resets", async () => {
    await start();
    const first = (await login()).cookies;
    const second = (await login()).cookies;
    expect((await post("/api/auth/revoke-sessions", {}, { cookie: first })).status).toBe(200);
    for (const cookie of [first, second]) expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
  });

  it("changes a legacy email owner's password without changing its principal, and revokes every session", async () => {
    await start();
    const oldLogin = await post("/api/auth/sign-in/email", { email, password });
    expect(oldLogin.status).toBe(200);
    const first = oldLogin.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    const second = (await login()).cookies;
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    const principal = db.prepare("SELECT user_id FROM vaultbridge_owner").get()?.user_id;
    const changed = await post("/api/auth/change-password", { currentPassword: password, newPassword: "Legacy-Rotated-Password-123!" }, { cookie: first });
    expect(changed.status).toBe(200);
    expect(db.prepare("SELECT user_id FROM vaultbridge_owner").get()?.user_id).toBe(principal);
    for (const cookie of [first, second]) expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
    expect((await post("/api/auth/sign-in/email", { username: email, password: "Legacy-Rotated-Password-123!" })).status).toBe(200);
    db.close();
  });

  it("migrates an existing version-1 email owner without replacing credentials or principal", async () => {
    await start();
    await service!.close(); service = undefined;
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    const principal = db.prepare("SELECT user_id FROM vaultbridge_owner").get()?.user_id;
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE old_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL UNIQUE REFERENCES user(id));
      INSERT INTO old_owner SELECT singleton, user_id FROM vaultbridge_owner;
      DROP TABLE vaultbridge_owner;
      ALTER TABLE old_owner RENAME TO vaultbridge_owner;
      DELETE FROM vaultbridge_migration WHERE version=2;
      COMMIT;`);
    db.close();
    service = await startOwnerServer({ directory, vaultPath, port: 0, ownerUsername: "new-owner", ownerPassword: "Wrong-Override-Password-123!" });
    const after = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(after.prepare("SELECT user_id, username, must_change_password FROM vaultbridge_owner").get()).toMatchObject({
      user_id: principal, username: null, must_change_password: 0,
    });
    after.close();
    expect((await login()).response.status).toBe(200);
  });

  it("recovers the password locally and invalidates existing sessions", async () => {
    await start();
    const beforeRecovery = (await login()).cookies;
    await service!.close(); service = undefined;
    await start({ recover: true });
    expect((await post("/recover-owner", { token: fs.readFileSync(service!.tokenPath!, "utf8"), password: `${password}-new` })).status).toBe(200);
    expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie: beforeRecovery } })).status).toBe(401);
    expect((await post("/api/auth/sign-in/email", { username: email, password: `${password}-new` })).status).toBe(200);
  });

  it("enforces persistent failure/backoff despite spoofed peer headers and concurrent login floods", async () => {
    await start({ maxFailures: 2 });
    const headers = { "X-Forwarded-For": "192.0.2.1", "X-Real-IP": "192.0.2.2", "X-VaultBridge-Peer-IP": "192.0.2.3" };
    expect((await post("/api/auth/sign-in/email", { username: email, password: "bad" }, headers)).status).toBe(401);
    const limited = await post("/api/auth/sign-in/email", { username: email.toUpperCase(), password: "bad" }, { "X-Forwarded-For": "192.0.2.4" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await service!.close(); service = undefined;
    await start({ maxFailures: 2 });
    expect((await post("/api/auth/sign-in/email", { username: email, password })).status).toBe(429);
    const results = await Promise.all(Array.from({ length: 10 }, () => post("/api/auth/sign-in/email", { username: "other@example.test", password: "bad" })));
    expect(results.filter((result) => result.status === 401).length).toBeLessThanOrEqual(2);
    expect(results.some((result) => result.status === 429)).toBe(true);
  });

  it("returns generic login errors and disallows callback redirects", async () => {
    await start();
    const missing = await post("/api/auth/sign-in/email", { username: "missing@example.test", password: "bad" });
    await setTimeout(1100); // Peer-wide progressive backoff applies equally to every account.
    const existing = await post("/api/auth/sign-in/email", { username: email, password: "bad" });
    expect(missing.status).toBe(existing.status);
    expect(await missing.json()).toEqual(await existing.json());
    expect((await post("/api/auth/sign-in/email", { username: email, password, callbackURL: "https://evil.test" })).status).toBe(401);
  });

  it("serves a minimal non-inline UI with no-store/CSP, denies oversized/encoded/malformed bodies", async () => {
    await start();
    const page = await fetch(`${service!.origin}/admin`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('src="/owner.js"');
    expect((await fetch(`${service!.origin}/owner.js`)).status).toBe(200);
    expect(ownerHtml).toContain('autocomplete="new-password"');
    expect(ownerScript).not.toContain("innerHTML");
    expect(ownerScript).not.toContain("localStorage");
    expect((await post("/setup", { token: "x", password: "x".repeat(9000) })).status).toBe(413);
    expect((await post("/setup", {}, { "Content-Encoding": "gzip" })).status).toBe(415);
    expect((await fetch(`${service!.origin}/setup`, { method: "POST", headers: { Origin: service!.origin, "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" }, body: "{" })).status).toBe(400);
    expect((await fetch(`${service!.origin}/setup`, { method: "DELETE" })).status).toBe(405);
    const preflight = await fetch(`${service!.origin}/setup`, { method: "OPTIONS", headers: { Origin: "https://evil.test" } });
    expect(preflight.headers.has("access-control-allow-origin")).toBe(false);
    let final: globalThis.Response | undefined;
    for (let i = 0; i < 125; i++) final = await fetch(`${service!.origin}/owner-state`);
    expect(final!.status).toBe(429);
    expect(Number(final!.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("keeps the provider rate limiter enabled in test/development independently of password budgets", async () => {
    await start({ maxFailures: 20 });
    expect((await post("/api/auth/sign-in/email", { username: email, password: "bad" })).status).toBe(401);
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(db.prepare('SELECT count(*) AS n FROM "rateLimit"').get()?.n).toBeGreaterThan(0);
    // Exhaust provider state while clearing only our separate failure/backoff state.
    db.exec('DELETE FROM vaultbridge_login_budget; UPDATE "rateLimit" SET count=999');
    db.close();
    const response = await post("/api/auth/sign-in/email", { username: "missing@example.test", password: "bad" });
    expect(response.status).toBe(429);
    expect(response.headers.has("Retry-After")).toBe(true);
  });
});

describe("owner storage and guard contracts", () => {
  it("bootstraps the same explicit auth directory that the OAuth runtime will open", async () => {
    const reservation = http.createServer();
    await new Promise<void>((resolve) => { reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port");
    await new Promise<void>((resolve) => { reservation.close(() => { resolve(); }); });
    const envDirectory = path.join(root, "wrong-env-directory");
    const explicitDirectory = path.join(root, "explicit-auth-directory");
    const env = { ...process.env, MCP_TRANSPORT: "stdio", MCP_AUTH_MODE: "token",
      MCP_AUTH_DIRECTORY: envDirectory, HOME: root, USERPROFILE: root,
      XDG_DATA_HOME: path.join(root, "default-data"), APPDATA: path.join(root, "default-data") };
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/index.ts"),
      "owner-auth", "--vault", vaultPath, "--stdio", "--owner-port", String(address.port),
      "--auth-directory", explicitDirectory], {
      cwd: root, env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => { resolve(); }); });
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(explicitDirectory, "auth.sqlite"))).toBe(true), { timeout: 15000 });
      expect(fs.existsSync(path.join(explicitDirectory, "setup-token"))).toBe(false);
      expect(fs.existsSync(path.join(explicitDirectory, "auth.sqlite"))).toBe(true);
      expect(fs.existsSync(envDirectory)).toBe(false);
      expect(fs.existsSync(path.join(root, "default-data"))).toBe(false);
    } finally { child.kill(); await exited; }
  });
  it("chooses per-OS app data paths and rejects relative app-data configuration", () => {
    expect(authDataDirectory("linux", { XDG_DATA_HOME: root }, root)).toBe(path.join(root, "obsidian-vaultbridge-mcp"));
    expect(authDataDirectory("linux", {}, root)).toBe(path.join(root, ".local/share/obsidian-vaultbridge-mcp"));
    expect(authDataDirectory("linux", { XDG_DATA_HOME: "" }, root)).toBe(path.join(root, ".local/share/obsidian-vaultbridge-mcp"));
    expect(authDataDirectory("darwin", {}, root)).toBe(path.join(root, "Library/Application Support/ObsidianVaultBridge"));
    expect(authDataDirectory("win32", { APPDATA: root }, root)).toBe(path.join(root, "ObsidianVaultBridge"));
    expect(() => authDataDirectory("linux", { XDG_DATA_HOME: "relative" }, root)).toThrow("absolute");
    expect(() => authDataDirectory("win32", {}, root)).toThrow("APPDATA");
  });

  it("rejects vault/ancestor placement and recognizable second vaults before creating files", () => {
    expect(() => assertOutsideVault(path.join(vaultPath, "identity"), vaultPath)).toThrow("separate");
    expect(() => assertOutsideVault(root, vaultPath)).toThrow("separate");
    const other = path.join(root, "other"); fs.mkdirSync(other); fs.mkdirSync(path.join(other, ".obsidian"));
    expect(() => assertOutsideVault(path.join(other, "identity"), vaultPath)).toThrow("Obsidian vault");
  });

  it("rejects symlink aliases into vault and unsafe key files", async () => {
    const alias = path.join(root, "alias");
    fs.symlinkSync(vaultPath, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(openAuthStorage(path.join(alias, "auth"), vaultPath)).rejects.toThrow("separate");
    expect(fs.existsSync(path.join(vaultPath, "auth"))).toBe(false);
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(root, "key"); fs.writeFileSync(target, "x", { mode: 0o600 });
    // Hard links are portable on Windows CI and rejected too.
    fs.linkSync(target, path.join(directory, "session.key"));
    await expect(openAuthStorage(directory, vaultPath)).rejects.toThrow("Unsafe");
  });

  it("uses private storage, exclusive process locking and fails closed on lost key", async () => {
    const store = await openAuthStorage(directory, vaultPath);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      for (const name of ["session.key", "auth.sqlite"]) expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
    await expect(openAuthStorage(directory, vaultPath)).rejects.toThrow();
    await store.close();
    fs.rmSync(path.join(directory, "session.key"));
    await expect(openAuthStorage(directory, vaultPath)).rejects.toThrow("Missing owner session key");
  });

  it("refuses insecure directory permissions on POSIX", async () => {
    if (process.platform === "win32") return;
    fs.mkdirSync(directory, { mode: 0o755 });
    await expect(openAuthStorage(directory, vaultPath)).rejects.toThrow("0700");
  });

  it("migrates idempotently and refuses newer databases without modifying provider tables", async () => {
    const auth = await createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" });
    await auth.close();
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    migrateOwnerSchema(db);
    db.prepare("INSERT INTO vaultbridge_migration VALUES (3, datetime('now'))").run();
    expect(() => migrateOwnerSchema(db)).toThrow("newer"); db.close();
    await expect(createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" })).rejects.toThrow("newer");
  });

  it("rolls back failed bootstrap and retries without creating a partial owner", async () => {
    const store = await openAuthStorage(directory, vaultPath);
    const { betterAuth } = await import("better-auth");
    const authEngine = betterAuth({ database: store.database, secret: store.secret, emailAndPassword: { enabled: true } });
    await (await authEngine.$context).runMigrations();
    await store.close();
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    try {
      db.exec(`CREATE TRIGGER reject_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      await expect(createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" })).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM "user"').get()?.n).toBe(0);
      db.exec("DROP TRIGGER reject_account");
      const owner = await createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" });
      expect(owner.hasOwner()).toBe(true);
      await owner.close();
    } finally { db.close(); }
  });

  it("never permits recovery without an existing owner", async () => {
    const auth = await createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" });
    await auth.close();
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    db.exec("DELETE FROM vaultbridge_owner; DELETE FROM account; DELETE FROM user");
    db.close();
    await expect(createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146", recover: true })).rejects.toThrow("No owner");
  });

  it("never trusts proxy/client headers or non-loopback peers and rejects noncanonical origins", async () => {
    const origin = "http://127.0.0.1:39146";
    expect(isOwnerRequestAllowed("192.0.2.1", "127.0.0.1:39146", origin, origin)).toBe(false);
    expect(isOwnerRequestAllowed("::ffff:127.0.0.1", "evil.test", undefined, origin)).toBe(false);
    expect(isOwnerRequestAllowed("127.0.0.1", "127.0.0.1:39146", "null", origin)).toBe(false);
    expect(isOwnerRequestAllowed("127.0.0.1", "127.0.0.1:39146", origin, origin)).toBe(true);
    await expect(createOwnerAuth({ directory, vaultPath, origin: "https://evil.test" })).rejects.toThrow("loopback");
    await expect(createOwnerAuth({ directory, vaultPath, origin: `${origin}/path` })).rejects.toThrow("canonical");
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("anonymous configuration and ordinary STDIO do not create owner storage or load SQLite", async () => {
    const appData = path.join(root, "app-data");
    const env = { ...process.env, XDG_DATA_HOME: appData, APPDATA: appData, MCP_AUTH_MODE: "none", VAULT_PATH: vaultPath, MCP_TRANSPORT: "stdio" };
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts", "--vault", vaultPath, "--watch-mode", "off"], env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const client = new Client({ name: "no-owner-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally { await client.close(); }
    expect(fs.existsSync(appData)).toBe(false);
    expect(stderr).not.toContain("SQLite");
    const blocked = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "owner-auth", "--vault", vaultPath], { env, encoding: "utf8", timeout: 10000 });
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toBe("");
    expect(blocked.stderr).toContain("Anonymous mode does not need owner setup");
    expect(fs.existsSync(appData)).toBe(false);
  });

  it("validates CLI/ENV budgets without allowing zero/unlimited", () => {
    expect(ownerOptions({ MCP_AUTH_LOGIN_MAX_FAILURES: "8" }, ["--auth-login-max-failures", "3", "--owner-port=39147"]).maxFailures).toBe(3);
    expect(ownerOptions({}, []).windowSeconds).toBe(900);
    for (const value of ["0", "-1", "1.5", "21", "bad"]) expect(() => ownerOptions({ MCP_AUTH_LOGIN_MAX_FAILURES: value }, [])).toThrow();
    expect(() => ownerOptions({}, ["--owner-port"])).toThrow("Missing");
  });

  it("enforces pair and peer budgets separately with expiry, success reset and no account-wide lockout", () => {
    const db = new DatabaseSync(":memory:"); db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)'); migrateOwnerSchema(db);
    const budget = new LoginBudget(db, 2, 900);
    expect(budget.reserve(email, "peer1", 1000)).toBe(0); budget.finish(email, "peer1", false, 1000);
    expect(budget.reserve(email, "peer1", 1500)).toBe(1);
    expect(budget.reserve(email, "peer1", 2000)).toBe(0); budget.finish(email, "peer1", false, 2000);
    expect(budget.reserve(email, "peer1", 5000)).toBeGreaterThan(0);
    expect(budget.reserve(email, "peer2", 5000)).toBe(0); budget.finish(email, "peer2", true, 5000);
    expect(budget.reserve(email, "peer2", 5000)).toBe(0);
    expect(budget.reserve(email, "peer1", 902000)).toBe(0);
    for (let i = 0; i < 8; i++) { expect(budget.reserve(`a${String(i)}`, "peer3", 1000000 + i * 60000)).toBe(0); budget.finish(`a${String(i)}`, "peer3", false, 1000000 + i * 60000); }
    expect(budget.reserve("fresh", "peer3", 1500000)).toBeGreaterThan(0);
    db.close();
  });
});
