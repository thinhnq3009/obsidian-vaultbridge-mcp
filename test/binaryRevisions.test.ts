import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRegressionFixture, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { await fixture.close(); });

describe("raw-byte file revisions", () => {
  it("distinguishes bytes that decode to the same replacement character", async () => {
    const file = path.join(fixture.vault, "attachment.bin");
    await fs.writeFile(file, Buffer.from([0x80]));
    const before = await fixture.backend.statPath("attachment.bin");
    await fs.writeFile(file, Buffer.from([0x81]));
    const after = await fixture.backend.statPath("attachment.bin");
    expect(before.revision).toBe(revisionOf(Buffer.from([0x80])));
    expect(after.revision).toBe(revisionOf(Buffer.from([0x81])));
    expect(before.revision).not.toBe(after.revision);
  });

  it.each(["delete", "move", "overwrite"])("rejects stale binary revisions during %s", async (operation) => {
    const file = path.join(fixture.vault, "attachment.bin");
    await fs.writeFile(file, Buffer.from([0x80]));
    const before = await fixture.backend.statPath("attachment.bin");
    await fs.writeFile(file, Buffer.from([0x81]));
    if (operation === "delete") {
      await expect(fixture.backend.deletePath("attachment.bin", { expectedRevision: before.revision! })).rejects.toMatchObject({ code: "CONFLICT" });
    } else if (operation === "move") {
      await expect(fixture.backend.movePath("attachment.bin", "moved.bin", { expectedRevision: before.revision! })).rejects.toMatchObject({ code: "CONFLICT" });
    } else {
      const source = await fixture.backend.writeNote("source.md", "source");
      await expect(fixture.backend.movePath("source.md", "attachment.bin", {
        expectedRevision: source.revision, overwrite: true, expectedDestinationRevision: before.revision!,
      })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await fs.readFile(file)).toEqual(Buffer.from([0x81]));
  });

  it("preserves existing UTF-8 text revisions including BOM and CRLF", async () => {
    const bytes = await fixture.bytes("BOM-CRLF.md");
    expect((await fixture.backend.readNote("BOM-CRLF.md")).revision).toBe(revisionOf(bytes));
  });

  it("returns the actual raw revision when a text no-op preserves invalid UTF-8 bytes", async () => {
    const bytes = Buffer.from([0x80]);
    await fs.writeFile(path.join(fixture.vault, "attachment.bin"), bytes);
    const note = await fixture.backend.readNote("attachment.bin");
    const replaced = await fixture.backend.writeFile("attachment.bin", note.content, {
      mode: "replace", expectedRevision: note.revision!,
    });
    const appended = await fixture.backend.appendToNote("attachment.bin", "", replaced.revision);
    expect(replaced.revision).toBe(revisionOf(bytes));
    expect(appended.revision).toBe(revisionOf(bytes));
    expect(await fixture.bytes("attachment.bin")).toEqual(bytes);
  });
});
