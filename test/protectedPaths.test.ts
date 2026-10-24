import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { await fixture.close(); });
const protectedPaths = [".obsidian/config.md", ".git/config", ".env", "Notes/.env.local", "Notes/.GIT/secret.md"];

describe("SEC-03 protected paths", () => {
  it.each(protectedPaths)("denies direct reads/writes/metadata/listing for %s", async (target) => {
    await fs.mkdir(path.dirname(path.join(fixture.vault, target)), { recursive: true });
    await fs.writeFile(path.join(fixture.vault, target), "synthetic_secret_marker");
    for (const operation of [() => fixture.backend.readNote(target), () => fixture.backend.statPath(target), () => fixture.backend.readNoteMetadata(target), () => fixture.backend.writeNote(target, "bad"), () => fixture.backend.createFolder(`${target}/new`), () => fixture.backend.deletePath(target), () => fixture.backend.movePath(target, "Moved.md"), () => fixture.backend.movePath("Comments.md", target)]) {
      await expect(operation()).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
    const parent = path.posix.dirname(target);
    if (parent === "." || parent === "Notes") expect((await fixture.backend.listFiles(parent === "." ? "" : parent)).entries.map((e) => e.path)).not.toContain(target);
  });

  it.each([".git:stream", ".git./config", ".obsidian /config", ".env."])("rejects platform aliases %s before filesystem access", async (target) => {
    await expect(fixture.backend.readNote(target)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it.each(["scan", "indexed"] as const)("excludes sensitive filenames from %s search, watcher and persisted cache", async (indexMode) => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, indexMode, watchMode: "on" });
    await backend.initialize();
    try {
      await fs.writeFile(path.join(fixture.vault, ".env.secret.md"), "sensitive_unique_marker");
      await fs.writeFile(path.join(fixture.vault, "Allowed.md"), "ordinary_watch_marker");
      await expect.poll(async () => (await backend.search({ query: "ordinary_watch_marker", limit: 10 })).results, { timeout: 3000 }).toHaveLength(1);
      await backend.rebuildSearchIndex();
      expect((await backend.search({ regex: "sensitive_unique_marker", limit: 10 })).results).toEqual([]);
    } finally { await backend.close(); }
    for (const directory of await fs.readdir(fixture.config.cacheDir)) {
      const text = await fs.readFile(path.join(fixture.config.cacheDir, directory, "search-index.json"), "utf8").catch(() => "");
      expect(text).not.toContain("sensitive_unique_marker");
    }
  });

  it("protects canonical aliases and directory operations containing protected descendants", async () => {
    await fs.mkdir(path.join(fixture.vault, "Container/.obsidian"), { recursive: true });
    await fs.writeFile(path.join(fixture.vault, "Container/.obsidian/config.md"), "synthetic_secret_marker");
    await fs.symlink(path.join(fixture.vault, "Container/.obsidian"), path.join(fixture.vault, "Alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(fixture.backend.readNote("Alias/config.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(fixture.backend.deletePath("Container", { recursive: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(fixture.backend.movePath("Container", "Moved")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await fixture.backend.listFiles()).entries.map((e) => e.path)).not.toContain("Alias");
    expect((await fixture.backend.search({ regex: "synthetic_secret_marker", limit: 10 })).results).toEqual([]);
    expect((await fixture.backend.readNote("Comments.md")).content).toContain("Body stays");
  });
});
