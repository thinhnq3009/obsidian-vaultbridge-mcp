import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectTree } from "../src/tools/pathOperations.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => {
  fixture = await createRegressionFixture();
  await fs.mkdir(path.join(fixture.vault, "Listed"));
  await fs.writeFile(path.join(fixture.vault, "Listed/Good.md"), "ordinary note");
  await fs.writeFile(path.join(fixture.vault, "Listed/.env"), "synthetic secret");
});
afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

describe("authorized directory listings", () => {
  for (const kind of ["file", "directory", "not-directory", "cycle"] as const) {
    it(`skips an unresolvable ${kind} link while preserving valid siblings and tree traversal`, async (context) => {
    const link = path.join(fixture.vault, "Listed/Broken");
    const target = kind === "cycle" ? link
      : kind === "not-directory" ? path.join(fixture.vault, "Listed/Good.md/Child")
      : path.join(fixture.vault, "MissingTarget");
    const type = kind === "directory" ? (process.platform === "win32" ? "junction" : "dir") : "file";
    try { await fs.symlink(target, link, type); }
    catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") context.skip();
      throw error;
    }

    const listing = await fixture.backend.listFiles("Listed");
    expect(listing).toEqual({ root: "Listed", entries: [{ path: "Listed/Good.md", name: "Good.md", isFolder: false }] });
    const tree = await collectTree(fixture.backend, "", 2);
    expect(tree.children?.find((entry) => entry.path === "Listed")?.children).toEqual(listing.entries);
    await expect(fixture.backend.readNote("Listed/.env")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    });
  }

  it.each(["EIO", "EACCES"])("propagates unexpected %s errors instead of silently hiding a valid entry", async (code) => {
    const realpath = fs.realpath;
    const error = Object.assign(new Error("synthetic filesystem failure"), { code });
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (args[0] === path.join(fixture.vault, "Listed/Good.md")) throw error;
      return realpath(...args);
    });
    await expect(fixture.backend.listFiles("Listed")).rejects.toBe(error);
  });
});
