import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import chokidar, { type FSWatcher } from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { VaultAccessPolicy } from "../src/backend/accessPolicy.js";
import { VaultSearchService } from "../src/backend/search.js";
import { createMcpServer } from "../src/server.js";
import { revisionOf } from "./regressionFixtures.js";
import type { SearchQuery } from "../src/backend/types.js";
import type { AppConfig } from "../src/types.js";
import { makeConfig } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(indexMode: "scan" | "indexed" | "auto", watchMode: "off" | "on", count = 1, overrides: Partial<AppConfig> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obs-006-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault);
  // A nonempty initial snapshot avoids the old empty-index lazy scan hiding K04.
  await fs.writeFile(path.join(vault, "Seed.md"), "unrelated seed");
  await Promise.all(Array.from({ length: count - 1 }, (_, i) => fs.writeFile(path.join(vault, `Seed-${i}.md`), "unrelated seed")));
  const config = makeConfig({ vaultPath: vault, cacheDir: path.join(root, "cache"), indexMode, watchMode, autoAgentEditAt: true, ...overrides });
  const backend = new FilesystemVaultBackend(config);
  cleanups.push(async () => { try { await backend.close(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  await backend.initialize();
  return { backend, vault, config };
}

async function paths(backend: FilesystemVaultBackend, query: Partial<SearchQuery> = {}) {
  return (await backend.search({ limit: 100, sort: "path", ...query })).results.map((result) => result.path);
}

for (const indexMode of ["scan", "indexed"] as const) {
  for (const watchMode of ["off", "on"] as const) {
    describe(`${indexMode}, watch ${watchMode}: committed mutations are immediately searchable`, () => {
      it("creates, replaces, appends and patches content/metadata without rebuilding", async () => {
        const { backend } = await setup(indexMode, watchMode);
        let note = await backend.writeNote("Notes/Việt.md", "---\nstatus: old\ntags: [oldtag]\n---\n# H\nobsoleteword\n");
        expect(await paths(backend, { query: "obsoleteword" })).toEqual([note.path]);
        note = await backend.writeNote(note.path, "---\nstatus: new\ntags: [newtag]\n---\n# H\nreplacementword\n", { mode: "replace", expectedRevision: note.revision });
        expect(await paths(backend, { query: "obsoleteword" })).toEqual([]);
        expect(await paths(backend, { tag: "oldtag" })).toEqual([]);
        expect(await paths(backend, { frontmatter: { status: "old" } })).toEqual([]);
        expect(await paths(backend, { query: "replacementword", tag: "newtag", frontmatter: { status: "new" } })).toEqual([note.path]);
        note = await backend.appendToNote(note.path, "\nappendword", note.revision);
        expect(await paths(backend, { query: "appendword" })).toEqual([note.path]);
        note = await backend.patchHeading(note.path, "H", "headingword", "replace", { expectedRevision: note.revision });
        expect(await paths(backend, { query: "appendword" })).toEqual([]);
        expect(await paths(backend, { query: "headingword" })).toEqual([note.path]);
        note = await backend.patchFrontmatter(note.path, "tags", ["#tiếng-việt"], "replace", false, note.revision);
        expect(await paths(backend, { tag: "newtag" })).toEqual([]);
        expect(await paths(backend, { tag: "#tiếng-việt" })).toEqual([note.path]);
        note = await backend.applyNoteEdits(note.path, note.revision, {
          frontmatter: [{ field: "status", value: "final", operation: "replace", createIfMissing: false }],
          sections: [{ heading: "H", content: "atomicword", operation: "replace" }],
        });
        expect(await paths(backend, { query: "headingword" })).toEqual([]);
        expect(await paths(backend, { query: "atomicword", frontmatter: { status: "final" } })).toEqual([note.path]);
        const metadata = await backend.readNoteMetadata(note.path);
        expect(await paths(backend, { frontmatter: { agents_edit_at: metadata.frontmatter.agents_edit_at } })).toContain(note.path);
      });

      it("removes ghosts on file/folder moves, overwrite and recursive deletion", async () => {
        const { backend } = await setup(indexMode, watchMode);
        const source = await backend.writeNote("From/Nested/A.md", "sourcemarker");
        const destination = await backend.writeNote("Destination.md", "destinationmarker");
        await backend.rebuildSearchIndex(); // Isolate move/delete from create freshness.
        await backend.movePath(source.path, destination.path, { overwrite: true, expectedRevision: source.revision, expectedDestinationRevision: destination.revision });
        expect(await paths(backend, { query: "sourcemarker" })).toEqual([destination.path]);
        expect(await paths(backend, { query: "destinationmarker" })).toEqual([]);
        await backend.movePath(destination.path, "From/Nested/Renamed.md", { expectedRevision: source.revision });
        expect(await paths(backend, { query: "sourcemarker" })).toEqual(["From/Nested/Renamed.md"]);
        await backend.movePath("From", "To");
        expect(await paths(backend, { query: "sourcemarker" })).toEqual(["To/Nested/Renamed.md"]);
        await backend.deletePath("To", { recursive: true });
        expect(await paths(backend, { query: "sourcemarker" })).toEqual([]);
        await backend.deletePath("Seed.md", { expectedRevision: (await backend.readNote("Seed.md")).revision! });
        expect(await paths(backend)).toEqual([]);
      });
    });
  }
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function captureWatcher() {
  const watch = chokidar.watch;
  let watcher!: FSWatcher;
  vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
    watcher = watch(...args);
    return watcher;
  });
  return () => watcher;
}

for (const mode of ["scan", "indexed"] as const) {
  describe(`${mode}: ordering, failure isolation and exact qualification`, () => {
    it("treats late unlink/add/change events as current-state reconciliation", async () => {
      const watcher = captureWatcher();
      const { backend, vault } = await setup(mode, "on");
      const note = await backend.writeNote("Current.md", "currentmarker");
      watcher().emit("unlink", path.join(vault, note.path));
      expect(await paths(backend, { query: "currentmarker" })).toEqual([note.path]);
      await backend.deletePath(note.path, { expectedRevision: note.revision });
      watcher().emit("add", path.join(vault, note.path));
      watcher().emit("change", path.join(vault, note.path));
      expect(await paths(backend, { query: "currentmarker" })).toEqual([]);
    });

    it("does not let an in-flight old watcher read overwrite a newer commit or rebuild", async () => {
      const watcher = captureWatcher();
      const { backend, vault } = await setup(mode, "on");
      const target = path.join(vault, "Current.md");
      await fs.writeFile(target, "oldwatchmarker");
      const captured = signal();
      const release = signal();
      const committed = signal();
      const originalPolicy = new VaultAccessPolicy(vault, false, [], []);
      const allowed = originalPolicy.allowsSearchPath.bind(originalPolicy);
      let checks = 0;
      vi.spyOn(VaultAccessPolicy.prototype, "allowsSearchPath").mockImplementation(async (absolute, directory) => {
        const result = await allowed(absolute, directory);
        // Third check: content has already been read, just before publishing it.
        if (absolute === target && ++checks === 3) { captured.resolve(); await release.promise; }
        return result;
      });
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (args[1] === target) committed.resolve();
      });
      watcher().emit("change", target);
      await captured.promise;
      const write = backend.writeNote("Current.md", "newcommitmarker", { mode: "replace", expectedRevision: revisionOf("oldwatchmarker") });
      try {
        await committed.promise;
      } finally { release.resolve(); }
      await write;
      expect(await paths(backend, { query: "newcommitmarker" })).toEqual(["Current.md"]);
      expect(await paths(backend, { query: "oldwatchmarker" })).toEqual([]);
      await backend.rebuildSearchIndex();
      expect(await paths(backend, { query: "newcommitmarker" })).toEqual(["Current.md"]);
      expect(await paths(backend, { query: "oldwatchmarker" })).toEqual([]);
    });

    it("keeps revision conflicts and concurrent creates consistent", async () => {
      const { backend } = await setup(mode, "off");
      const original = await backend.writeNote("Concurrent.md", "originalmarker");
      const updates = await Promise.allSettled([
        backend.writeNote(original.path, "firstwinner", { mode: "replace", expectedRevision: original.revision }),
        backend.writeNote(original.path, "secondwinner", { mode: "replace", expectedRevision: original.revision }),
        backend.writeNote("Other.md", "othermarker"),
      ]);
      expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect(updates.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
      const current = await backend.readNote(original.path);
      expect(await paths(backend, { query: "originalmarker" })).toEqual([]);
      expect(await paths(backend, { query: current.content.includes("firstwinner") ? "firstwinner" : "secondwinner" })).toEqual([original.path]);
      expect(await paths(backend, { query: "othermarker" })).toEqual(["Other.md"]);
    });

    it("does not synchronize no-ops, conflicts, invalid edits or failed atomic writes", async () => {
      const { backend } = await setup(mode, "off");
      const note = await backend.writeNote("Stable.md", "# H\nstablemarker\n");
      const current = await backend.readNote(note.path);
      const synchronize = vi.spyOn(VaultSearchService.prototype, "synchronize");
      await backend.writeNote(note.path, current.content, { mode: "replace", expectedRevision: note.revision });
      await backend.appendToNote(note.path, "", note.revision);
      await backend.movePath(note.path, note.path, { overwrite: true, expectedRevision: note.revision, expectedDestinationRevision: note.revision });
      await expect(backend.appendToNote(note.path, "bad", "stale")).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(backend.patchHeading(note.path, "Missing", "bad", "replace", { expectedRevision: note.revision })).rejects.toMatchObject({ code: "HEADING_NOT_FOUND" });
      await expect(backend.patchFrontmatter(note.path, "agents_edit_at", "bad", "replace", true, note.revision)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("injected atomic failure"), { code: "EIO" }));
      await expect(backend.appendToNote(note.path, "bad", note.revision)).rejects.toMatchObject({ code: "TOOL_ERROR" });
      expect(synchronize).not.toHaveBeenCalled();
      expect((await backend.readNote(note.path)).content).toBe(current.content);
      expect(await paths(backend, { query: "stablemarker" })).toEqual([note.path]);
    });

    it("reports a committed write if refresh fails and blocks stale queries until rebuild", async () => {
      const { backend, vault } = await setup(mode, "off");
      const note = await backend.writeNote("Failure.md", "beforefailure");
      const target = path.join(vault, note.path);
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === target) throw new Error("injected index read failure");
        return open(...args);
      });
      await expect(backend.writeNote(note.path, "afterfailure", { mode: "replace", expectedRevision: note.revision })).rejects.toMatchObject({ code: "INDEX_ERROR", details: { committed: true } });
      expect((await backend.readNote(note.path)).content).toContain("afterfailure");
      expect(await backend.status()).toMatchObject({ indexState: "degraded" });
      await expect(backend.search({ query: "beforefailure", limit: 10 })).rejects.toMatchObject({ code: "INDEX_ERROR" });
      vi.restoreAllMocks();
      // A later commit must not falsely acknowledge recovery of a partial index.
      await expect(backend.writeNote("Later.md", "latermarker")).rejects.toMatchObject({ code: "INDEX_ERROR", details: { committed: true } });
      await backend.rebuildSearchIndex();
      expect(await paths(backend, { query: "latermarker" })).toEqual(["Later.md"]);
      expect(await paths(backend, { query: "afterfailure" })).toEqual([note.path]);
      expect(await paths(backend, { query: "beforefailure" })).toEqual([]);
    });

    it("applies exact substring, case, regex, tags, frontmatter and folder filters before stable pagination", async () => {
      const { backend } = await setup(mode, "off");
      for (const name of ["A", "B", "C"]) await backend.writeNote(`Notes/${name}.md`, "---\nstatus: active\ntags: ['#tiếng-việt', project/test]\n---\nCafé 日本語 AlphaBeta\n");
      await backend.writeNote("NotesExtra/D.md", "Café 日本語 AlphaBeta");
      await backend.writeNote("Notes/E.md", "---\nstatus: inactive\ntags: [tiếng-việt]\n---\nCafé 日本語 AlphaBeta\n");
      await backend.rebuildSearchIndex(); // Isolate query qualification from freshness.
      const query: SearchQuery = { query: "fé 日本語 Alpha", match: "exact", folder: "Notes", tag: "#tiếng-việt", frontmatter: { status: "active" }, regex: "AlphaB.ta", caseSensitive: true, sort: "path", limit: 2 };
      const first = await backend.search(query);
      expect(first.results.map((result) => result.path)).toEqual(["Notes/A.md", "Notes/B.md"]);
      const second = await backend.search({ ...query, cursor: first.nextCursor! });
      expect(second.results.map((result) => result.path)).toEqual(["Notes/C.md"]);
      expect(second.nextCursor).toBeUndefined();
      expect(await paths(backend, { ...query, query: "alphabeta", regex: undefined })).toEqual([]);
      expect(await paths(backend, { ...query, query: "alphabeta", regex: undefined, caseSensitive: false, limit: 100 })).toEqual(["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
      expect(await paths(backend, { match: "exact", query: "AlphaBxta" })).toEqual([]);
      // Indexed simple search retains its historical fuzzy/prefix behavior.
      if (mode === "indexed") expect(await paths(backend, { query: "AlphaBxta" })).toContain("Notes/A.md");
    });
  });
}

for (const mode of ["scan", "indexed"] as const) {
  it(`${mode}: reconciles writes and moves across distinct read/write scopes`, async () => {
    const { backend } = await setup(mode, "off", 1, { readPaths: ["Public/Nested"], writePaths: ["Public", "Private"] });
    const hidden = await backend.writeNote("Private/Hidden.md", "scopedmarker");
    expect(await paths(backend)).toEqual([]);
    await backend.movePath("Private", "Public");
    // Ancestors of a read scope are traversable, but not directly readable.
    expect(await paths(backend)).toEqual([]);
    await backend.movePath("Public/Hidden.md", "Public/Nested/Visible.md", { expectedRevision: hidden.revision });
    expect(await paths(backend, { query: "scopedmarker" })).toEqual(["Public/Nested/Visible.md"]);
    await backend.movePath("Public", "Private");
    expect(await paths(backend)).toEqual([]);
    const refresh = vi.spyOn(VaultSearchService.prototype, "synchronize");
    await expect(backend.writeNote("Publicity/Denied.md", "deniedmarker")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await paths(backend, { regex: "deniedmarker|scopedmarker" })).toEqual([]);
  });

  it(`${mode}: reconciles canonical targets of allowed directory aliases without indexing links or controls`, async () => {
    const { backend, vault } = await setup(mode, "off");
    await backend.createFolder("Real");
    await fs.symlink(path.join(vault, "Real"), path.join(vault, "Alias"), process.platform === "win32" ? "junction" : "dir");
    let note = await backend.writeNote("Alias/Note.md", "prehistory");
    expect(await paths(backend, { query: "prehistory" })).toEqual(["Real/Note.md"]);
    note = await backend.writeNote(note.path, "modernstate", { mode: "replace", expectedRevision: note.revision });
    expect(await paths(backend, { query: "prehistory" })).toEqual([]);
    expect(await paths(backend, { query: "modernstate" })).toEqual(["Real/Note.md"]);
    await backend.movePath(note.path, "Alias/Renamed.md", { expectedRevision: note.revision });
    expect(await paths(backend, { query: "modernstate" })).toEqual(["Real/Renamed.md"]);
    await backend.deletePath("Alias/Renamed.md", { expectedRevision: note.revision });
    expect(await paths(backend, { query: "modernstate" })).toEqual([]);
    for (const folder of [".obsidian", ".git", ".obsidian-vault-mcp-hidden"]) await backend.writeNote(`${folder}/Hidden.md`, "excludedmarker");
    const outside = path.join(path.dirname(vault), "Outside.md");
    await fs.writeFile(outside, "outsidemarker");
    await fs.symlink(outside, path.join(vault, "Escape.md"));
    await expect(backend.appendToNote("Escape.md", "bad", revisionOf("outsidemarker"))).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await paths(backend, { regex: "excludedmarker|outsidemarker" })).toEqual([]);
    await backend.writeNote("Upper.MD", "uppermarker");
    await backend.movePath("Upper.MD", "Upper.txt", { expectedRevision: (await backend.readNote("Upper.MD")).revision! });
    expect(await paths(backend, { query: "uppermarker" })).toEqual([]);
    await backend.movePath("Upper.txt", "Upper.MD", { expectedRevision: (await backend.readNote("Upper.txt")).revision! });
    expect(await paths(backend, { query: "uppermarker" })).toEqual(["Upper.MD"]);
  });

  it(`${mode}: leaves search unchanged for read-only and oversized failures`, async () => {
    const { backend, config } = await setup(mode, "off", 1, { maxFileSizeBytes: 256 });
    const refresh = vi.spyOn(VaultSearchService.prototype, "synchronize");
    await expect(backend.writeNote("Big.md", "🚀".repeat(100))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    const readonly = new FilesystemVaultBackend({ ...config, readOnly: true });
    cleanups.push(() => readonly.close());
    await readonly.initialize();
    await expect(readonly.writeNote("Denied.md", "bad")).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await paths(backend)).toEqual(["Seed.md"]);
    expect(await paths(readonly)).toEqual(["Seed.md"]);
  });
}

it("reports cache invalidation failure after commit and can recover through rebuild", async () => {
  const { backend } = await setup("indexed", "off");
  const remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("search-index.json")) throw new Error("injected cache invalidation failure");
    return remove(...args);
  });
  await expect(backend.writeNote("Committed.md", "committedmarker")).rejects.toMatchObject({ code: "INDEX_ERROR", details: { committed: true } });
  expect((await backend.readNote("Committed.md")).content).toContain("committedmarker");
  await expect(backend.search({ limit: 10 })).rejects.toMatchObject({ code: "INDEX_ERROR" });
  vi.restoreAllMocks();
  await backend.rebuildSearchIndex();
  expect(await paths(backend, { query: "committedmarker" })).toEqual(["Committed.md"]);
});

it.each([10, 1000])("performance smoke: edits one note without scanning a %i-note auto vault", async (count) => {
  const { backend, vault } = await setup("auto", "off", count);
  expect((await backend.status()).indexState).toBe(count < 1000 ? "scan" : "ready");
  const readdir = vi.spyOn(fs, "readdir");
  const open = vi.spyOn(fs, "open");
  const start = performance.now();
  await backend.writeNote("Seed.md", "performancemarker", { mode: "replace", expectedRevision: revisionOf("unrelated seed") });
  const elapsedMs = performance.now() - start;
  expect(readdir).not.toHaveBeenCalled();
  const indexedBodies = open.mock.calls.filter(([file]) => file === path.join(vault, "Seed.md"));
  expect(indexedBodies).toHaveLength(1);
  expect(open.mock.calls).toHaveLength(2); // One atomic temp write, one index read.
  process.stdout.write(`OBS-006 perf: vault=${count}, refreshed=1, directoryReads=0, indexBodyReads=1, editMs=${elapsedMs.toFixed(2)}\n`);
  expect(await paths(backend, { query: "performancemarker" })).toEqual(["Seed.md"]);
});

it("keeps auto mode stable across the 1000-note boundary until an explicit rebuild", async () => {
  const { backend } = await setup("auto", "off", 999);
  await backend.writeNote("Boundary.md", "boundarymarker");
  expect((await backend.status()).indexState).toBe("scan");
  expect(await paths(backend, { query: "boundarymarker" })).toEqual(["Boundary.md"]);
  expect(await backend.rebuildSearchIndex()).toEqual({ indexedFiles: 1000, mode: "indexed" });
  await backend.deletePath("Boundary.md", { expectedRevision: (await backend.readNote("Boundary.md")).revision! });
  expect((await backend.status()).indexState).toBe("ready");
  expect(await paths(backend, { query: "boundarymarker" })).toEqual([]);
});

it.each(["move", "delete"] as const)("reports a committed %s when cache invalidation fails", async (operation) => {
  const { backend } = await setup("indexed", "off");
  const note = await backend.writeNote("Before.md", "partialcommitmarker");
  await backend.rebuildSearchIndex();
  const remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("search-index.json")) throw new Error("injected invalidation failure");
    return remove(...args);
  });
  const result = operation === "move"
    ? backend.movePath(note.path, "After.md", { expectedRevision: note.revision })
    : backend.deletePath(note.path, { expectedRevision: note.revision });
  await expect(result).rejects.toMatchObject({ code: "INDEX_ERROR", details: { committed: true } });
  expect((await backend.statPath(note.path)).exists).toBe(false);
  await expect(backend.search({ limit: 10 })).rejects.toMatchObject({ code: "INDEX_ERROR" });
  vi.restoreAllMocks();
  await backend.rebuildSearchIndex();
  expect(await paths(backend, { query: "partialcommitmarker" })).toEqual(operation === "move" ? ["After.md"] : []);
});

it("does not scan an empty snapshot on searches and picks up external watch-off edits only on rebuild", async () => {
  const { backend, vault } = await setup("scan", "off");
  await backend.deletePath("Seed.md", { expectedRevision: revisionOf("unrelated seed") });
  await fs.writeFile(path.join(vault, "External.md"), "externalmarker");
  const readdir = vi.spyOn(fs, "readdir");
  expect(await paths(backend, { query: "externalmarker" })).toEqual([]);
  expect(readdir).not.toHaveBeenCalled();
  await backend.rebuildSearchIndex();
  expect(await paths(backend, { query: "externalmarker" })).toEqual(["External.md"]);
});

it.each(["scan", "indexed"] as const)("%s: honors caseSensitive qualification for a whole query token", async (mode) => {
  const { backend } = await setup(mode, "off");
  await backend.writeNote("Case.md", "AlphaBeta");
  await backend.rebuildSearchIndex();
  expect(await paths(backend, { query: "alphabeta", caseSensitive: true })).toEqual([]);
  expect(await paths(backend, { query: "AlphaBeta", caseSensitive: true })).toEqual(["Case.md"]);
});

it.each(["scan", "indexed"] as const)("%s: preserves MCP rename, simple search and advanced search response contracts", async (mode) => {
  const { backend } = await setup(mode, "off");
  const server = createMcpServer(backend);
  const client = new Client({ name: "obs-006-isolated", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { try { await client.close(); } finally { await server.close(); } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const created = await client.callTool({ name: "obsidian_write_note", arguments: { path: "Contract.md", content: "Alpha café 日本語" } });
  expect(created.isError).not.toBe(true);
  const note = await backend.readNote("Contract.md");
  const renamed = await client.callTool({ name: "obsidian_rename_path", arguments: { path: "Contract.md", new_name: "Renamed.md", expected_revision: note.revision } });
  expect(renamed.isError).not.toBe(true);
  const advanced = await client.callTool({ name: "obsidian_search_content_advanced", arguments: { query: "lpha café", case_sensitive: true } });
  expect(advanced.isError).not.toBe(true);
  expect(advanced.structuredContent).toMatchObject({ results: [{ path: "Renamed.md" }] });
  expect(advanced.structuredContent).not.toHaveProperty("query");
  const query = mode === "indexed" ? "Alphx" : "Alpha";
  const simple = await client.callTool({ name: "obsidian_search", arguments: { query } });
  expect(simple.isError).not.toBe(true);
  expect(simple.structuredContent).toMatchObject({ query, results: [{ path: "Renamed.md" }] });
});

it("blocks queries after a failed persisted rebuild until recovery", async () => {
  const { backend } = await setup("indexed", "off");
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && args[0].includes("search-index.json.")) throw new Error("injected snapshot persistence failure");
    return write(...args);
  });
  await expect(backend.rebuildSearchIndex()).rejects.toThrow("injected snapshot persistence failure");
  expect(await backend.status()).toMatchObject({ indexState: "degraded" });
  await expect(backend.search({ limit: 10 })).rejects.toMatchObject({ code: "INDEX_ERROR" });
  vi.restoreAllMocks();
  await backend.rebuildSearchIndex();
  expect(await paths(backend)).toEqual(["Seed.md"]);
});
