import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
