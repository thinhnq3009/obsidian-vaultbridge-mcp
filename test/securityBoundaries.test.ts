import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";
import { VaultAccessPolicy } from "../src/backend/accessPolicy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import type { IndexMode } from "../src/types.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
const backends: FilesystemVaultBackend[] = [];
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.close();
  await fixture.close();
});

async function scopedBackend(indexMode: IndexMode, watchMode: "on" | "off" = "off") {
  const backend = new FilesystemVaultBackend({ ...fixture.config, readPaths: ["Public"], indexMode, watchMode });
  backends.push(backend);
  await backend.initialize();
  return backend;
}

async function seedScopes() {
  for (const folder of ["Public", "Private", "Publicity"]) {
    await fs.mkdir(path.join(fixture.vault, folder));
    await fs.writeFile(path.join(fixture.vault, folder, "Note.md"), `sharedmarker ${folder}marker`);
  }
}

async function indexText() {
  const vaultKey = createHash("sha256").update(await fs.realpath(fixture.vault)).digest("hex").slice(0, 16);
  return fs.readFile(path.join(fixture.config.cacheDir, vaultKey, "search-index.json"), "utf8");
}

describe("vault security boundaries", () => {
  it.each(["", ".", "./", ".\\", "././"])("rejects deletion of root alias %j and preserves the vault", async (alias) => {
    await expect(fixture.backend.deletePath(alias, { recursive: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await fs.stat(fixture.vault)).isDirectory()).toBe(true);
    expect(await fixture.bytes("Comments.md")).not.toHaveLength(0);
  });

  it.each(["", ".", "./", ".\\", "././"])("rejects root alias %j as either move endpoint", async (alias) => {
    await expect(fixture.backend.movePath(alias, "MovedVault")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(fixture.backend.movePath("Comments.md", alias)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fixture.bytes("Comments.md")).not.toHaveLength(0);
  });

  it("rejects canonical symlink aliases of the root for destructive operations", async () => {
    await fs.symlink(fixture.vault, path.join(fixture.vault, "RootAlias"), process.platform === "win32" ? "junction" : "dir");
    await expect(fixture.backend.deletePath("RootAlias", { recursive: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(fixture.backend.movePath("RootAlias", "Moved")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(fixture.backend.movePath("Comments.md", "RootAlias")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fixture.bytes("Comments.md")).not.toHaveLength(0);
  });

  it.each(["scan", "indexed"] as const)("filters before pagination in %s mode and applies advanced-search scopes", async (mode) => {
    await seedScopes();
    const backend = await scopedBackend(mode);
    await expect(backend.readNote("Private/Note.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const page = await backend.search({ query: "sharedmarker", limit: 1, sort: "path" });
    expect(page.results.map((result) => result.path)).toEqual(["Public/Note.md"]);
    expect(page.nextCursor).toBeUndefined();
    expect((await backend.search({ regex: "Privatemarker|Publicitymarker", limit: 10 })).results).toEqual([]);
    expect((await backend.rebuildSearchIndex()).indexedFiles).toBe(1);
    if (mode === "indexed") {
      expect(await indexText()).not.toContain("Privatemarker");
      expect(await indexText()).not.toContain("Publicitymarker");
    }
  });

  it.each(["scan", "indexed"] as const)("purges the previous unrestricted cache on scope change to %s", async (mode) => {
    await seedScopes();
    const unrestricted = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed" });
    await unrestricted.initialize();
    await unrestricted.close();
    expect(await indexText()).toContain("Privatemarker");
    const restricted = await scopedBackend(mode);
    expect((await restricted.search({ query: "Privatemarker", limit: 10 })).results).toEqual([]);
    const cache = await indexText().catch(() => "");
    expect(cache).not.toContain("Privatemarker");
    expect(cache).not.toContain("Comments.md");
  });

  it("does not return cached snippets after an allowed path becomes an external link", async () => {
    await seedScopes();
    const backend = await scopedBackend("indexed");
    await fs.writeFile(path.join(fixture.outside, "Note.md"), "outsidemarker");
    await fs.rename(path.join(fixture.vault, "Public"), path.join(fixture.vault, "Original"));
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Public"), process.platform === "win32" ? "junction" : "dir");
    expect((await backend.search({ query: "sharedmarker", limit: 10 })).results).toEqual([]);
    expect(await indexText()).not.toContain("sharedmarker");
  });

  it("authorizes individual-file scopes before opening note bodies", async () => {
    await seedScopes();
    const open = vi.spyOn(fs, "open");
    const backend = new FilesystemVaultBackend({ ...fixture.config, readPaths: ["Public/./Note.md"], indexMode: "indexed" });
    backends.push(backend);
    await backend.initialize();
    expect((await backend.search({ regex: "sharedmarker", limit: 10 })).results.map((result) => result.path)).toEqual(["Public/Note.md"]);
    expect(open.mock.calls.map(([file]) => file)).toEqual([path.join(fixture.vault, "Public/Note.md")]);
    await expect(backend.readNote("Public/Other.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await backend.readNote("Public/./Note.md")).content).toContain("Publicmarker");
  });

  it("rejects a parent replaced by an external link between authorization and open", async () => {
    await seedScopes();
    await fs.writeFile(path.join(fixture.outside, "Note.md"), "outsidemarker");
    const target = path.join(fixture.vault, "Public/Note.md");
    const realOpen = fs.open;
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!replaced && args[0] === target) {
        replaced = true;
        await fs.rename(path.join(fixture.vault, "Public"), path.join(fixture.vault, "Original"));
        await fs.symlink(fixture.outside, path.join(fixture.vault, "Public"), process.platform === "win32" ? "junction" : "dir");
      }
      return realOpen(...args);
    });
    const backend = await scopedBackend("indexed");
    expect(replaced).toBe(true);
    expect((await backend.search({ regex: "outsidemarker|sharedmarker", limit: 10 })).results).toEqual([]);
    expect(await indexText()).not.toContain("outsidemarker");
  });

  it("rejects an outside descriptor even when the authorized path is restored before validation", async () => {
    await seedScopes();
    await fs.writeFile(path.join(fixture.outside, "Note.md"), "outsidemarker");
    const target = path.join(fixture.vault, "Public/Note.md");
    const realOpen = fs.open;
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (replaced || args[0] !== target) return realOpen(...args);
      replaced = true;
      const publicDir = path.dirname(target);
      const original = path.join(fixture.vault, "Original");
      await fs.rename(publicDir, original);
      await fs.symlink(fixture.outside, publicDir, process.platform === "win32" ? "junction" : "dir");
      const handle = await realOpen(...args);
      try {
        await fs.unlink(publicDir);
        await fs.rename(original, publicDir);
      } catch (error) {
        await handle.close();
        throw error;
      }
      return handle;
    });
    const backend = await scopedBackend("indexed");
    expect(replaced).toBe(true);
    expect((await backend.search({ regex: "outsidemarker|sharedmarker", limit: 10 })).results).toEqual([]);
    expect(await indexText()).not.toContain("outsidemarker");
    await backend.rebuildSearchIndex();
    expect((await backend.search({ query: "sharedmarker", limit: 10 })).results.map((result) => result.path)).toEqual(["Public/Note.md"]);
  });

  it("ignores post-start external directory links even with unrestricted read scopes", async () => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed", watchMode: "on" });
    backends.push(backend);
    await backend.initialize();
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Linked"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), "external_synthetic_marker");
    await fs.writeFile(path.join(fixture.vault, "Allowed.md"), "watcher_control_marker");
    await expect.poll(async () => (await backend.search({ regex: "watcher_control_marker", limit: 10 })).results, { timeout: 3000 }).toHaveLength(1);
    expect((await backend.search({ regex: "external_synthetic_marker", limit: 10 })).results).toEqual([]);
    await backend.close();
    expect(await indexText()).not.toContain("external_synthetic_marker");
  }, 10_000);

  it("ignores an external Markdown file symlink created after watcher startup", async (context) => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, indexMode: "indexed", watchMode: "on" });
    backends.push(backend);
    await backend.initialize();
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), "external_file_marker");
    try {
      await fs.symlink(path.join(fixture.outside, "Secret.md"), path.join(fixture.vault, "Linked.md"), "file");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") context.skip();
      throw error;
    }
    await fs.writeFile(path.join(fixture.vault, "Allowed.md"), "file_control_marker");
    await expect.poll(async () => (await backend.search({ regex: "file_control_marker", limit: 10 })).results, { timeout: 3000 }).toHaveLength(1);
    expect((await backend.search({ regex: "external_file_marker", limit: 10 })).results).toEqual([]);
    await backend.close();
    expect(await indexText()).not.toContain("external_file_marker");
  }, 10_000);

  it("keeps watcher events inside the read scope and vault while updating allowed notes", async () => {
    await seedScopes();
    const watch = chokidar.watch;
    let watcher!: FSWatcher;
    const events: Array<{ event: string; path: string }> = [];
    vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
      watcher = watch(...args);
      watcher.on("all", (event, file) => { events.push({ event, path: path.relative(fixture.vault, file) }); });
      return watcher;
    });
    const backend = await scopedBackend("indexed", "on");
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Public/Outside"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(path.join(fixture.vault, "Private"), path.join(fixture.vault, "Public/Alias"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), "outsidemarker");
    await fs.writeFile(path.join(fixture.vault, "Private/Later.md"), "privatelatermarker");
    await fs.writeFile(path.join(fixture.vault, "Public/Added.md"), "watchermarker");
    try {
      // This assertion measures watcher ingestion, not regex-worker scheduling.
      await expect.poll(async () => (await backend.search({ query: "watchermarker", match: "exact", limit: 10 })).results.map((result) => result.path), { timeout: 3000 }).toEqual(["Public/Added.md"]);
    } catch (error) {
      const policy = new VaultAccessPolicy(await fs.realpath(fixture.vault), false, ["Public"], []);
      throw new Error(`Watcher evidence: ${JSON.stringify({ events, watched: watcher.getWatched(), status: await backend.status(), readable: await policy.allowsSearchPath(path.join(fixture.vault, "Public/Added.md")) })}`, { cause: error });
    }
    await fs.writeFile(path.join(fixture.vault, "Public/Added.md"), "changedmarker");
    await expect.poll(async () => (await backend.search({ query: "changedmarker", match: "exact", limit: 10 })).results, { timeout: 3000 }).toHaveLength(1);
    await fs.rename(path.join(fixture.vault, "Public/Added.md"), path.join(fixture.vault, "Public/Renamed.md"));
    await expect.poll(async () => (await backend.search({ query: "changedmarker", match: "exact", limit: 10 })).results.map((result) => result.path), { timeout: 3000 }).toEqual(["Public/Renamed.md"]);
    await fs.rename(path.join(fixture.vault, "Private/Later.md"), path.join(fixture.vault, "Private/Renamed.md"));
    await fs.unlink(path.join(fixture.vault, "Public/Renamed.md"));
    await expect.poll(async () => (await backend.search({ query: "changedmarker", match: "exact", limit: 10 })).results, { timeout: 3000 }).toHaveLength(0);
    expect((await backend.search({ regex: "outsidemarker|Privatemarker|privatelatermarker", limit: 10 })).results).toEqual([]);
    await backend.close();
    const cache = await indexText();
    for (const marker of ["outsidemarker", "Privatemarker", "privatelatermarker"]) expect(cache).not.toContain(marker);
  }, 15_000);
});
