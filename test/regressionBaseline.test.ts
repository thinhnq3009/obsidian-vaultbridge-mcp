import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { parseMetadata } from "../src/backend/markdown.js";
import type { VaultBackend } from "../src/backend/types.js";
import { createRegressionFixture, regressionNotes, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); });

describe("OBS-001 metadata fixtures", () => {
  it.each(Object.entries(regressionNotes))("reads exact UTF-8 bytes and revision: %s", async (name, content) => {
    const note = await fixture.backend.readNote(name);
    expect(note.content).toBe(content);
    expect(note.revision).toBe(revisionOf(Buffer.from(content)));
    expect(await fixture.bytes(name)).toEqual(Buffer.from(content));
  });

  it("extracts Unicode, comments, nested properties, headings and links", async () => {
    const metadata = await fixture.backend.readNoteMetadata("Comments.md");
    expect(metadata.frontmatter).toEqual({ status: "open", owner: "Nguyễn", nested: { count: 3 }, tags: ["project/test", "tiếng-việt"] });
    expect(metadata.headings).toEqual([{ text: "Kế hoạch 🚀", level: 1 }]);
    expect(metadata.revision).toBe(revisionOf(regressionNotes["Comments.md"]));
    expect(metadata.stat?.size).toBe(Buffer.byteLength(regressionNotes["Comments.md"]));
    const syntax = await fixture.backend.readNoteMetadata("Syntax.md");
    expect(syntax.headings).toEqual([{ text: "Real", level: 1 }]);
    expect(syntax.links).toEqual(["Notes/Target", "https://example.com"]);
    expect(syntax.tags).not.toContain("inline");
    expect(syntax.tags).not.toContain("fenced");
    expect(syntax.tags).not.toContain("tilde");
  });

  it("KNOWN K01: numeric issue references currently become tags", () => {
    expect(parseMetadata(regressionNotes["Syntax.md"]).tags).toEqual(["123", "release/v1", "project/test"]);
  });

  it("rejects invalid YAML metadata without changing bytes", async () => {
    await expect(fixture.backend.readNoteMetadata("Invalid.md")).rejects.toMatchObject({ code: "INVALID_MARKDOWN" });
    expect(await fixture.bytes("Invalid.md")).toEqual(Buffer.from(regressionNotes["Invalid.md"]));
  });
});

describe("OBS-001 note mutations", () => {
  it("preserves BOM, CRLF, Unicode, comments and untouched body through create/replace/append", async () => {
    const original = regressionNotes["BOM-CRLF.md"];
    const created = await fixture.backend.writeNote("Ghi chú/New.md", original);
    expect(created.revision).toBe(revisionOf(original));
    await expect(fixture.backend.writeNote("Ghi chú/New.md", "overwrite")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(await fixture.bytes("Ghi chú/New.md")).toEqual(Buffer.from(original));
    const replacement = original.replace("First", "Đã thay");
    const replaced = await fixture.backend.writeNote("Ghi chú/New.md", replacement, { mode: "replace", expectedRevision: created.revision });
    expect(replaced.revision).toBe(revisionOf(replacement));
    const appended = await fixture.backend.appendToNote("Ghi chú/New.md", "Thêm 🚀\r\n", replaced.revision);
    expect(await fixture.bytes("Ghi chú/New.md")).toEqual(Buffer.from(replacement + "Thêm 🚀\r\n"));
    expect(appended.revision).toBe(revisionOf(await fixture.bytes("Ghi chú/New.md")));
  });

  it("preserves comments, property values and body; records flow-array spacing normalization", async () => {
    const source = regressionNotes["Comments.md"];
    const result = await fixture.backend.patchFrontmatter("Comments.md", "status", "done", "replace", false, revisionOf(source));
    const bytes = await fixture.bytes("Comments.md");
    expect(bytes.toString()).toBe(source.replace("status: open", "status: done").replace("[project/test, tiếng-việt]", "[ project/test, tiếng-việt ]"));
    expect(result.revision).toBe(revisionOf(bytes));
  });

  it.each(["replace", "append", "prepend"] as const)("patches a CRLF heading (%s) without changing prefix/tail", async (operation) => {
    const source = regressionNotes["BOM-CRLF.md"];
    const result = await fixture.backend.patchHeading("BOM-CRLF.md", "Target", "Nội dung\nMore", operation, { expectedRevision: revisionOf(source) });
    const content = (await fixture.bytes("BOM-CRLF.md")).toString();
    expect(content.slice(0, content.indexOf("## Target"))).toBe(source.slice(0, source.indexOf("## Target")));
    expect(content.slice(content.indexOf("## Tail"))).toBe(source.slice(source.indexOf("## Tail")));
    expect(content).toContain("Nội dung\r\nMore");
    expect(content.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(result.revision).toBe(revisionOf(content));
  });

  it.each(["replace", "append", "prepend"] as const)("patches CRLF frontmatter (%s), preserving BOM/comments/body", async (operation) => {
    const source = regressionNotes["BOM-CRLF.md"];
    await fixture.backend.patchFrontmatter("BOM-CRLF.md", "status", "done", operation, false, revisionOf(source));
    const content = (await fixture.bytes("BOM-CRLF.md")).toString();
    expect(content.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(content).toContain("# keep\r\n");
    expect(content.slice(content.indexOf("# Ghi chú"))).toBe(source.slice(source.indexOf("# Ghi chú")));
    expect(content.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(parseMetadata(content).frontmatter.status).toBe(operation === "replace" ? "done" : operation === "append" ? "opendone" : "doneopen");
  });

  it("selects exactly the second duplicate heading", async () => {
    await fixture.backend.patchHeading("Duplicate.md", "Same", "Updated", "replace", { occurrence: 2, expectedRevision: revisionOf(regressionNotes["Duplicate.md"]) });
    expect((await fixture.bytes("Duplicate.md")).toString()).toBe("# Same\nFirst\n## Child\nKeep child\n# Same\nUpdated\n\n# Tail\nKeep tail\n");
  });

  it("patches the final heading in a long note while preserving the entire prefix", async () => {
    const source = regressionNotes["Long.md"];
    await fixture.backend.patchHeading("Long.md", "End", "Updated", "replace", { expectedRevision: revisionOf(source) });
    expect(await fixture.bytes("Long.md")).toEqual(Buffer.from(source.replace("Sentinel\n", "Updated\n\n")));
  });

  it.each([
    { heading: "Same", options: {}, code: "AMBIGUOUS_HEADING" },
    { heading: "Missing", options: {}, code: "HEADING_NOT_FOUND" },
    { heading: "Same", options: { occurrence: 3 }, code: "INVALID_MARKDOWN" },
  ])("rejects heading selection $code without writing", async ({ heading, options, code }) => {
    await expect(fixture.backend.patchHeading("Duplicate.md", heading, "bad", "replace", { ...options, expectedRevision: revisionOf(regressionNotes["Duplicate.md"]) })).rejects.toMatchObject({ code });
    expect(await fixture.bytes("Duplicate.md")).toEqual(Buffer.from(regressionNotes["Duplicate.md"]));
  });

  it("rejects invalid YAML and absent fields without writing", async () => {
    await expect(fixture.backend.patchFrontmatter("Invalid.md", "status", "done", "replace", true, revisionOf(regressionNotes["Invalid.md"]))).rejects.toMatchObject({ code: "INVALID_MARKDOWN" });
    await expect(fixture.backend.patchFrontmatter("Comments.md", "missing", "done", "replace", false, revisionOf(regressionNotes["Comments.md"]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.bytes("Invalid.md")).toEqual(Buffer.from(regressionNotes["Invalid.md"]));
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
  });

  const mutations = {
    replace: (backend: VaultBackend, revision?: string) => backend.writeNote("Comments.md", "bad", { mode: "replace", ...(revision ? { expectedRevision: revision } : {}) }),
    append: (backend: VaultBackend, revision?: string) => backend.appendToNote("Comments.md", "bad", revision),
    heading: (backend: VaultBackend, revision?: string) => backend.patchHeading("Comments.md", "Kế hoạch 🚀", "bad", "replace", revision ? { expectedRevision: revision } : {}),
    frontmatter: (backend: VaultBackend, revision?: string) => backend.patchFrontmatter("Comments.md", "status", "bad", "replace", true, revision),
    delete: (backend: VaultBackend, revision?: string) => backend.deletePath("Comments.md", revision ? { expectedRevision: revision } : {}),
    move: (backend: VaultBackend, revision?: string) => backend.movePath("Comments.md", "Moved.md", revision ? { expectedRevision: revision } : {}),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    it.each([undefined, "sha256:stale"])(`requires a current revision for ${name} (%s)`, async (revision) => {
      await expect(mutate(fixture.backend, revision)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
      expect((await fixture.backend.statPath("Moved.md")).exists).toBe(false);
    });
  }

  it("serializes two independent backends sharing a vault/cache; loser cannot overwrite winner", async () => {
    const other = new FilesystemVaultBackend(fixture.config);
    await other.initialize();
    try {
      const writes = await Promise.allSettled([fixture.backend, other].map((backend, index) => backend.writeNote("Comments.md", `winner-${index}`, { mode: "replace", expectedRevision: revisionOf(regressionNotes["Comments.md"]) })));
      const success = writes.filter((result) => result.status === "fulfilled");
      const failure = writes.filter((result) => result.status === "rejected");
      expect(success).toHaveLength(1);
      expect(failure).toHaveLength(1);
      expect(failure[0]?.reason).toMatchObject({ code: "CONFLICT" });
      const final = await fixture.bytes("Comments.md");
      expect(["winner-0", "winner-1"]).toContain(final.toString());
      expect(success[0]?.value.revision).toBe(revisionOf(final));
    } finally { await other.close(); }
  });

  it("atomic rename failure leaves original bytes/mode and removes the temporary file", async () => {
    const original = await fixture.bytes("Comments.md");
    const mode = (await fs.stat(path.join(fixture.vault, "Comments.md"))).mode;
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("injected rename failure"), { code: "EACCES" }));
    await expect(fixture.backend.writeNote("Comments.md", "replacement", { mode: "replace", expectedRevision: revisionOf(original) })).rejects.toThrow();
    expect(rename).toHaveBeenCalledOnce();
    expect(await fixture.bytes("Comments.md")).toEqual(original);
    expect((await fs.stat(path.join(fixture.vault, "Comments.md"))).mode).toBe(mode);
    expect((await fs.readdir(fixture.vault)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    rename.mockRestore();
    await fixture.backend.appendToNote("Comments.md", "retry", revisionOf(original));
  });
});
