import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { parseMetadata } from "../src/backend/markdown.js";
import { createMcpServer } from "../src/server.js";
import { createRegressionFixture, regressionNotes, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
const first = "2026-10-20T01:02:03.456Z";
const second = "2026-10-20T02:03:04.567Z";
let clock = first;
const source = "---\n# keep comment\nstatus: open # inline\ntags: [a,b]\n---\n# H\nold\n\n";
beforeEach(async () => {
  clock = first;
  // Stub only the timestamp output; lockfile must keep the real wall clock.
  vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => clock);
  fixture = await createRegressionFixture({ autoAgentEditAt: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.close();
});

async function seed(content = source, name = "Note.md") {
  await fs.writeFile(path.join(fixture.vault, name), content);
  return revisionOf(content);
}

async function assertPersisted(name: string, revision: string, timestamp = first) {
  const bytes = await fixture.bytes(name);
  expect(revision).toBe(revisionOf(bytes));
  expect(parseMetadata(bytes.toString()).frontmatter.agents_edit_at).toBe(timestamp);
  return bytes.toString();
}

describe("OBS-003 agent edit transaction", () => {
  it("defaults older programmatic configuration to enabled", async () => {
    const config = { ...fixture.config };
    delete config.autoAgentEditAt;
    const backend = new FilesystemVaultBackend(config);
    await backend.initialize();
    try {
      const result = await backend.writeNote("Default.md", "body");
      await assertPersisted("Default.md", result.revision);
    } finally { await backend.close(); }
  });

  it.each(["Note.md", "DIRECT.MD"])("creates frontmatter through note/direct writes: %s", async (name) => {
    const rename = vi.spyOn(fs, "rename");
    const result = name === "Note.md"
      ? await fixture.backend.writeNote(name, "\uFEFF# H\r\nTiếng Việt 🚀\r\n")
      : await fixture.backend.writeFile(name, "\uFEFF# H\r\nTiếng Việt 🚀\r\n", { contentType: "application/octet-stream" });
    expect(await assertPersisted(name, result.revision)).toBe(`\uFEFF---\r\nagents_edit_at: "${first}"\r\n---\r\n# H\r\nTiếng Việt 🚀\r\n`);
    expect(rename).toHaveBeenCalledOnce();
  });

  const operations = {
    replace: (b: FilesystemVaultBackend, revision: string) => b.writeNote("Note.md", source.replace("old", "changed"), { mode: "replace", expectedRevision: revision }),
    direct: (b: FilesystemVaultBackend, revision: string) => b.writeFile("Note.md", source.replace("old", "changed"), { mode: "replace", expectedRevision: revision }),
    append: (b: FilesystemVaultBackend, revision: string) => b.appendToNote("Note.md", "changed", revision),
    heading: (b: FilesystemVaultBackend, revision: string) => b.patchHeading("Note.md", "H", "changed", "replace", { expectedRevision: revision }),
    frontmatter: (b: FilesystemVaultBackend, revision: string) => b.patchFrontmatter("Note.md", "status", "changed", "replace", false, revision),
  };
  for (const [name, mutate] of Object.entries(operations)) {
    it(`stamps ${name} once and returns the final persisted revision`, async () => {
      const created = await fixture.backend.writeNote("Note.md", source);
      clock = second;
      const rename = vi.spyOn(fs, "rename");
      const result = await mutate(fixture.backend, created.revision);
      const content = await assertPersisted("Note.md", result.revision, second);
      expect(content).toContain("changed");
      expect(content).toContain("# keep comment\nstatus:");
      expect(content).toContain("# inline");
      expect(rename).toHaveBeenCalledOnce();
    });

    it(`rejects stale ${name} without advancing timestamp`, async () => {
      const created = await fixture.backend.writeNote("Note.md", source);
      const bytes = await fixture.bytes("Note.md");
      clock = second;
      const rename = vi.spyOn(fs, "rename");
      await expect(mutate(fixture.backend, "stale")).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await fixture.bytes("Note.md")).toEqual(bytes);
      expect(created.revision).toBe(revisionOf(bytes));
      expect(rename).not.toHaveBeenCalled();
    });

    it(`read-only ${name} leaves original bytes`, async () => {
      const revision = await seed();
      const backend = new FilesystemVaultBackend({ ...fixture.config, readOnly: true });
      await backend.initialize();
      try {
        const rename = vi.spyOn(fs, "rename");
        await expect(mutate(backend, revision)).rejects.toMatchObject({ code: "READ_ONLY" });
        expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
        expect(rename).not.toHaveBeenCalled();
      } finally { await backend.close(); }
    });
  }

  it.each(["append", "heading", "frontmatter"] as const)("first-time %s creates frontmatter in the same write", async (operation) => {
    const revision = await seed("\uFEFF# H\r\nold\r\n\r\n");
    const rename = vi.spyOn(fs, "rename");
    const result = operation === "append"
      ? await fixture.backend.appendToNote("Note.md", "more\r\n", revision)
      : operation === "heading"
        ? await fixture.backend.patchHeading("Note.md", "H", "more", "replace", { expectedRevision: revision })
        : await fixture.backend.patchFrontmatter("Note.md", "status", "done", "replace", true, revision);
    const text = await assertPersisted("Note.md", result.revision);
    expect(text.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(text.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(text).toContain(operation === "frontmatter" ? "status: done" : "more");
    expect(rename).toHaveBeenCalledOnce();
  });

  it("read-only create cannot add a timestamp or new note", async () => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, readOnly: true });
    await backend.initialize();
    try {
      const rename = vi.spyOn(fs, "rename");
      await expect(backend.writeNote("New.md", "body")).rejects.toMatchObject({ code: "READ_ONLY" });
      expect(await fs.readdir(fixture.vault)).not.toContain("New.md");
      expect(rename).not.toHaveBeenCalled();
    } finally { await backend.close(); }
  });

  it("no-op replace/append/heading/frontmatter and audit-only edits preserve original bytes and mtime", async () => {
    const created = await fixture.backend.writeNote("Note.md", source);
    const original = (await fixture.bytes("Note.md")).toString();
    const stat = await fs.stat(path.join(fixture.vault, "Note.md"));
    clock = second;
    const rename = vi.spyOn(fs, "rename");
    const calls = [
      () => fixture.backend.writeNote("Note.md", original, { mode: "replace", expectedRevision: created.revision }),
      () => fixture.backend.appendToNote("Note.md", "", created.revision),
      () => fixture.backend.patchHeading("Note.md", "H", "old", "replace", { expectedRevision: created.revision }),
      () => fixture.backend.patchFrontmatter("Note.md", "status", "open", "replace", false, created.revision),
      () => fixture.backend.writeNote("Note.md", original.replace(first, "2099-01-01T00:00:00Z"), { mode: "replace", expectedRevision: created.revision }),
      () => fixture.backend.writeNote("Note.md", source, { mode: "replace", expectedRevision: created.revision }),
    ];
    for (const call of calls) expect((await call()).revision).toBe(created.revision);
    expect(rename).not.toHaveBeenCalled();
    expect((await fixture.bytes("Note.md")).toString()).toBe(original);
    expect((await fs.stat(path.join(fixture.vault, "Note.md"))).mtimeMs).toBe(stat.mtimeMs);
  });

  it("does not introduce frontmatter on a first no-op", async () => {
    const revision = await seed("# H\nbody\n");
    const rename = vi.spyOn(fs, "rename");
    expect((await fixture.backend.appendToNote("Note.md", "", revision)).revision).toBe(revision);
    expect((await fixture.backend.writeNote("Note.md", `---\nagents_edit_at: forged\n---\n# H\nbody\n`, { mode: "replace", expectedRevision: revision })).revision).toBe(revision);
    expect(await fixture.bytes("Note.md")).toEqual(Buffer.from("# H\nbody\n"));
    expect(rename).not.toHaveBeenCalled();
  });

  it("overrides supplied timestamps and rejects reserved-field patches", async () => {
    const created = await fixture.backend.writeNote("Note.md", source.replace("status: open", "agents_edit_at: forged\nstatus: open"));
    const original = await fixture.bytes("Note.md");
    expect(original.toString()).not.toContain("forged");
    for (const field of ["agents_edit_at", "agents_edit_at.child"]) {
      await expect(fixture.backend.patchFrontmatter("Note.md", field, "forged", "replace", true, created.revision)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
    clock = second;
    const replaced = await fixture.backend.writeNote("Note.md", source.replace("status: open", "agents_edit_at: forged\nstatus: done"), { mode: "replace", expectedRevision: created.revision });
    await assertPersisted("Note.md", replaced.revision, second);
  });

  it("preserves BOM, CRLF, YAML lexical formatting, comments and body during injection", async () => {
    const original = regressionNotes["BOM-CRLF.md"].replace("owner: Nguyễn", '"agents_edit_at": "old" # audit comment\r\nowner: Nguyễn');
    const revision = await seed(original);
    const result = await fixture.backend.appendToNote("Note.md", "more\r\n", revision);
    expect(await assertPersisted("Note.md", result.revision)).toBe(original.replace('"old"', `"${first}"`) + "more\r\n");
    const commentRevision = await seed(source);
    const appended = await fixture.backend.appendToNote("Note.md", "more", commentRevision);
    expect(await assertPersisted("Note.md", appended.revision)).toBe(source.replace("---\n# H", `agents_edit_at: "${first}"\n---\n# H`) + "more");
  });

  it.each(["---\n---\nbody", "---\n# comment\n---\nbody", "---\n{owner: 'Nguyễn', tags: [a,b]}\n---\nbody", "---\n{}\n---\nbody", "---\n  owner: x\n---\nbody", "---\nstatus: open\n---", "---\nagents_edit_at:\nstatus: open\n---\nbody", "---\nagents_edit_at: # keep\n---\nbody", "---\n{agents_edit_at:}\n---\nbody"])("preserves valid frontmatter forms: %s", async (content) => {
    const result = await fixture.backend.writeNote("Note.md", content);
    const persisted = await assertPersisted("Note.md", result.revision);
    expect(persisted).toContain(content.slice(content.lastIndexOf("\n") + 1));
    if (content.includes("[a,b]")) expect(persisted).toContain("{agents_edit_at:");
  });

  it.each(["---\nbroken: [\n---\nbody", "---\n- sequence\n---\nbody", "---\na: 1\na: 2\n---\nbody", "---\nunterminated", "---\nagents_edit_at: &audit old\nother: *audit\n---\nbody"])("validation fails without writing: %s", async (content) => {
    const revision = await seed();
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.writeNote("New.md", content)).rejects.toMatchObject({ code: "INVALID_MARKDOWN" });
    await expect(fixture.backend.writeNote("Note.md", content, { mode: "replace", expectedRevision: revision })).rejects.toMatchObject({ code: "INVALID_MARKDOWN" });
    expect(rename).not.toHaveBeenCalled();
    expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
    expect(await fs.readdir(fixture.vault)).not.toContain("New.md");
  });

  it("heading selection and frontmatter transform failures do not stamp or write", async () => {
    const revision = await seed();
    const rename = vi.spyOn(fs, "rename");
    await expect(fixture.backend.patchHeading("Note.md", "Missing", "bad", "replace", { expectedRevision: revision })).rejects.toMatchObject({ code: "HEADING_NOT_FOUND" });
    await expect(fixture.backend.patchFrontmatter("Note.md", "missing", "bad", "replace", false, revision)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rename).not.toHaveBeenCalled();
    expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
  });

  it("disabled mode preserves existing timestamp through omission, forgery and all transformations", async () => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, autoAgentEditAt: false });
    await backend.initialize();
    try {
      await backend.writeNote("New.md", "body");
      expect(await fixture.bytes("New.md")).toEqual(Buffer.from("body"));
      await expect(backend.writeNote("Forged.md", "---\nagents_edit_at: forged\n---\nbody")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      const original = source.replace("status: open", 'agents_edit_at: "2020-01-01T00:00:00Z" # frozen\nstatus: open');
      let revision = await seed(original);
      const changed = await backend.appendToNote("Note.md", "more", revision);
      expect((await fixture.bytes("Note.md")).toString()).toBe(original + "more");
      revision = changed.revision;
      for (const mutate of Object.values(operations)) {
        const result = await mutate(backend, revision);
        const text = (await fixture.bytes("Note.md")).toString();
        expect(parseMetadata(text).frontmatter.agents_edit_at).toBe("2020-01-01T00:00:00Z");
        expect(result.revision).toBe(revisionOf(text));
        revision = result.revision;
      }
      const text = (await fixture.bytes("Note.md")).toString();
      const result = await backend.writeNote("Note.md", text.replace("2020-01-01T00:00:00Z", "forged") + "new", { mode: "replace", expectedRevision: revision });
      expect(parseMetadata((await fixture.bytes("Note.md")).toString()).frontmatter.agents_edit_at).toBe("2020-01-01T00:00:00Z");
      expect(result.revision).toBe(revisionOf(await fixture.bytes("Note.md")));
    } finally { await backend.close(); }
  });

  it("one of two independent concurrent writers wins and stamps exactly once", async () => {
    const revision = await seed();
    const other = new FilesystemVaultBackend(fixture.config);
    await other.initialize();
    try {
      const rename = vi.spyOn(fs, "rename");
      const results = await Promise.allSettled([fixture.backend, other].map((backend, index) => backend.appendToNote("Note.md", `winner-${index}`, revision)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
      const success = results.find((r) => r.status === "fulfilled");
      if (success?.status !== "fulfilled") throw new Error("Missing successful write");
      await assertPersisted("Note.md", success.value.revision);
      expect(rename).toHaveBeenCalledOnce();
    } finally { await other.close(); }
  });

  it.each(["rename", "sync", "writeFile"] as const)("%s failure cleans temporary data, preserves bytes/mode, and releases lock", async (phase) => {
    const revision = await seed();
    const mode = (await fs.stat(path.join(fixture.vault, "Note.md"))).mode;
    if (phase === "rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected rename failure"));
    else {
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".tmp")) vi.spyOn(handle, phase).mockRejectedValueOnce(new Error("injected sync failure"));
        return handle;
      });
    }
    await expect(fixture.backend.appendToNote("Note.md", "changed", revision)).rejects.toThrow();
    expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
    expect((await fs.stat(path.join(fixture.vault, "Note.md"))).mode).toBe(mode);
    expect((await fs.readdir(fixture.vault)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    vi.restoreAllMocks();
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => clock);
    const result = await fixture.backend.appendToNote("Note.md", "retry", revision);
    await assertPersisted("Note.md", result.revision);
  });

  it("checks final UTF-8 bytes including timestamp before create or transformed writes", async () => {
    const backend = new FilesystemVaultBackend({ ...fixture.config, maxFileSizeBytes: 80 });
    await backend.initialize();
    try {
      const rename = vi.spyOn(fs, "rename");
      await expect(backend.writeNote("TooLarge.md", "🚀".repeat(10))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      const revision = await seed("# H\nx\n");
      const mutations = [
        () => backend.writeNote("Note.md", "🚀".repeat(10), { mode: "replace", expectedRevision: revision }),
        () => backend.appendToNote("Note.md", "🚀".repeat(10), revision),
        () => backend.patchHeading("Note.md", "H", "🚀".repeat(10), "replace", { expectedRevision: revision }),
        () => backend.patchFrontmatter("Note.md", "title", "🚀".repeat(10), "replace", true, revision),
      ];
      for (const mutate of mutations) await expect(mutate()).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      expect(rename).not.toHaveBeenCalled();
      expect(await fixture.bytes("Note.md")).toEqual(Buffer.from("# H\nx\n"));
      expect(await fs.readdir(fixture.vault)).not.toContain("TooLarge.md");
    } finally { await backend.close(); }
  });

  it.each(["Plan.canvas", "asset.json", "asset.txt", "asset.bin"])("never injects into %s", async (name) => {
    const result = await fixture.backend.writeFile(name, "{}");
    expect(await fixture.bytes(name)).toEqual(Buffer.from("{}"));
    expect(result.revision).toBe(revisionOf("{}"));
    const patched = await fixture.backend.appendToNote(name, "x", result.revision);
    expect(await fixture.bytes(name)).toEqual(Buffer.from("{}x"));
    expect(patched.revision).toBe(revisionOf("{}x"));
  });

  it("successful bulk returns final revisions and counts no-op files without writing them", async () => {
    const server = createMcpServer(fixture.backend);
    const client = new Client({ name: "obs-003-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const revision = await seed();
      const rename = vi.spyOn(fs, "rename");
      const result = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [
        { path: "First.md", content: "first" },
        { path: "Note.md", content: source, mode: "replace", expected_revision: revision },
        { path: "Last.md", content: "last" },
      ] } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ count: 3, written: [
        { path: "First.md", revision: revisionOf(await fixture.bytes("First.md")) },
        { path: "Note.md", revision },
        { path: "Last.md", revision: revisionOf(await fixture.bytes("Last.md")) },
      ] });
      expect(rename).toHaveBeenCalledTimes(2);
      expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
      await assertPersisted("Last.md", revisionOf(await fixture.bytes("Last.md")));
    } finally { await client.close(); await server.close(); }
  });

  it("bulk retains earlier stamped success and stops at the first conflict", async () => {
    const server = createMcpServer(fixture.backend);
    const client = new Client({ name: "obs-003-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const revision = await seed();
      const rename = vi.spyOn(fs, "rename");
      const result = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [
        { path: "First.md", content: "first" },
        { path: "Note.md", content: "bad", mode: "replace", expected_revision: "stale" },
        { path: "Never.md", content: "never" },
      ] } });
      expect(result.isError).toBe(true);
      await assertPersisted("First.md", revisionOf(await fixture.bytes("First.md")));
      expect(await fixture.bytes("Note.md")).toEqual(Buffer.from(source));
      expect(revision).toBe(revisionOf(source));
      expect(await fs.readdir(fixture.vault)).not.toContain("Never.md");
      expect(rename).toHaveBeenCalledOnce();
    } finally { await client.close(); await server.close(); }
  });
});
