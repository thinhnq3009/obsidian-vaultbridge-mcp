import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { LocalRestBackend } from "../src/backend/localRest.js";
import type { VaultBackend } from "../src/backend/types.js";
import { LocalRestBackend as RestClient } from "../src/obsidian/client.js";
import { createMcpServer } from "../src/server.js";
import type { AppConfig } from "../src/types.js";
import { createTempVault, makeConfig } from "./helpers.js";
import { revisionOf } from "./regressionFixtures.js";

let root: string | undefined;
let vault: string;
let backend: VaultBackend;
let server: ReturnType<typeof createMcpServer>;
let client: Client;

async function connect(selected: VaultBackend) {
  backend = selected;
  server = createMcpServer(backend);
  client = new Client({ name: "obs-004-disposable-vault", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

async function setup(content = "# Section\nbody\n", overrides: Partial<AppConfig> = {}) {
  root = await createTempVault();
  vault = path.join(root, "vault");
  await fs.mkdir(vault);
  await fs.writeFile(path.join(vault, "Note.md"), content);
  const selected = new FilesystemVaultBackend(makeConfig({ ...overrides, vaultPath: vault, cacheDir: path.join(root, "cache"), autoAgentEditAt: true }));
  await selected.initialize();
  await connect(selected);
}

function read(heading = "Section", args: Record<string, unknown> = {}) {
  return client.callTool({ name: "obsidian_read_note_section", arguments: { path: "Note.md", heading, ...args } });
}

function expectError(result: Awaited<ReturnType<typeof read>>, code?: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  if (code) expect(JSON.stringify(result.content)).toContain(`${code}:`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  try { await client?.close(); }
  finally {
    try { await server?.close(); }
    finally {
      await backend?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
      root = undefined;
    }
  }
});

describe("OBS-004 MCP section reader", () => {
  it("advertises the exact read-only input/output contract and server bounds", async () => {
    await setup();
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "obsidian_read_note_section")!;
    expect(tool.inputSchema.required).toEqual(["path", "heading"]);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["path", "heading", "occurrence", "max_chars"]);
    expect(tool.inputSchema.properties).toMatchObject({ occurrence: { type: "integer", minimum: 1 }, max_chars: { type: "integer", minimum: 1, maximum: 100_000, default: 20_000 } });
    expect(tool.outputSchema?.required).toEqual(["path", "heading", "level", "content", "truncated", "start_line", "end_line", "revision"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    const noteRead = vi.spyOn(backend, "readNote");
    const result = await read();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ path: "Note.md", heading: "Section", level: 1, content: "body\n", truncated: false, start_line: 2, end_line: 3, revision: revisionOf("# Section\nbody\n") });
    expect(noteRead).toHaveBeenCalledExactlyOnceWith("Note.md");
  });

  it.each([
    ["Parent", 1, "intro  \n\n## Child\nchild\n### Deep\ndeep\n## Peer\npeer\n", 2, 10],
    ["Child", 2, "child\n### Deep\ndeep\n", 5, 8],
    ["Deep", 3, "deep\n", 7, 8],
    ["Peer", 2, "peer\n", 9, 10],
  ])("reads nested %s until its next same-or-higher hierarchy heading", async (heading, level, content, start, end) => {
    await setup("# Parent\nintro  \n\n## Child\nchild\n### Deep\ndeep\n## Peer\npeer\n# Tail\ntail\n");
    expect((await read(heading)).structuredContent).toMatchObject({ heading, level, content, truncated: false, start_line: start, end_line: end });
  });

  it("requires an occurrence for duplicates and selects each in source order", async () => {
    await setup("# Same\nfirst\n## Same\nsecond\n# Tail\n");
    expectError(await read("Same"), "AMBIGUOUS_HEADING");
    expect((await read("Same", { occurrence: 1 })).structuredContent).toMatchObject({ content: "first\n## Same\nsecond\n", level: 1, start_line: 2, end_line: 5 });
    expect((await read("Same", { occurrence: 2 })).structuredContent).toMatchObject({ content: "second\n", level: 2, start_line: 4, end_line: 5 });
    expectError(await read("Same", { occurrence: 3 }), "HEADING_NOT_FOUND");
  });

  it("reports missing headings, case mismatches and out-of-range occurrences", async () => {
    await setup();
    expectError(await read("Absent"), "HEADING_NOT_FOUND");
    expectError(await read("section"), "HEADING_NOT_FOUND");
    expectError(await read("Section", { occurrence: 2 }), "HEADING_NOT_FOUND");
  });

  it.each([0, -1, 1.5, "1", null])("rejects invalid occurrence %j before backend access", async (occurrence) => {
    await setup();
    const noteRead = vi.spyOn(backend, "readNote");
    expectError(await read("Section", { occurrence }));
    expect(noteRead).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\n"])('rejects blank heading %j', async (heading) => {
    await setup();
    expectError(await read(heading));
  });

  it("ignores fenced/indented code headings and retains all original body whitespace", async () => {
    const body = "\n  keep  \n\tspace\n```md\n# Section\n# Fake\n```\n~~~md\n# Tilde\n~~~\n\n    # Indented\n\n";
    await setup(`# Section\n${body}# End\n`);
    expect((await read()).structuredContent).toMatchObject({ content: body, truncated: false });
    for (const heading of ["Fake", "Tilde", "Indented"]) expectError(await read(heading), "HEADING_NOT_FOUND");
  });

  it("uses AST plain text for formatted and setext headings with indented boundaries", async () => {
    await setup("preamble\n\nTitle *Việt* 🚀\n===\nfirst\n\nSub **head**\n---\nchild\n  # Tail\nuntouched\n");
    expect((await read("  Title Việt 🚀  ")).structuredContent).toMatchObject({ heading: "Title Việt 🚀", level: 1, content: "first\n\nSub **head**\n---\nchild\n", start_line: 5, end_line: 10 });
    expect((await read("Sub head")).structuredContent).toMatchObject({ level: 2, content: "child\n", start_line: 9, end_line: 10 });
  });

  it.each(["", "\uFEFF"])('keeps CRLF, Unicode and exact revision with BOM=%j', async (bom) => {
    const body = "\r\n日本語 / Cafe\u0301 / 🚀  \r\n## Con\r\n\uFEFFinside\r\n";
    const source = `${bom}# Tiếng Việt 🚀\r\n${body}# End\r\n`;
    await setup(source);
    expect((await read("Tiếng Việt 🚀")).structuredContent).toMatchObject({ heading: "Tiếng Việt 🚀", content: body, start_line: 2, end_line: 6, revision: revisionOf(source) });
  });

  it.each([
    ["# Section", "", 2, 2],
    ["# Section\n", "", 2, 2],
    ["# Section\n# Next\n", "", 2, 2],
    ["# Section\r\n# Next\r\n", "", 2, 2],
    ["# Section\n\n# Next\n", "\n", 2, 3],
    ["# Section\nbody", "body", 2, 3],
    ["# Section\rbody\r# Next", "body\r", 2, 3],
    ["Section\n-------\n# Next\n", "", 3, 3],
  ])("handles empty bodies and EOF line bounds: %j", async (source, content, start, end) => {
    await setup(source);
    expect((await read()).structuredContent).toMatchObject({ content, truncated: false, start_line: start, end_line: end });
  });

  it.each([
    [1, "", true], [2, "🚀", true], [3, "🚀a", true], [4, "🚀a", true],
    [5, "🚀a🧭", true], [6, "🚀a🧭\n", false], [7, "🚀a🧭\n", false],
  ])("respects max_chars=%i without splitting surrogate pairs", async (max_chars, content, truncated) => {
    const source = "# Section\n🚀a🧭\n# End\n";
    await setup(source);
    expect((await read("Section", { max_chars })).structuredContent).toMatchObject({ content, truncated, start_line: 2, end_line: 3, revision: revisionOf(source) });
  });

  it("enforces the default limit and hard cap without overflowing into another section", async () => {
    await setup(`# Section\n${"x".repeat(100_001)}\n# Tail\nsentinel\n`);
    expect((await read()).structuredContent).toMatchObject({ content: "x".repeat(20_000), truncated: true, start_line: 2, end_line: 3 });
    expect((await read("Section", { max_chars: 100_000 })).structuredContent).toMatchObject({ content: "x".repeat(100_000), truncated: true });
    expect((await read("Tail")).structuredContent).toMatchObject({ content: "sentinel\n", truncated: false });
  });

  it("returns the whole-note revision even when only another section changes", async () => {
    const source = "# Section\nkeep\n# Tail\nold\n";
    await setup(source);
    const first = (await read()).structuredContent;
    const changed = source.replace("old", "new");
    await fs.writeFile(path.join(vault, "Note.md"), changed);
    expect((await read()).structuredContent).toEqual({ ...first, revision: revisionOf(changed) });
    expect(first?.revision).toBe(revisionOf(source));
    expect(revisionOf(changed)).not.toBe(first?.revision);
  });

  it.each([0, -1, 1.5, 100_001, "100", null])("rejects invalid max_chars %j at the schema boundary", async (max_chars) => {
    await setup();
    const noteRead = vi.spyOn(backend, "readNote");
    expectError(await read("Section", { max_chars }));
    expect(noteRead).not.toHaveBeenCalled();
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("never mutates notes, timestamps or vault entries in readOnly=%j mode (existing stamp=%j)", async (readOnly, existingStamp) => {
    const source = existingStamp ? "\uFEFF---\r\nagents_edit_at: '2020-01-01T00:00:00.000Z'\r\n---\r\n# Section\r\nkeep  \r\n" : "# Section\r\nkeep  \r\n";
    await setup(source, { readOnly, writePaths: ["NoWriteAccess"] });
    const before = await fs.stat(path.join(vault, "Note.md"));
    const entries = await fs.readdir(vault);
    const state = await fs.readdir(root!, { recursive: true });
    expect((await read()).structuredContent).toMatchObject({ content: "keep  \r\n", revision: revisionOf(source) });
    expect((await read("Section", { max_chars: 1 })).structuredContent).toMatchObject({ content: "k", truncated: true });
    expectError(await read("Absent"), "HEADING_NOT_FOUND");
    expect(await fs.readFile(path.join(vault, "Note.md"))).toEqual(Buffer.from(source));
    const after = await fs.stat(path.join(vault, "Note.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(await fs.readdir(vault)).toEqual(entries);
    expect(await fs.readdir(root!, { recursive: true })).toEqual(state); // Reads create no locks or cache entries.
  });

  it.each(["../outside.md", "folder/../../outside.md", "/etc/passwd", "C:\\secret.md", "\\\\server\\secret.md"])('rejects unsafe path %j', async (unsafe) => {
    await setup();
    expectError(await read("Section", { path: unsafe }));
  });

  it("inherits backend read ACLs for direct paths and symlinks", async () => {
    await setup(undefined, { readPaths: ["Public"] });
    await fs.mkdir(path.join(vault, "Public"));
    await fs.mkdir(path.join(vault, "Private"));
    await fs.writeFile(path.join(vault, "Public", "Allowed.md"), "# Section\nallowed\n");
    await fs.writeFile(path.join(vault, "Private", "Secret.md"), "# Section\nsecret\n");
    await fs.symlink(path.join(vault, "Private"), path.join(vault, "Public", "Alias"), "dir");
    expect((await read("Section", { path: "Public/Allowed.md" })).structuredContent).toMatchObject({ path: "Public/Allowed.md", content: "allowed\n" });
    for (const denied of ["Note.md", "Private/Secret.md", "Public/Alias/Secret.md"]) expectError(await read("Section", { path: denied }), "ACCESS_DENIED");
  });

  it("rejects symlinks escaping the vault and missing files through readNote", async () => {
    await setup();
    await fs.writeFile(path.join(root!, "Secret.md"), "# Section\nsecret\n");
    await fs.symlink(path.join(root!, "Secret.md"), path.join(vault, "Escape.md"));
    await fs.symlink(root!, path.join(vault, "Escape"), "dir");
    expectError(await read("Section", { path: "Escape.md" }), "INVALID_PATH");
    expectError(await read("Section", { path: "Escape/Secret.md" }), "INVALID_PATH");
    expectError(await read("Section", { path: "Missing.md" }), "NOT_FOUND");
  });

  it("inherits the whole-file size limit even when the requested output is tiny", async () => {
    await setup("# Section\nlarge\n", { maxFileSizeBytes: 10 });
    expectError(await read("Section", { max_chars: 1 }), "FILE_TOO_LARGE");
  });
});

describe("OBS-004 Local REST read compatibility", () => {
  it.each([
    ['"opaque-etag"', "Wed, 21 Oct 2026 00:00:00 GMT", '"opaque-etag"'],
    [null, "Wed, 21 Oct 2026 00:00:00 GMT", "Wed, 21 Oct 2026 00:00:00 GMT"],
    [null, null, null],
  ])("uses only backend readNote and returns actual revision %j", async (etag, lastModified, revision) => {
    const forwarded = vi.spyOn(RestClient.prototype, "readNote").mockResolvedValue({ path: "Canonical.md", content: "# Section\nlegacy\n# Tail\n", contentType: "text/markdown", etag, lastModified });
    await connect(new LocalRestBackend(makeConfig({ backend: "local-rest", obsidianApiKey: "synthetic", obsidianBaseUrl: "https://obs-004.invalid" })));
    const noteRead = vi.spyOn(backend, "readNote");
    const write = vi.spyOn(RestClient.prototype, "writeNote");
    const patch = vi.spyOn(RestClient.prototype, "patchFrontmatter");
    expect((await read()).structuredContent).toEqual({ path: "Canonical.md", heading: "Section", level: 1, content: "legacy\n", truncated: false, start_line: 2, end_line: 3, revision });
    expect(noteRead).toHaveBeenCalledExactlyOnceWith("Note.md");
    expect(forwarded).toHaveBeenCalledExactlyOnceWith("Note.md");
    expect(write).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});
