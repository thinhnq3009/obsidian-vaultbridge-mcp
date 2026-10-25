import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

function targetFor(relative: string) {
  return path.join(fixture.config.cacheDir, "locks", createHash("sha256").update(`${fixture.vault}:${relative}`).digest("hex"));
}

describe("private mutation locks", () => {
  it("does not create a predictable sentinel file when acquiring a mutation lock", async () => {
    await fixture.backend.writeNote("New.md", "content");
    await expect(fs.lstat(targetFor("New.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(fixture.config.cacheDir, "locks"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("repairs permissive lock directories before acquiring a lock", async () => {
    const directory = path.join(fixture.config.cacheDir, "locks");
    await fs.mkdir(directory, { mode: 0o777 });
    await fs.chmod(directory, 0o777);
    const lock = lockfile.lock;
    let checked = false;
    vi.spyOn(lockfile, "lock").mockImplementation(async (...args) => {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      checked = true;
      return lock(...args);
    });
    const previousUmask = process.umask(0);
    try { await fixture.backend.writeNote("New.md", "content"); }
    finally { process.umask(previousUmask); }
    expect(checked).toBe(true);
  });

  it("rejects a linked lock directory before creating files outside the cache", async () => {
    await fs.symlink(fixture.outside, path.join(fixture.config.cacheDir, "locks"), process.platform === "win32" ? "junction" : "dir");
    await expect(fixture.backend.writeNote("New.md", "content")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fs.readdir(fixture.outside)).toEqual([]);
    await expect(fs.lstat(path.join(fixture.vault, "New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("ignores a planted sentinel symlink rather than following it", async () => {
    const directory = path.join(fixture.config.cacheDir, "locks");
    await fs.mkdir(directory);
    await fs.symlink(path.join(fixture.outside, "Created.md"), targetFor("New.md"));
    await fixture.backend.writeNote("New.md", "content");
    expect(await fs.readdir(fixture.outside)).toEqual([]);
    expect((await fixture.backend.readNote("New.md")).content).toBe("content");
  });

  it("shares the same lock with legacy writers that lock a real sentinel", async () => {
    const target = targetFor("New.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "", { mode: 0o600, flag: "wx" });
    const release = await lockfile.lock(target);
    const lock = lockfile.lock;
    let reached!: () => void;
    const attempted = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(lockfile, "lock").mockImplementation((...args) => {
      reached();
      return lock(...args);
    });
    const writing = fixture.backend.writeNote("New.md", "content");
    await attempted;
    try { await expect(fs.lstat(path.join(fixture.vault, "New.md"))).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await release(); }
    await writing;
    expect((await fixture.backend.readNote("New.md")).content).toBe("content");
  });

  it("serializes revision-safe writes from independent backend instances", async () => {
    const other = new FilesystemVaultBackend(fixture.config);
    await other.initialize();
    try {
      const note = await fixture.backend.writeNote("Shared.md", "original");
      const results = await Promise.allSettled([
        fixture.backend.writeNote("Shared.md", "first", { mode: "replace", expectedRevision: note.revision }),
        other.writeNote("Shared.md", "second", { mode: "replace", expectedRevision: note.revision }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
    } finally { await other.close(); }
  });
});
