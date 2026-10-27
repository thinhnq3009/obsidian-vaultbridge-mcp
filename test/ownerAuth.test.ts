import fs from "node:fs";
import http from "node:http";
import { setTimeout } from "node:timers/promises";
import { spawnSync } from "node:child_process";
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
  service = await startOwnerServer({ directory, vaultPath, port: 0, ...extra });
  return service;
}
async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${service!.origin}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: service!.origin, "X-VaultBridge-CSRF": "1", ...headers }, body: JSON.stringify(body),
  });
}
async function enroll() {
  return post("/setup", { token: fs.readFileSync(service!.tokenPath!, "utf8"), email, password });
}
async function login() {
  const response = await post("/api/auth/sign-in/email", { email, password });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!).join("; ");
  expect(cookies).toContain("session_token=");
  return { response, cookies };
}

describe("local owner HTTP lifecycle", () => {
  it("bootstraps once, hashes passwords, persists WAL/users/key/session across restart, logs out", async () => {
    await start();
    const token = fs.readFileSync(service!.tokenPath!, "utf8");
    expect((await enroll()).status).toBe(200);
    expect(fs.existsSync(service!.tokenPath!)).toBe(false);
    expect((await post("/setup", { token, email, password })).status).toBe(400);
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
    expect(db.prepare("SELECT count(*) AS n FROM vaultbridge_migration").get()?.n).toBe(1);
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
    const auth = await createOwnerAuth({ directory, vaultPath, origin });
    try {
      expect(await auth.enroll({ email, password }, fs.readFileSync(auth.tokenPath!, "utf8"))).toBe(true);
      const response = await auth.handle(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { origin, "content-type": "application/json", "x-vaultbridge-csrf": "1" }, body: JSON.stringify({ email, password }),
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
    expect((await post("/setup", { token: "wrong", email, password })).status).toBe(400);
    expect((await post("/setup", { token: "wrong", email, password: "short" })).status).toBe(400);
    const results = await Promise.all([enroll(), enroll()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const { cookies } = await login();
    for (const route of ["sign-up/email", "request-password-reset", "reset-password", "update-user", "change-password"]) {
      expect((await post(`/api/auth/${route}`, { email, password }, { cookie: cookies })).status).toBe(404);
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
    await start(); await enroll();
    const first = (await login()).cookies;
    const second = (await login()).cookies;
    expect((await post("/api/auth/revoke-sessions", {}, { cookie: first })).status).toBe(200);
    for (const cookie of [first, second]) expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
  });

  it("recovers the password locally and invalidates existing sessions", async () => {
    await start(); await enroll();
    const beforeRecovery = (await login()).cookies;
    await service!.close(); service = undefined;
    await start({ recover: true });
    expect((await post("/setup", { token: fs.readFileSync(service!.tokenPath!, "utf8"), password: `${password}-new` })).status).toBe(200);
    expect((await fetch(`${service!.origin}/api/auth/get-session`, { headers: { cookie: beforeRecovery } })).status).toBe(401);
    expect((await post("/api/auth/sign-in/email", { email, password: `${password}-new` })).status).toBe(200);
  });

  it("enforces persistent failure/backoff despite spoofed peer headers and concurrent login floods", async () => {
    await start({ maxFailures: 2 }); await enroll();
    const headers = { "X-Forwarded-For": "192.0.2.1", "X-Real-IP": "192.0.2.2", "X-VaultBridge-Peer-IP": "192.0.2.3" };
    expect((await post("/api/auth/sign-in/email", { email, password: "bad" }, headers)).status).toBe(401);
    const limited = await post("/api/auth/sign-in/email", { email: email.toUpperCase(), password: "bad" }, { "X-Forwarded-For": "192.0.2.4" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await service!.close(); service = undefined;
    await start({ maxFailures: 2 });
    expect((await post("/api/auth/sign-in/email", { email, password })).status).toBe(429);
    const results = await Promise.all(Array.from({ length: 10 }, () => post("/api/auth/sign-in/email", { email: "other@example.test", password: "bad" })));
    expect(results.filter((result) => result.status === 401).length).toBeLessThanOrEqual(2);
    expect(results.some((result) => result.status === 429)).toBe(true);
  });

  it("returns generic login errors and disallows callback redirects", async () => {
    await start(); await enroll();
    const missing = await post("/api/auth/sign-in/email", { email: "missing@example.test", password: "bad" });
    await setTimeout(1100); // Peer-wide progressive backoff applies equally to every account.
    const existing = await post("/api/auth/sign-in/email", { email, password: "bad" });
    expect(missing.status).toBe(existing.status);
    expect(await missing.json()).toEqual(await existing.json());
    expect((await post("/api/auth/sign-in/email", { email, password, callbackURL: "https://evil.test" })).status).toBe(401);
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
    await start({ maxFailures: 20 }); await enroll();
    expect((await post("/api/auth/sign-in/email", { email, password: "bad" })).status).toBe(401);
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    expect(db.prepare('SELECT count(*) AS n FROM "rateLimit"').get()?.n).toBeGreaterThan(0);
    // Exhaust provider state while clearing only our separate failure/backoff state.
    db.exec('DELETE FROM vaultbridge_login_budget; UPDATE "rateLimit" SET count=999');
    db.close();
    const response = await post("/api/auth/sign-in/email", { email: "missing@example.test", password: "bad" });
    expect(response.status).toBe(429);
    expect(response.headers.has("Retry-After")).toBe(true);
  });
});

describe("owner storage and guard contracts", () => {
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
    db.prepare("INSERT INTO vaultbridge_migration VALUES (2, datetime('now'))").run();
    expect(() => migrateOwnerSchema(db)).toThrow("newer"); db.close();
    await expect(createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" })).rejects.toThrow("newer");
  });

  it("rolls back incomplete enrollment and retains the one-time token for a safe retry", async () => {
    const auth = await createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" });
    const token = fs.readFileSync(auth.tokenPath!, "utf8");
    const db = new DatabaseSync(path.join(directory, "auth.sqlite"));
    try {
      db.exec(`CREATE TRIGGER reject_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      await expect(auth.enroll({ email, password }, token)).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM "user"').get()?.n).toBe(0);
      expect(auth.hasOwner()).toBe(false);
      expect(fs.existsSync(auth.tokenPath!)).toBe(true);
      db.exec("DROP TRIGGER reject_account");
      expect(await auth.enroll({ email, password }, token)).toBe(true);
    } finally { db.close(); await auth.close(); }
  });

  it("expires setup tokens and never issues a recovery token without an owner", async () => {
    const auth = await createOwnerAuth({ directory, vaultPath, origin: "http://127.0.0.1:39146" });
    const token = fs.readFileSync(auth.tokenPath!, "utf8");
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try { expect(await auth.enroll({ email, password }, token)).toBe(false); }
    finally { Date.now = realNow; await auth.close(); }
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
