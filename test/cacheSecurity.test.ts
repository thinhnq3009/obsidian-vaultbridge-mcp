import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";
let fixture: RegressionFixture;
let backend: FilesystemVaultBackend | undefined;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await backend?.close(); backend = undefined; await fixture.close(); });
async function cachePath() {
  return path.join(fixture.config.cacheDir, createHash("sha256").update(await fs.realpath(fixture.vault)).digest("hex").slice(0, 16));
}
describe("SEC-07 private plaintext cache", () => {
  it.skipIf(process.platform === "win32")("repairs existing permissive directories and replaces the old index privately", async () => {
    const directory = await cachePath();
    await fs.chmod(fixture.config.cacheDir, 0o777);
    await fs.chmod(directory, 0o777);
    await fs.writeFile(path.join(directory, "search-index.json"), "stale_private_marker", { mode: 0o666 });
    backend = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed" });
    const originalUmask = process.umask(0);
    try { await backend.initialize(); } finally { process.umask(originalUmask); }
    for (const target of [fixture.config.cacheDir, directory]) expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, "search-index.json"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(directory, "search-index.json"), "utf8")).not.toContain("stale_private_marker");
  });
  it("rejects cache-directory links", async () => {
    const directory = await cachePath();
    await fs.rm(directory, { recursive: true });
    await fs.symlink(fixture.outside, directory, process.platform === "win32" ? "junction" : "dir");
    backend = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed" });
    await expect(backend.initialize()).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fs.readdir(fixture.outside)).toEqual([]);
  });
  it("removes the private temporary index when rename fails", async () => {
    backend = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed" });
    await backend.initialize();
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("synthetic rename failure"));
    await expect(backend.rebuildSearchIndex()).rejects.toThrow("synthetic rename failure");
    rename.mockRestore();
    await backend.rebuildSearchIndex();
    expect((await fs.readdir(await cachePath())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
