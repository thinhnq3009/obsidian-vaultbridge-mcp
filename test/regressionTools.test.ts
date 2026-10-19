import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../src/server.js";
import { createRegressionFixture, regressionNotes, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

function errorText(content: unknown): string {
  return z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(content).map((block) => block.text).join("\n");
}

async function connect(readOnly = false) {
  fixture = await createRegressionFixture({ readOnly });
  await fs.writeFile(path.join(fixture.vault, "Map.canvas"), '{"nodes":[],"edges":[]}');
  server = createMcpServer(fixture.backend);
  client = new Client({ name: "obs-001-isolated", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

afterEach(async () => {
  vi.restoreAllMocks();
  try { await client?.close(); }
  finally { try { await server?.close(); } finally { await fixture?.close(); } }
});

const expectedTools = [
  "list_files", "read_note", "read_note_metadata", "read_canvas", "write_note", "write_notes_bulk",
  "create_canvas", "update_canvas", "delete_canvas", "append_to_note", "patch_heading", "patch_frontmatter",
  "search", "search_content_advanced", "add_canvas_node", "update_canvas_node", "remove_canvas_node",
  "add_canvas_edge", "update_canvas_edge", "remove_canvas_edge", "move_path", "rename_path", "delete_path",
  "stat_path", "tree", "create_folder", "backend_status", "vault_health", "rebuild_search_index", "get_active_file", "open_file",
].map((name) => `obsidian_${name}`).sort();

describe("OBS-001 actual MCP contracts", () => {
  beforeEach(async () => { await connect(); });

  it("advertises exactly the current 31 tools and their JSON schemas", async () => {
    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    expect(list.nextCursor).toBeUndefined();
    for (const tool of list.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }
    expect(expectedTools).not.toContain("obsidian_read_note_section");
    expect(expectedTools).not.toContain("obsidian_apply_note_edits");
  });

  it("K02: MCP metadata exposes backend headings, links and revision", async () => {
    const result = await client.callTool({ name: "obsidian_read_note_metadata", arguments: { path: "Syntax.md" } });
    expect(result.isError).not.toBe(true);
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(["frontmatter", "headings", "links", "path", "revision", "stat", "tags"]);
    const backend = await fixture.backend.readNoteMetadata("Syntax.md");
    expect(backend.headings).toEqual([{ text: "Real", level: 1 }]);
    expect(backend.links).toContain("Notes/Target");
    expect(backend.revision).toBe(revisionOf(regressionNotes["Syntax.md"]));
    expect(result.structuredContent).toEqual(backend);
    expect(result.structuredContent).not.toHaveProperty("content");
  });

  it.each([{}, { headings: [], links: [] }])("preserves backend optional fields %j without inventing revision or reading body", async (optional) => {
    const metadata = { path: "Legacy.md", tags: ["project"], frontmatter: { status: "open" }, stat: null, ...optional };
    const readMetadata = vi.spyOn(fixture.backend, "readNoteMetadata").mockResolvedValue({ ...metadata, content: "Body must not be returned." });
    const readNote = vi.spyOn(fixture.backend, "readNote");
    const result = await client.callTool({ name: "obsidian_read_note_metadata", arguments: { path: "Legacy.md" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(metadata);
    expect(readMetadata).toHaveBeenCalledExactlyOnceWith("Legacy.md");
    expect(readNote).not.toHaveBeenCalled();
  });

  it("returns MCP errors for invalid YAML and stale revisions and keeps bytes", async () => {
    const calls = [
      { name: "obsidian_read_note_metadata", arguments: { path: "Invalid.md" }, code: "INVALID_MARKDOWN" },
      { name: "obsidian_patch_frontmatter", arguments: { path: "Invalid.md", field: "status", value: "bad", expected_revision: revisionOf(regressionNotes["Invalid.md"]) }, code: "INVALID_MARKDOWN" },
      { name: "obsidian_write_note", arguments: { path: "Comments.md", content: "bad", mode: "replace", expected_revision: "stale" }, code: "CONFLICT" },
      { name: "obsidian_append_to_note", arguments: { path: "Comments.md", content: "bad", expected_revision: "stale" }, code: "CONFLICT" },
      { name: "obsidian_patch_heading", arguments: { path: "Comments.md", heading: "Kế hoạch 🚀", content: "bad", expected_revision: "stale" }, code: "CONFLICT" },
    ];
    for (const { code, ...call } of calls) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(errorText(result.content)).toContain(`${code}:`);
      expect(result.structuredContent).toBeUndefined();
    }
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
    expect(await fixture.bytes("Invalid.md")).toEqual(Buffer.from(regressionNotes["Invalid.md"]));
  });

  it("creates and safely replaces a successful bulk with independent revisions", async () => {
    const created = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [{ path: "One.md", content: "one" }, { path: "Two.md", content: "two" }] } });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ count: 2, written: [{ path: "One.md", revision: revisionOf("one") }, { path: "Two.md", revision: revisionOf("two") }] });
    const replaced = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [{ path: "One.md", content: "ONE", mode: "replace", expected_revision: revisionOf("one") }, { path: "Two.md", content: "TWO", overwrite: true, expected_revision: revisionOf("two") }] } });
    expect(replaced.isError).not.toBe(true);
    expect(await fixture.bytes("One.md")).toEqual(Buffer.from("ONE"));
    expect(await fixture.bytes("Two.md")).toEqual(Buffer.from("TWO"));
  });

  it("SEMANTICS B01: bulk stops at failure, retains earlier success, leaves failed/later files intact", async () => {
    const result = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [
      { path: "First.md", content: "committed" },
      { path: "Comments.md", content: "bad", mode: "replace", expected_revision: "stale" },
      { path: "Never.md", content: "not reached" },
    ] } });
    expect(result.isError).toBe(true);
    expect(errorText(result.content)).toContain("CONFLICT:");
    expect(result.structuredContent).toBeUndefined();
    expect(await fixture.bytes("First.md")).toEqual(Buffer.from("committed"));
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
    expect((await fixture.backend.statPath("Never.md")).exists).toBe(false);
  });

  it("rejects missing patch revisions at the schema boundary before mutation", async () => {
    const result = await client.callTool({ name: "obsidian_patch_heading", arguments: { path: "Comments.md", heading: "Kế hoạch 🚀", content: "bad" } });
    expect(result.isError).toBe(true);
    expect(await fixture.bytes("Comments.md")).toEqual(Buffer.from(regressionNotes["Comments.md"]));
  });

  it("advertised editor operations return unsupported on filesystem backend", async () => {
    for (const name of ["obsidian_get_active_file", "obsidian_open_file"]) {
      const result = await client.callTool({ name, arguments: name.endsWith("open_file") ? { path: "Comments.md" } : {} });
      expect(result.isError).toBe(true);
    }
  });
});

describe("OBS-001 read-only at every content mutation registration", () => {
  beforeEach(async () => { await connect(true); });
  const note = { path: "Comments.md", expected_revision: revisionOf(regressionNotes["Comments.md"]) };
  const canvas = { path: "Map.canvas", expected_revision: revisionOf('{"nodes":[],"edges":[]}') };
  const node = { id: "n1", type: "text", text: "test", x: 0, y: 0, width: 100, height: 100 };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["write_note", { path: "New.md", content: "bad" }],
    ["write_note", { ...note, content: "bad", mode: "replace" }],
    ["write_notes_bulk", { files: [{ path: "New.md", content: "bad" }, { ...note, content: "bad", mode: "replace" }] }],
    ["append_to_note", { ...note, content: "bad" }],
    ["patch_heading", { ...note, heading: "Kế hoạch 🚀", content: "bad" }],
    ["patch_frontmatter", { ...note, field: "status", value: "bad" }],
    ["create_canvas", { path: "New.canvas" }],
    ["update_canvas", { ...canvas, nodes: [node] }],
    ["delete_canvas", canvas],
    ["add_canvas_node", { ...canvas, node }],
    ["update_canvas_node", { ...canvas, node_id: "n1", updates: { text: "bad" } }],
    ["remove_canvas_node", { ...canvas, node_id: "n1" }],
    ["add_canvas_edge", { ...canvas, edge: { id: "e1", fromNode: "n1", toNode: "n1" } }],
    ["update_canvas_edge", { ...canvas, edge_id: "e1", updates: { label: "bad" } }],
    ["remove_canvas_edge", { ...canvas, edge_id: "e1" }],
    ["move_path", { source_path: "Comments.md", destination_path: "Moved.md", expected_revision: note.expected_revision }],
    ["rename_path", { ...note, new_name: "Moved.md" }],
    ["delete_path", note],
    ["create_folder", { path: "NewFolder" }],
  ];
  it.each(cases)("blocks %s and preserves the entire vault", async (suffix, args) => {
    // Seed a valid canvas for node/edge mutations, so validation cannot hide an
    // accidental read-only bypass behind a missing-node error.
    const seeded = JSON.stringify({ nodes: [node], edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }] });
    await fs.writeFile(path.join(fixture.vault, "Map.canvas"), seeded);
    if (args.path === "Map.canvas") args = { ...args, expected_revision: revisionOf(seeded) };
    if (suffix === "add_canvas_node") args = { ...args, node: { ...node, id: "n2" } };
    if (suffix === "add_canvas_edge") args = { ...args, edge: { id: "e2", fromNode: "n1", toNode: "n1" } };
    const before = await fs.readdir(fixture.vault);
    const result = await client.callTool({ name: `obsidian_${suffix}`, arguments: args });
    expect(result.isError).toBe(true);
    expect(errorText(result.content)).toContain("READ_ONLY:");
    expect(await fs.readdir(fixture.vault)).toEqual(before);
    for (const [name, content] of Object.entries(regressionNotes)) expect(await fixture.bytes(name)).toEqual(Buffer.from(content));
    expect(await fixture.bytes("Map.canvas")).toEqual(Buffer.from(seeded));
  });
});
