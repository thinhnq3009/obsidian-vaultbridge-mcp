import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startOwnerServer } from "../src/auth/http.js";

const password = "DisposableOwnerPassword123!";
let root: string;
let service: Awaited<ReturnType<typeof startOwnerServer>> | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function rawGet(origin: string, requestPath: string): Promise<number> {
  const target = new URL(origin);
  return await new Promise<number>((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: Number(target.port),
      path: requestPath,
      method: "GET",
    }, (response) => {
      response.resume();
      response.on("end", () => { resolve(response.statusCode ?? 500); });
    });
    request.on("error", reject);
    request.end();
  });
}

async function start(mode: "legacy" | "react", uiDirectory?: string, rootPath?: string) {
  root = rootPath ?? fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-owner-ui-"));
  const vaultPath = path.join(root, "vault");
  fs.mkdirSync(vaultPath);
  service = await startOwnerServer({
    directory: path.join(root, "auth"),
    vaultPath,
    port: 0,
    ownerPassword: password,
    ownerUiMode: mode,
    ...(uiDirectory === undefined ? {} : { ownerUiDirectory: uiDirectory }),
  });
  return service;
}

describe("private owner UI serving", () => {
  it("keeps the legacy UI as the default and adds strict local UI headers", async () => {
    const owner = await start("legacy");
    const response = await fetch(`${owner.origin}/login`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("id=\"login-form\"");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${owner.origin}/recover`)).status).toBe(200);
  });

  it("serves only the built private React entrypoint and allowlisted assets", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-owner-bundle-"));
    const ui = path.join(root, "ui");
    fs.mkdirSync(path.join(ui, "assets"), { recursive: true });
    fs.writeFileSync(path.join(ui, "owner.html"), "<!doctype html><link rel=\"stylesheet\" href=\"./assets/theme-1.css\"><main>React owner entry</main><script type=\"module\" src=\"./assets/app-1.js\"></script>");
    fs.writeFileSync(path.join(ui, "assets", "app-1.js"), "export const owner = true;");
    fs.writeFileSync(path.join(ui, "assets", "theme-1.css"), "body { color: white; }");
    fs.writeFileSync(path.join(ui, "assets", "private.map"), "must not be served");
    fs.writeFileSync(path.join(root, "outside.js"), "private");
    let symlinkAvailable = true;
    try { fs.symlinkSync(path.join(root, "outside.js"), path.join(ui, "assets", "escape.js")); }
    catch { symlinkAvailable = false; }
    const owner = await start("react", ui, root);

    for (const route of ["/login", "/recover"]) {
      const response = await fetch(`${owner.origin}${route}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("React owner entry");
    }
    const script = await fetch(`${owner.origin}/assets/app-1.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("owner = true");
    const style = await fetch(`${owner.origin}/assets/theme-1.css`);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${owner.origin}/assets/private.map`)).status).toBe(404);
    expect([400, 404]).toContain(await rawGet(owner.origin, "/assets/%2e%2e%2fowner.html"));
    if (symlinkAvailable) expect((await fetch(`${owner.origin}/assets/escape.js`)).status).toBe(404);

    for (const route of ["/", "/admin", "/consent"]) {
      expect((await fetch(`${owner.origin}${route}`)).status).toBe(200);
    }
    expect((await fetch(`${owner.origin}/owner.js`)).status).toBe(200);
    expect((await fetch(`${owner.origin}/api/auth/get-session`)).status).toBe(401);
  });

  it("fails visibly when React mode is selected without a bundle", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-owner-missing-"));
    const owner = await start("react", path.join(root, "missing"));
    const response = await fetch(`${owner.origin}/login`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Owner UI bundle unavailable");
  });
});
