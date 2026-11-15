import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startOwnerServer } from "../dist/auth/http.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-fe-002a-"));
const vaultPath = path.join(root, "vault");
const authDirectory = path.join(root, "auth");
const screenshots = fileURLToPath(new URL("../docs/screenshots/fe-002a/", import.meta.url));
await fs.mkdir(vaultPath, { recursive: true });
await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
await fs.chmod(authDirectory, 0o700);

const report = { flow: [], viewports: [], errors: [], signedQueryPreserved: false, cspViolations: 0 };
const ownerPort = Number(process.env.OWNER_PORT) || 39146;
let service;
let browser;
try {
  service = await startOwnerServer({
    directory: authDirectory,
    vaultPath,
    port: ownerPort,
    maxFailures: 1,
    windowSeconds: 1,
    ownerUiMode: "react",
  });
  browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => { requests.push(request.url()); });
  page.on("pageerror", (error) => { report.errors.push(error.message); });
  page.on("response", (response) => {
    const responsePath = new URL(response.url()).pathname;
    const expectedSessionCheck = response.status() === 401 && responsePath === "/api/auth/get-session";
    const expectedExpiredRotation = response.status() === 401 && responsePath === "/api/auth/change-password";
    const expectedLoginRejection = [401, 429].includes(response.status()) && responsePath === "/api/auth/sign-in/email";
    const expectedNoOAuthProvider = response.status() === 404 && responsePath === "/oauth/authorize";
    const expectedOAuthDisabled = response.status() === 404 && responsePath === "/oauth/grants";
    if (response.status() >= 400 && !expectedSessionCheck && !expectedExpiredRotation && !expectedLoginRejection
      && !expectedNoOAuthProvider && !expectedOAuthDisabled) {
      report.errors.push(`${response.status()} ${responsePath}`);
    }
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) report.cspViolations++;
  });

  const response = await page.goto(`${service.origin}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").waitFor();
  assert.equal(response?.status(), 200);
  assert.match(response.headers()["content-security-policy"] ?? "", /script-src 'self'/u);
  assert.match(response.headers()["content-security-policy"] ?? "", /style-src 'self'/u);
  assert.match(response.headers()["content-security-policy"] ?? "", /img-src 'self'/u);
  assert.doesNotMatch(response.headers()["content-security-policy"] ?? "", /unsafe-inline|unsafe-eval|\*/u);
  assert.equal(await page.evaluate("localStorage.length + sessionStorage.length"), 0);
  report.flow.push("built private React login served with strict CSP");

  await page.getByLabel("Username").fill("unknown-owner");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.getByRole("alert").getByText("Sign-in unsuccessful. Check your credentials and try again.").waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  await page.getByLabel("Username").fill("unknown-owner");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.getByRole("status").getByText(/Try again in \d+ seconds/u).waitFor();
  const retryButton = page.getByRole("button", { name: "Sign in securely" });
  for (let attempt = 0; attempt < 50 && !(await retryButton.isEnabled()); attempt++) await page.waitForTimeout(100);
  assert.equal(await retryButton.isEnabled(), true, "Retry-After cooldown should expire");
  report.flow.push("invalid credentials are generic and rate limits honor Retry-After");

  await page.getByLabel("Username").fill("obsidian-admin");
  await page.getByLabel("Password", { exact: true }).fill("admin39145");
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.getByText("Update your password", { exact: true }).waitFor();
  report.flow.push("bootstrap login requires forced password rotation");

  const newPassword = "RotatedOwnerPassword456!";
  const rotationCookies = await context.cookies(service.origin);
  const rotationCookieHeader = rotationCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const signOut = await globalThis.fetch(`${service.origin}/api/auth/sign-out`, {
    method: "POST",
    headers: {
      cookie: rotationCookieHeader,
      Origin: service.origin,
      "Content-Type": "application/json",
      "X-VaultBridge-CSRF": "1",
    },
    body: "{}",
  });
  assert.equal(signOut.status, 200);
  await page.getByLabel("Current password").fill("admin39145");
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("alert").getByText("Your owner session expired. Sign in again to continue.").waitFor();
  await page.getByLabel("Username").fill("obsidian-admin");
  await page.getByLabel("Password", { exact: true }).fill("admin39145");
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.getByText("Update your password", { exact: true }).waitFor();
  report.flow.push("expired rotation session returns to login before retry");

  await page.getByLabel("Current password").fill("admin39145");
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByText(/All existing sessions and owner grants were revoked/u).waitFor();
  const oldCookies = await context.cookies(service.origin);
  const oldCookieHeader = oldCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const staleSession = await globalThis.fetch(`${service.origin}/api/auth/get-session`, { headers: { cookie: oldCookieHeader } });
  assert.equal(staleSession.status, 401);
  report.flow.push("password rotation invalidates the previous session and returns to login");

  const rawQuery = "scope=vault%3Aread&state=a%2Fb%3Dc&state=second&resource=https%3A%2F%2Fexample.test%2Fmcp";
  const continuationRequest = page.waitForRequest((request) => request.url().endsWith("/oauth/authorize") && request.method() === "POST");
  await page.goto(`${service.origin}/login?${rawQuery}`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").waitFor();
  await page.getByLabel("Username").fill("obsidian-admin");
  await page.getByLabel("Password", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  const oauthRequest = await continuationRequest;
  const body = JSON.parse(oauthRequest.postData() ?? "{}");
  assert.equal(body.oauth_query, rawQuery);
  report.signedQueryPreserved = true;
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  report.flow.push("signed OAuth query remains byte-for-byte intact through login");

  await page.goto(`${service.origin}/admin`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Account \/ admin/u }).waitFor();
  report.flow.push("rotated owner can sign in and reach the existing admin route");

  await page.getByRole("button", { name: "Logout" }).click();
  await page.goto(`${service.origin}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").waitFor();
  report.flow.push("sign out returns to unauthenticated login");

  await fs.mkdir(screenshots, { recursive: true });
  for (const [width, height] of [[1672, 941], [1440, 900], [1280, 800], [768, 1024], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${service.origin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Username").waitFor();
    const card = await page.locator(".vb-auth-panel").boundingBox();
    assert(card, `Login panel missing at ${width}x${height}`);
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Horizontal overflow at ${width}`);
    if (width >= 1024) assert(card.x >= width * 0.6, `Login panel not on the right at ${width}`);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(accessibility.violations.map((violation) => violation.id), [], `Accessibility violations at ${width}x${height}`);
    await page.screenshot({
      path: path.join(screenshots, `owner-login-${width}x${height}.jpg`),
      fullPage: true,
      type: "jpeg",
      quality: 88,
    });
    report.viewports.push({ width, height, noHorizontalOverflow: true });
  }

  await page.goto(`${service.origin}/recover`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").waitFor();
  assert.equal(await page.getByLabel("One-time recovery token").count(), 0, "Recovery must stay unavailable outside recovery mode");
  report.flow.push("recovery form is not exposed in normal owner mode");

  await service.close();
  service = undefined;
  const recoveryDirectory = path.join(root, "recovery-auth");
  const seeded = await startOwnerServer({
    directory: recoveryDirectory,
    vaultPath,
    port: ownerPort,
    ownerPassword: newPassword,
    ownerUiMode: "react",
  });
  await seeded.close();
  service = await startOwnerServer({
    directory: recoveryDirectory,
    vaultPath,
    port: ownerPort,
    recover: true,
    ownerUiMode: "react",
  });
  const recoveryToken = (await fs.readFile(service.tokenPath, "utf8")).trim();
  const recoveryPassword = "RecoveredOwnerPassword789!";
  await page.goto(`${service.origin}/recover`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("One-time recovery token").waitFor();
  await page.getByLabel("One-time recovery token").fill(recoveryToken);
  await page.getByLabel("New password").fill(recoveryPassword);
  await page.getByRole("button", { name: "Restore owner access" }).click();
  await page.getByText("Recovery completed. Sign in with your new password.").waitFor();
  assert.equal(await page.evaluate("localStorage.length + sessionStorage.length"), 0);
  report.flow.push("one-time local recovery completes and returns to fresh login");
  await page.getByLabel("Username").fill("obsidian-admin");
  await page.getByLabel("Password", { exact: true }).fill(recoveryPassword);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.getByRole("heading", { name: /Account \/ admin/u }).waitFor();
  report.flow.push("recovered owner can sign in with the replacement password");

  assert.deepEqual(report.errors, []);
  assert.equal(report.cspViolations, 0);
  assert(requests.every((url) => new URL(url).origin === service.origin), "Owner UI made a remote network request");
  await fs.writeFile(path.join(screenshots, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  await service?.close();
  await fs.rm(root, { recursive: true, force: true });
}
