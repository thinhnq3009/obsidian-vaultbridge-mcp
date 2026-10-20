import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { LocalRestBackend } from "../src/backend/localRest.js";
import type { NoteEdits } from "../src/backend/types.js";
import { parseMetadata } from "../src/backend/markdown.js";
import { createMcpServer } from "../src/server.js";
import { createRegressionFixture, regressionNotes, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
let mcpClient: Client | undefined;
let mcpServer: ReturnType<typeof createMcpServer> | undefined;
const empty: NoteEdits = { frontmatter: [], sections: [] };
const frontmatter = (field: string, value: unknown) => ({ field, value, operation: "replace" as const, createIfMissing: true });
const section = (heading: string, content: string, occurrence?: number) =>
  ({ heading, content, operation: "replace" as const, ...(occurrence === undefined ? {} : { occurrence }) });

beforeEach(async () => { fixture = await createRegressionFixture({ autoAgentEditAt: true }); });
afterEach(async () => {
  await mcpClient?.close();
  await mcpServer?.close();
  await fixture?.close();
  vi.restoreAllMocks();
  mcpClient = undefined;
  mcpServer = undefined;
});

async function callTool(args: Record<string, unknown>) {
  if (!mcpClient) {
    mcpServer = createMcpServer(fixture.backend);
    mcpClient = new Client({ name: "obs-005-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  }
  return mcpClient.callTool({ name: "obsidian_apply_note_edits", arguments: args });
}

describe("OBS-005 atomic multi-edit", () => {
  it("updates frontmatter and multiple sections through exactly one rename, one stamp and final revision", async () => {
    const source = regressionNotes["BOM-CRLF.md"];
    const rename = vi.spyOn(fs, "rename");
    const result = await fixture.backend.applyNoteEdits("BOM-CRLF.md", revisionOf(source), {
      frontmatter: [frontmatter("status", "done"), frontmatter("priority", 4)],
      sections: [section("Target", "Mới 🚀"), section("Ghi chú 🚀", "Top content")],
    });
    const bytes = await fixture.bytes("BOM-CRLF.md");
    const output = bytes.toString("utf8");
    expect(rename).toHaveBeenCalledOnce();
    expect(output).toContain("status: done");
    expect(output).toContain("priority: 4");
    expect(output).toContain("# Ghi chú 🚀");
    expect(output).toContain("Top content");
    expect(output).toContain("Mới 🚀");
    expect(output).toContain("## Tail\r\nUntouched");
    expect(output.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(output.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(output.match(/agents_edit_at:/gu)?.length).toBe(1);
    expect(parseMetadata(output).frontmatter.agents_edit_at).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    expect(result).toMatchObject({ frontmatterEdits: 2, sectionEdits: 2, changed: true, revision: revisionOf(bytes) });
  });

  it("applies edits in deterministic array order without losing unrelated fields", async () => {
    const source = regressionNotes["Comments.md"];
    const result = await fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), {
      frontmatter: [
        { field: "tags", value: "new", operation: "append", createIfMissing: false },
        frontmatter("nested.count", 8),
      ],
      sections: [section("Kế hoạch 🚀", "Edited")],
    });
    const persisted = (await fixture.bytes("Comments.md")).toString();
    expect(parseMetadata(persisted).frontmatter.nested).toMatchObject({ count: 8 });
    expect(parseMetadata(persisted).frontmatter.tags).toEqual(["project/test", "tiếng-việt", "new"]);
    expect(persisted).toContain("Edited");
    expect(result.revision).toBe(revisionOf(persisted));
  });

  it("rolls back in-memory earlier edits when a later heading is missing", async () => {
    const source = regressionNotes["Comments.md"];
    const before = await fs.stat(path.join(fixture.vault, "Comments.md"));
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), {
      frontmatter: [frontmatter("status", "done")],
      sections: [section("Kế hoạch 🚀", "changed"), section("Missing", "never")],
    })).rejects.toMatchObject({ code: "HEADING_NOT_FOUND" });
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(source));
    expect((await fs.stat(path.join(fixture.vault, "Comments.md"))).mtimeMs).toBe(before.mtimeMs);
    expect(rename).not.toHaveBeenCalled();
  });

  it("requires occurrence for duplicate headings and can select the second occurrence", async () => {
    const source = regressionNotes["Duplicate.md"];
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.applyNoteEdits("Duplicate.md", revisionOf(source), { ...empty, sections: [section("Same", "X")] }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_HEADING" });
    expect(rename).not.toHaveBeenCalled();
    const result = await fixture.backend.applyNoteEdits("Duplicate.md", revisionOf(source), { ...empty, sections: [section("Same", "X", 2)] });
    const text = (await fixture.bytes("Duplicate.md")).toString();
    expect(text).toContain("# Same\nFirst");
    expect(text).toContain("# Same\nX");
    expect(result.changed).toBe(true);
    expect(rename).toHaveBeenCalledOnce();
  });

  it("does not write when invalid YAML is encountered before a section transform", async () => {
    const source = regressionNotes["Invalid.md"];
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.applyNoteEdits("Invalid.md", revisionOf(source), { ...empty, sections: [section("Broken", "X")] }))
      .rejects.toMatchObject({ code: "INVALID_MARKDOWN" });
    expect(await fixture.bytes("Invalid.md")).toEqual(Buffer.from(source));
    expect(rename).not.toHaveBeenCalled();
  });

  it("allows a semantic frontmatter no-op without changing bytes, revision, timestamp or mtime", async () => {
    const source = regressionNotes["Comments.md"];
    const first = await fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), { ...empty, frontmatter: [frontmatter("status", "done")] });
    const original = await fixture.bytes("Comments.md");
    const stat = await fs.stat(path.join(fixture.vault, "Comments.md"));
    const rename = vi.spyOn(fs, "rename");
    const second = await fixture.backend.applyNoteEdits("Comments.md", first.revision, { ...empty, frontmatter: [frontmatter("status", "done")] });
    expect(second).toMatchObject({ changed: false, revision: first.revision });
    expect(await fixture.bytes("Comments.md")).toEqual(original);
    expect((await fs.stat(path.join(fixture.vault, "Comments.md"))).mtimeMs).toBe(stat.mtimeMs);
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(["agents_edit_at", "agents_edit_at.child"])("rejects direct protected-field edit %s before persisting", async (field) => {
    const source = regressionNotes["Comments.md"];
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), {
      ...empty,
      frontmatter: [frontmatter("status", "done"), frontmatter(field, "forged")],
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(source));
    expect(rename).not.toHaveBeenCalled();
  });

  it("rejects empty requests and malformed field paths", async () => {
    const source = regressionNotes["Comments.md"];
    await expect(fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), empty)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), { ...empty, frontmatter: [frontmatter("nested..count", "bad")] }))
      .rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(source));
  });

  it("rejects stale and absent expected revisions, even when proposed edits are a no-op", async () => {
    const source = regressionNotes["Comments.md"];
    const edits = { ...empty, frontmatter: [frontmatter("status", "open")] };
    for (const revision of ["stale", ""]) {
      await expect(fixture.backend.applyNoteEdits("Comments.md", revision, edits)).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(source));
  });

  it("two concurrent writers with the same revision yield one success and one conflict", async () => {
    const source = regressionNotes["Comments.md"];
    const rename = vi.spyOn(fs, "rename");
    const run = (value: string) => fixture.backend.applyNoteEdits("Comments.md", revisionOf(source), {
      ...empty, frontmatter: [frontmatter("status", value)],
    });
    const results = await Promise.allSettled([run("A"), run("B")]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(results.find((item) => item.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(rename).toHaveBeenCalledOnce();
  });

  it("rejects read-only without touching the file", async () => {
    const restricted = new FilesystemVaultBackend({ ...fixture.config, readOnly: true });
    await restricted.initialize();
    try {
      await expect(restricted.applyNoteEdits("Comments.md", revisionOf(regressionNotes["Comments.md"]), {
        ...empty, frontmatter: [frontmatter("status", "bad")],
      })).rejects.toMatchObject({ code: "READ_ONLY" });
      expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
    } finally { await restricted.close(); }
  });

  it("denies out-of-scope, traversal and external symlink paths", async () => {
    const restricted = new FilesystemVaultBackend({ ...fixture.config, writePaths: ["Allowed"] });
    await restricted.initialize();
    try {
      await expect(restricted.applyNoteEdits("Comments.md", "stale", { ...empty, sections: [section("Kế hoạch 🚀", "bad")] }))
        .rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally { await restricted.close(); }
    await expect(fixture.backend.applyNoteEdits("../Outside.md", "stale", { ...empty, sections: [section("X", "bad")] }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await fs.writeFile(path.join(fixture.outside, "Secret.md"), "# H\nSafe");
    await fs.symlink(fixture.outside, path.join(fixture.vault, "Escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(fixture.backend.applyNoteEdits("Escape/Secret.md", "stale", { ...empty, sections: [section("H", "bad")] }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await fs.readFile(path.join(fixture.outside, "Secret.md"), "utf8")).toBe("# H\nSafe");
  });

  it("rejects the final size after applying edits and audit stamp", async () => {
    const content = "# H\nX\n";
    await fs.writeFile(path.join(fixture.vault, "Small.md"), content);
    const limited = new FilesystemVaultBackend({ ...fixture.config, maxFileSizeBytes: 64 });
    await limited.initialize();
    try {
      await expect(limited.applyNoteEdits("Small.md", revisionOf(content), {
        ...empty, sections: [section("H", "X".repeat(120))],
      })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      expect(await fixture.bytes("Small.md")).toEqual(Buffer.from(content));
    } finally { await limited.close(); }
  });

  it("accepts only existing .md notes", async () => {
    await fs.writeFile(path.join(fixture.vault, "File.canvas"), "{}");
    await expect(fixture.backend.applyNoteEdits("File.canvas", revisionOf("{}"), { ...empty, sections: [section("X", "bad")] }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(fixture.backend.applyNoteEdits("Missing.md", "sha256:missing", { ...empty, sections: [section("X", "bad")] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("explicitly rejects Local REST with no read/write requests", async () => {
    const legacy = new LocalRestBackend({ ...fixture.config, backend: "local-rest" });
    await expect(legacy.applyNoteEdits("Comments.md", "rev", { ...empty, sections: [section("X", "bad")] }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("MCP round-trip advertises and applies multiple edits with structured counts", async () => {
    const original = regressionNotes["Comments.md"];
    const result = await callTool({
      path: "Comments.md", expected_revision: revisionOf(original),
      frontmatter_updates: [{ field: "status", value: "closed" }],
      section_edits: [{ heading: "Kế hoạch 🚀", content: "Done", operation: "replace" }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ path: "Comments.md", frontmatter_edits: 1, section_edits: 1, changed: true });
    expect(result.structuredContent?.revision).toBe(revisionOf(await fixture.bytes("Comments.md")));
  });

  it("MCP returns error for empty edits, conflicts and ambiguous headings without writing", async () => {
    const original = regressionNotes["Duplicate.md"];
    for (const args of [
      { path: "Duplicate.md", expected_revision: revisionOf(original) },
      { path: "Duplicate.md", expected_revision: "stale", section_edits: [{ heading: "Same", content: "bad" }] },
      { path: "Duplicate.md", expected_revision: revisionOf(original), section_edits: [{ heading: "Same", content: "bad" }] },
    ]) {
      const result = await callTool(args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
    expect(await fixture.bytes("Duplicate.md")).toEqual(Buffer.from(original));
  });
});
