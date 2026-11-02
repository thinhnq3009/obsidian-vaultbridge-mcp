import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* global document, innerWidth, innerHeight, localStorage, sessionStorage, getComputedStyle */
// Globals above are evaluated only inside Playwright's browser callbacks.
// Tests only the built preview on a separate loopback origin, never the owner service.
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = new URL("../docs/screenshots/fe-001/", import.meta.url);
const origin = "http://127.0.0.1:4173";
const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--config", "web/vite.config.ts"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });
const closed = once(child, "close");
let browser;
const report = { viewports: [], states: [], network: "preview origin only; zero credential requests", errors: [] };
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`Preview failed: ${output}`);
    // Wait for this server's readiness, not some pre-existing process on the port.
    if (output.includes(origin)) break;
    if (attempt >= 100) throw new Error(`Preview startup timeout: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  await fs.mkdir(evidence, { recursive: true });
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => { report.errors.push(error.message); });
  const requests = [];
  page.on("request", (request) => { requests.push({ url: request.url(), method: request.method() }); });
  page.on("response", (response) => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  for (const [width, height] of [[1672, 941], [1440, 900], [1280, 800], [768, 1024], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin, { waitUntil: "networkidle" });
    const bounds = await page.locator(".vb-auth-panel").boundingBox();
    const art = await page.locator(".vb-login-art").boundingBox();
    assert(bounds && art);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${width}`);
    if (width >= 1024) {
      assert(bounds.x >= width * .60, `Form must remain on the right at ${width}`);
      assert(bounds.y >= 0 && bounds.y + bounds.height <= height, "Desktop form must fit vertically");
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `Default desktop should fit the viewport at ${width}`);
    } else {
      assert(bounds.y >= art.y + art.height, "Tablet/mobile form must not cover the crystal");
    }
    const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(a11y.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), [], `Accessibility violations at ${width}`);
    await page.screenshot({ path: fileURLToPath(new URL(`login-${width}x${height}.jpg`, evidence)), fullPage: true, type: "jpeg", quality: 90 });
    report.viewports.push({ width, height, rightOrStacked: true, noOverflow: true, axeViolations: 0 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const state of ["error", "rate-limited", "loading", "disabled", "expired"]) {
    await page.goto(`${origin}/?state=${state}`, { waitUntil: "networkidle" });
    const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(a11y.violations.map((violation) => violation.id), [], `Accessibility violations in ${state}`);
    await page.screenshot({ path: fileURLToPath(new URL(`login-${state}.jpg`, evidence)), fullPage: true, type: "jpeg", quality: 90 });
    report.states.push({ state, axeViolations: 0 });
  }
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("Username", { exact: true }).fill("preview-owner");
  await page.getByLabel("Password", { exact: true }).fill("preview-only-not-a-secret");
  await page.getByRole("button", { name: "Show password" }).click();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "text");
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await page.getByRole("status").filter({ hasText: "No credentials were sent" }).waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.goto(origin, { waitUntil: "networkidle" });
  // Keyboard validation and visible focus; empty submit must focus the username.
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.getByLabel("Username", { exact: true }).evaluate((element) => element.matches(":focus-visible")), true);
  await page.screenshot({ path: fileURLToPath(new URL("login-validation-focus.jpg", evidence)), fullPage: true, type: "jpeg", quality: 90 });
  const trigger = page.getByRole("button", { name: "Need help accessing your vault?" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Local owner recovery" });
  await dialog.waitFor();
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(a11y.violations.map((violation) => violation.id), [], "Dialog accessibility");
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, "Dialog must trap focus");
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.goto(`${origin}/?state=loading`, { waitUntil: "networkidle" });
  assert.equal(await page.locator(".vb-spinner").evaluate((element) => getComputedStyle(element).animationName), "none", "Reduced motion must disable spinner animation");
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, origin, "No remote runtime dependencies or owner API calls");
    assert.equal(request.method, "GET", "Preview must never submit credentials");
  }
  assert.deepEqual(report.errors, [], "Browser/asset errors");
  await fs.writeFile(new URL("report.json", evidence), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
