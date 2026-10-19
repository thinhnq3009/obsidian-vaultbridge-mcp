import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, regressionNotes, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { await fixture?.close(); });

describe("OBS-001 filesystem safety", () => {
  it.each(["../outside/Secret.md", "Nested/../../outside/Secret.md", "..\\outside\\Secret.md", "/tmp/obs-001-secret.md", "C:\\vault\\Secret.md", "\\\\server\\share\\Secret.md", "bad\0.md"])("denies read/write traversal or absolute input: %s", async (input) => {
    await expect(fixture.backend.readNote(input)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(fixture.backend.writeNote(input, "bad")).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await fs.readdir(fixture.outside)).toEqual([]);
  });

  it("denies read and every note mutation through an external symlink, including new children", async () => {
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), regressionNotes["Comments.md"]);
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Escape"), process.platform === "win32" ? "junction" : "dir");
    const backend = fixture.backend;
    const revision = revisionOf(regressionNotes["Comments.md"]);
    const operations = [
      () => backend.readNote("Escape/Secret.md"),
      () => backend.writeNote("Escape/New/Nested.md", "bad"),
      () => backend.writeNote("Escape/Secret.md", "bad", { mode: "replace", expectedRevision: revision }),
      () => backend.appendToNote("Escape/Secret.md", "bad", revision),
      () => backend.patchHeading("Escape/Secret.md", "Kế hoạch 🚀", "bad", "replace", { expectedRevision: revision }),
      () => backend.patchFrontmatter("Escape/Secret.md", "status", "bad", "replace", true, revision),
      () => backend.deletePath("Escape/Secret.md", { expectedRevision: revision }),
      () => backend.movePath("Escape/Secret.md", "Moved.md", { expectedRevision: revision }),
      () => backend.movePath("Comments.md", "Escape/Moved.md", { expectedRevision: revision }),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await fs.readFile(path.join(fixture.outside, "Secret.md"), "utf8")).toBe(regressionNotes["Comments.md"]);
    expect(await fs.readdir(fixture.outside)).toEqual(["Secret.md"]);
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
  });

  it("checks canonical paths and prefix boundaries for read/write scopes", async () => {
    await fs.mkdir(path.join(fixture.vault, "Public"));
    await fs.mkdir(path.join(fixture.vault, "Private"));
    await fs.writeFile(path.join(fixture.vault, "Private/Secret.md"), "secret");
    await fs.symlink(path.join(fixture.vault, "Private"), path.join(fixture.vault, "Public/Alias"), process.platform === "win32" ? "junction" : "dir");
    const scoped = new FilesystemVaultBackend({ ...fixture.config, readPaths: ["Public"], writePaths: ["Public"] });
    await scoped.initialize();
    try {
      for (const target of ["Private/Secret.md", "Publicity/Secret.md", "Public/Alias/Secret.md"]) {
        await expect(scoped.readNote(target)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        await expect(scoped.writeNote(target, "bad", { mode: "replace", expectedRevision: revisionOf("secret") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      }
      await expect(scoped.writeNote("Public/Alias/New/Nested.md", "bad")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await scoped.writeNote("Public/Allowed.md", "allowed");
      expect((await scoped.readNote("Public/Allowed.md")).content).toBe("allowed");
    } finally { await scoped.close(); }
    expect(await fs.readFile(path.join(fixture.vault, "Private/Secret.md"), "utf8")).toBe("secret");
  });

  it("KNOWN K03: search bypasses readPaths, even though direct read is denied", async () => {
    const scoped = new FilesystemVaultBackend({ ...fixture.config, readPaths: ["Public"] });
    await scoped.initialize();
    try {
      await expect(scoped.readNote("Comments.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      const search = await scoped.search({ query: "Body stays", limit: 10 });
      expect(search.results.map((result) => result.path)).toEqual(["Comments.md"]);
      expect(search.results[0]?.snippet).toContain("Body stays");
    } finally { await scoped.close(); }
  });

  it("search excludes control directories and static symlinks", async () => {
    for (const folder of [".obsidian", ".git"]) {
      await fs.mkdir(path.join(fixture.vault, folder));
      await fs.writeFile(path.join(fixture.vault, folder, "Hidden.md"), "excluded_marker");
    }
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), "excluded_marker");
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Escape"), process.platform === "win32" ? "junction" : "dir");
    await fixture.backend.rebuildSearchIndex();
    expect((await fixture.backend.search({ query: "excluded_marker", limit: 10 })).results).toEqual([]);
  });

  it("KNOWN K04: scan/watch-off search misses a create until explicit rebuild", async () => {
    await fixture.backend.writeNote("Created.md", "fresh_marker");
    expect((await fixture.backend.readNote("Created.md")).content).toBe("fresh_marker");
    expect((await fixture.backend.search({ query: "fresh_marker", limit: 10 })).results).toEqual([]);
    await fixture.backend.rebuildSearchIndex();
    expect((await fixture.backend.search({ query: "fresh_marker", limit: 10 })).results.map((result) => result.path)).toEqual(["Created.md"]);
  });

  it("enforces UTF-8 byte size for create/replace without changing existing content", async () => {
    const limited = new FilesystemVaultBackend({ ...fixture.config, maxFileSizeBytes: 8 });
    await limited.initialize();
    try {
      await limited.writeNote("Small.md", "base");
      await expect(limited.writeNote("TooBig.md", "🚀🚀x")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      await expect(limited.writeNote("Small.md", "🚀🚀x", { mode: "replace", expectedRevision: revisionOf("base") })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      expect(await fixture.bytes("Small.md")).toEqual(Buffer.from("base"));
      expect(await fs.readdir(fixture.vault)).not.toContain("TooBig.md");
    } finally { await limited.close(); }
  });

  it("KNOWN K05: append/heading/frontmatter can exceed the configured write size", async () => {
    const content = "---\na: b\n---\n# H\nx\n";
    const limited = new FilesystemVaultBackend({ ...fixture.config, maxFileSizeBytes: Buffer.byteLength(content) });
    await limited.initialize();
    try {
      const operations = [
        (name: string) => limited.appendToNote(name, "z".repeat(100), revisionOf(content)),
        (name: string) => limited.patchHeading(name, "H", "z".repeat(100), "replace", { expectedRevision: revisionOf(content) }),
        (name: string) => limited.patchFrontmatter(name, "a", "z".repeat(100), "replace", false, revisionOf(content)),
      ];
      for (const [index, mutate] of operations.entries()) {
        const name = `Limit-${index}.md`;
        await limited.writeNote(name, content);
        await mutate(name);
        expect((await fixture.bytes(name)).length).toBeGreaterThan(Buffer.byteLength(content));
        await expect(limited.readNote(name)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      }
    } finally { await limited.close(); }
  });
});
