import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationAuthorization, RequestAccessPolicy } from "../src/auth/authorization.js";
import { pathActions, SqliteGrantStore, vaultGrantSchema } from "../src/auth/grants.js";
import type { PathAction, VaultGrantInput } from "../src/auth/grants.js";
import { createTestAuthContext } from "../src/auth/requestContext.js";
import type { OAuthContext } from "../src/auth/requestContext.js";
import { openAuthStorage } from "../src/auth/storage.js";
import { createRequestBackend } from "../src/backend/authorized.js";
import { VaultAccessPolicy } from "../src/backend/accessPolicy.js";
import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { LocalRestBackend } from "../src/backend/localRest.js";
import type { VaultBackend } from "../src/backend/types.js";
import { createMcpServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";
import { createTempVault, makeConfig } from "./helpers.js";

let root: string;
let vault: string;
let backend: FilesystemVaultBackend;
let db: DatabaseSync;
let grants: SqliteGrantStore;
const resource = "https://vault.example.test/mcp";
const tools = [
  "obsidian_list_files", "obsidian_read_note", "obsidian_read_note_section", "obsidian_read_note_metadata",
  "obsidian_read_canvas", "obsidian_write_note", "obsidian_write_notes_bulk", "obsidian_create_canvas",
  "obsidian_update_canvas", "obsidian_delete_canvas", "obsidian_append_to_note", "obsidian_apply_note_edits",
  "obsidian_patch_heading", "obsidian_patch_frontmatter", "obsidian_search", "obsidian_search_content_advanced",
  "obsidian_add_canvas_node", "obsidian_update_canvas_node", "obsidian_remove_canvas_node",
  "obsidian_add_canvas_edge", "obsidian_update_canvas_edge", "obsidian_remove_canvas_edge",
  "obsidian_move_path", "obsidian_rename_path", "obsidian_delete_path", "obsidian_stat_path", "obsidian_tree",
  "obsidian_create_folder", "obsidian_backend_status", "obsidian_vault_health", "obsidian_rebuild_search_index",
  "obsidian_get_active_file", "obsidian_open_file",
];
const readActions: PathAction[] = ["readNote", "readNoteMetadata", "statPath", "listFiles", "search"];

function grant(clientId = "A", prefix = "Notes", actions: PathAction[] = readActions): VaultGrantInput {
  return {
    version: 1, grantId: `grant-${clientId}`, principalId: `user-${clientId}`, clientId,
    vaultId: "vault", resource, consentScopes: ["vault:read", "vault:write"],
    principalPermissions: [{ path: prefix, actions: [...actions] }],
    clientPermissions: [{ path: prefix, actions: [...actions], tools: [...tools] }],
  };
}
function context(clientId = "A", overrides: Partial<OAuthContext> = {}): OAuthContext {
  return createTestAuthContext({
    mode: "oauth", principalId: `user-${clientId}`, clientId, grantId: `grant-${clientId}`,
    vaultId: "vault", resource, scopes: ["vault:read", "vault:write"], requestId: "request-1", ...overrides,
  });
}
function scoped(auth = context(), target: VaultBackend = backend): VaultBackend {
  return createRequestBackend(target, { context: auth, grants, vaultId: "vault", resource });
}
function run<T>(request: VaultBackend, tool: string, callback: () => Promise<T>): Promise<T> {
  return request.runWithTool!(tool, callback);
}
function read(request: VaultBackend, target = "Notes/A.md") {
  return run(request, "obsidian_read_note", () => request.readNote(target));
}
function search(request: VaultBackend, cursor?: string) {
  return run(request, "obsidian_search", () => request.search({ query: "sharedmarker", sort: "path", limit: 1, ...(cursor ? { cursor } : {}) }));
}

beforeEach(async () => {
  root = await createTempVault();
  vault = path.join(root, "vault");
  for (const folder of ["Notes", "Secret", "NotesExtra", ".obsidian"]) await fs.mkdir(path.join(vault, folder), { recursive: true });
  for (const target of ["Notes/A.md", "Notes/B.md", "Secret/A.md", "NotesExtra/A.md"]) {
    await fs.writeFile(path.join(vault, target), `---\nkind: sample\n---\n# Heading\nsharedmarker ${target} body`);
  }
  await fs.writeFile(path.join(vault, "Notes/Board.canvas"), JSON.stringify({ nodes: [], edges: [] }));
  backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: path.join(root, "cache") }));
  await backend.initialize();
  db = new DatabaseSync(":memory:");
  grants = new SqliteGrantStore(db);
  grants.put(grant());
  grants.put(grant("B", "Secret", [...pathActions]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await backend.close();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("trusted immutable request contexts and explicit grants", () => {
  it("freezes context and scopes, rejects missing fields and structural/decoded claims", () => {
    const auth = context();
    expect(Object.isFrozen(auth)).toBe(true);
    expect(Object.isFrozen(auth.scopes)).toBe(true);
    expect(() => scoped({ ...auth })).toThrow("Request authorization denied.");
    for (const field of ["principalId", "clientId", "grantId", "vaultId", "resource", "requestId", "scopes"]) {
      const input: Record<string, unknown> = { ...auth };
      delete input[field];
      expect(() => createTestAuthContext(input)).toThrow("Request authorization denied.");
    }
    expect(() => createTestAuthContext({ ...auth, scopes: [] })).toThrow();
    expect(() => createTestAuthContext({ ...auth, token: "credential" })).toThrow();
  });

  it("cannot mint trusted contexts outside the test process", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'import {createTestAuthContext} from "./src/auth/requestContext.ts"; try { createTestAuthContext({}); process.exit(1); } catch(e) { if(e.code !== "ACCESS_DENIED") process.exit(2); }',
    ], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["", ".", "/", "*", "Notes/*", "Notes/../Secret", "Notes\\Secret", "Notes//A", "Notes/.env", "Notes/.Obsidian.", "C:/Notes"])("rejects unsafe or implicit-all grant %j", (prefix) => {
    const input = grant("A", prefix);
    expect(vaultGrantSchema.safeParse(input).success).toBe(false);
    expect(() => grants.put(input)).toThrow();
  });

  it.each(["token", "none", "stdio"] as const)("preserves %s legacy global-policy behavior without manufacturing principals", async (mode) => {
    const request = createRequestBackend(backend, { context: { mode }, grants, vaultId: "vault", resource });
    expect(request).toBe(backend);
    expect((await request.readNote("Secret/A.md")).content).toContain("Secret/A.md");
  });

  it.each([
    { principalId: "other" }, { clientId: "other" }, { vaultId: "other" }, { resource: "https://wrong.test/mcp" },
    { grantId: "missing" }, { scopes: ["unrecognized"] },
  ])("denies mismatched binding or absent scope %j", async (overrides) => {
    await expect(read(scoped(context("A", overrides)))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("intersects principal action/path, consent scopes, token scope and exact tool/action rights", async () => {
    const input = grant();
    input.clientPermissions[0]!.path = "Secret";
    grants.put(input);
    await expect(read(scoped())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    input.clientPermissions[0]!.path = "Notes";
    input.consentScopes = ["vault:write"];
    grants.put(input);
    await expect(read(scoped())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    input.consentScopes = ["vault:read"];
    input.clientPermissions[0]!.tools = ["obsidian_read_note_metadata"];
    grants.put(input);
    await expect(read(scoped())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const request = scoped();
    await expect(run(request, "obsidian_read_note_metadata", () => request.readNoteMetadata("Notes/A.md"))).resolves.toMatchObject({ path: "Notes/A.md" });
    await expect(request.readNote("Notes/A.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("returns a typed path decision and rejects unconsented action even with a matching path", () => {
    const authorization = new OperationAuthorization(context(), grants, "vault", resource, "obsidian_read_note", "readNote");
    expect(authorization.decide("Notes/A.md")).toEqual({ allowed: true, code: "ALLOW" });
    expect(authorization.decide("NotesExtra/A.md")).toEqual({ allowed: false, code: "ACCESS_DENIED" });
    const policy = new RequestAccessPolicy(vault, new VaultAccessPolicy(vault, false, [], []), authorization);
    expect(policy.authorize("Notes/A.md", "read")).toBe("Notes/A.md");
    expect(() => policy.authorize("Notes/A.md", "write")).toThrow();
    expect(() => policy.authorize("Secret/A.md", "read")).toThrow();
    expect(policy.mayTraverse(vault)).toBe(false);
    expect(() => new OperationAuthorization(context(), grants, "vault", resource, "obsidian_write_note", "writeNote")).toThrow();
  });

  it("requires both token and consent write scopes even when the stored grant allows writes", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const readOnlyToken = scoped(context("A", { scopes: ["vault:read"] }));
    await expect(run(readOnlyToken, "obsidian_write_note", () => readOnlyToken.writeNote("Notes/New.md", "bad"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const input = grant("A", "Notes", [...pathActions]);
    input.consentScopes = ["vault:read"];
    grants.put(input);
    const request = scoped();
    await expect(run(request, "obsidian_write_note", () => request.writeNote("Notes/New.md", "bad"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});

describe("request-scoped backend enforcement", () => {
  it("separates concurrent principal/client calls and never changes the shared backend", async () => {
    const a = scoped();
    const b = scoped(context("B"));
    await Promise.all(Array.from({ length: 20 }, async () => {
      expect((await read(a)).content).toContain("Notes/A.md");
      expect((await read(b, "Secret/A.md")).content).toContain("Secret/A.md");
      await expect(read(a, "Secret/A.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(run(a, "obsidian_write_note", () => a.writeNote("Notes/New.md", "forbidden"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }));
    expect((await backend.readNote("Secret/A.md")).content).toContain("Secret/A.md");
    await expect(fs.stat(path.join(vault, "Notes/New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  const deniedMethods = {
    initialize: (b: VaultBackend) => b.initialize(),
    close: (b: VaultBackend) => b.close(),
    status: (b: VaultBackend) => b.status(),
    health: (b: VaultBackend) => b.health(),
    listFiles: (b: VaultBackend) => b.listFiles("Secret"),
    statPath: (b: VaultBackend) => b.statPath("Secret/A.md"),
    readNote: (b: VaultBackend) => b.readNote("Secret/A.md"),
    readNoteMetadata: (b: VaultBackend) => b.readNoteMetadata("Secret/A.md"),
    writeNote: (b: VaultBackend) => b.writeNote("Notes/New.md", "bad"),
    writeFile: (b: VaultBackend) => b.writeFile("Notes/Bad.canvas", "{}"),
    preflightWriteNotes: (b: VaultBackend) => b.preflightWriteNotes!(["Notes/Bad.md"]),
    appendToNote: (b: VaultBackend) => b.appendToNote("Notes/A.md", "bad", "revision"),
    deletePath: (b: VaultBackend) => b.deletePath("Notes/A.md", { expectedRevision: "revision" }),
    createFolder: (b: VaultBackend) => b.createFolder("Notes/New"),
    movePath: (b: VaultBackend) => b.movePath("Notes/A.md", "Secret/A.md"),
    applyNoteEdits: (b: VaultBackend) => b.applyNoteEdits("Notes/A.md", "revision", { frontmatter: [], sections: [] }),
    patchHeading: (b: VaultBackend) => b.patchHeading("Notes/A.md", "Heading", "bad", "append"),
    patchFrontmatter: (b: VaultBackend) => b.patchFrontmatter("Notes/A.md", "a", "b", "replace", true),
    search: (b: VaultBackend) => b.search({ folder: "Secret", limit: 10 }),
    rebuildSearchIndex: (b: VaultBackend) => b.rebuildSearchIndex(),
    getActiveFile: (b: VaultBackend) => b.getActiveFile!(),
    openFile: (b: VaultBackend) => b.openFile!("Notes/A.md"),
  } satisfies Record<Exclude<keyof VaultBackend, "capabilities" | "requestScoped" | "runWithTool">, (b: VaultBackend) => Promise<unknown>>;

  it.each(Object.entries(deniedMethods))("explicitly denies backend method %s without leaking path/body/revision", async (_method, execute) => {
    const request = scoped();
    const result = run<unknown>(request, "obsidian_read_note", () => execute(request));
    await expect(result).rejects.toMatchObject({ code: "ACCESS_DENIED", message: "Request authorization denied.", details: undefined });
    expect(JSON.stringify(await fs.readdir(path.join(vault, "Notes")))).not.toContain("New");
  });

  it.each(Object.entries(deniedMethods))("rejects scoped Local REST before method %s can contact a remote adapter", (_method, _execute) => {
    void _execute;
    const rest = new LocalRestBackend(makeConfig({ backend: "local-rest", obsidianApiKey: "synthetic-secret", obsidianBaseUrl: "http://127.0.0.1:1" }));
    expect(() => scoped(context(), rest)).toThrow("Request authorization denied.");
  });

  it("applies live grant revocation to an already created facade on the next operation", async () => {
    const request = scoped();
    await read(request);
    grants.revoke("grant-A");
    await expect(read(request)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(search(request)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rechecks revocation after reading bytes, before returning a body", async () => {
    const request = scoped();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("A.md")) grants.revoke("grant-A");
      return handle;
    });
    await expect(read(request)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rechecks revocation under the mutation lock and before atomic commit", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const request = scoped();
    const rename = fs.rename.bind(fs);
    const sync = fs.open.bind(fs);
    const renames = vi.spyOn(fs, "rename").mockImplementation(rename);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await sync(...args);
      if (String(args[0]).endsWith("note.tmp")) grants.revoke("grant-A");
      return handle;
    });
    await expect(run(request, "obsidian_write_note", () => request.writeNote("Notes/New.md", "bad"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(renames).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(vault, "Notes/New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks a grant revoked while a mutation waits for the shared path lock", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const request = scoped();
    const note = await read(request);
    const directory = path.join(root, "cache/locks");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, createHash("sha256").update(`${vault}:Notes/A.md`).digest("hex"));
    const release = await lockfile.lock(target, { realpath: false });
    const lock = lockfile.lock;
    let reached!: () => void;
    const attempted = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(lockfile, "lock").mockImplementation((...args) => { reached(); return lock(...args); });
    const writing = run(request, "obsidian_write_note", () => request.writeNote("Notes/A.md", "bad", { mode: "replace", expectedRevision: note.revision! }));
    await attempted;
    try { grants.revoke("grant-A"); } finally { await release(); }
    await expect(writing).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await backend.readNote("Notes/A.md")).content).toBe(note.content);
  });

  it.each(["Notes/../Secret/A.md", "../outside.md", "/Notes/A.md", "Notes/.env", "Notes/.git/config", "NotesExtra/A.md"])("denies traversal, protected metadata and sibling prefixes: %s", async (target) => {
    await expect(read(scoped(), target)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rejects in-vault and external directory aliases for reads and writes", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    await fs.symlink(path.join(vault, "Secret"), path.join(vault, "Notes/Alias"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(root, path.join(vault, "Notes/External"), process.platform === "win32" ? "junction" : "dir");
    const request = scoped();
    await expect(read(request, "Notes/Alias/A.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(run(request, "obsidian_write_note", () => request.writeNote("Notes/Alias/New.md", "bad"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(read(request, "Notes/External/outside.md")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("does not return bytes after a parent is replaced with a denied symlink between authorization and open", async () => {
    const request = scoped();
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!swapped && String(args[0]) === path.join(vault, "Notes/A.md")) {
        swapped = true;
        await fs.rename(path.join(vault, "Notes"), path.join(vault, "OldNotes"));
        await fs.symlink(path.join(vault, "Secret"), path.join(vault, "Notes"), process.platform === "win32" ? "junction" : "dir");
      }
      return open(...args);
    });
    await expect(read(request)).rejects.toMatchObject({ code: "ACCESS_DENIED", details: undefined });
    expect(swapped).toBe(true);
  });

  it("intersects scoped rights with a canonical target rechecked after global resolution", async () => {
    const realpath = fs.realpath.bind(fs);
    let resolutions = 0;
    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      if (String(input) === path.join(vault, "Notes/A.md") && ++resolutions > 1) return path.join(vault, "Secret/A.md");
      return realpath(input);
    });
    await expect(read(scoped())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(resolutions).toBeGreaterThan(1);
  });

  it("checks both endpoints before moving or overwriting and preserves bytes", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const request = scoped();
    const note = await read(request);
    await expect(run(request, "obsidian_move_path", () => request.movePath("Notes/A.md", "Secret/Replaced.md", { expectedRevision: note.revision! }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(run(request, "obsidian_move_path", () => request.movePath("Secret/A.md", "Notes/Replaced.md", { overwrite: true }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await read(request)).content).toBe(note.content);
    await expect(fs.stat(path.join(vault, "Notes/Replaced.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("filters symlink aliases out of listings and checks protected descendants before recursive mutations", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    await fs.mkdir(path.join(vault, "Notes/Folder/.git"), { recursive: true });
    await fs.writeFile(path.join(vault, "Notes/Folder/.git/config"), "protected");
    await fs.symlink(path.join(vault, "Secret"), path.join(vault, "Notes/Alias"), process.platform === "win32" ? "junction" : "dir");
    const request = scoped();
    const listing = await run(request, "obsidian_list_files", () => request.listFiles("Notes"));
    expect(listing.entries.map((entry) => entry.path)).not.toContain("Notes/Alias");
    await expect(run(request, "obsidian_delete_path", () => request.deletePath("Notes/Folder", { recursive: true }))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(run(request, "obsidian_move_path", () => request.movePath("Notes/Folder", "Notes/Moved"))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await fs.readFile(path.join(vault, "Notes/Folder/.git/config"), "utf8")).toBe("protected");
  });

  it("preserves revision conflicts and successful scoped writes, patches, folder moves and deletes", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const request = scoped();
    const note = await read(request);
    await expect(run(request, "obsidian_append_to_note", () => request.appendToNote("Notes/A.md", "bad", "stale"))).rejects.toMatchObject({ code: "CONFLICT" });
    await run(request, "obsidian_append_to_note", () => request.appendToNote("Notes/A.md", "\nallowed", note.revision));
    expect((await read(request)).content).toContain("allowed");
    await run(request, "obsidian_create_folder", () => request.createFolder("Notes/Folder"));
    await run(request, "obsidian_write_note", () => request.writeNote("Notes/Folder/New.md", "# safe"));
    await run(request, "obsidian_move_path", () => request.movePath("Notes/Folder", "Notes/Moved"));
    expect((await read(request, "Notes/Moved/New.md")).content).toContain("safe");
    await run(request, "obsidian_delete_path", () => request.deletePath("Notes/Moved", { recursive: true }));
    await expect(fs.stat(path.join(vault, "Notes/Moved"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("intersects global read scope and read-only mode rather than replacing them", async () => {
    const restricted = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: path.join(root, "restricted-cache"), readPaths: ["Secret"], readOnly: true }));
    await restricted.initialize();
    try {
      grants.put(grant("A", "Notes", [...pathActions]));
      const request = scoped(context(), restricted);
      await expect(read(request)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(run(request, "obsidian_write_note", () => request.writeNote("Notes/New.md", "bad"))).rejects.toMatchObject({ code: "READ_ONLY" });
    } finally { await restricted.close(); }
  });

  it.each(["direct", "parent-alias"] as const)("fails closed when a shared plaintext index is inside an authorized subtree (%s)", async (mode) => {
    if (mode === "parent-alias") await fs.symlink(path.join(vault, "Notes"), path.join(root, "CacheAlias"), process.platform === "win32" ? "junction" : "dir");
    const cacheDir = mode === "direct" ? path.join(vault, "Notes/Cache") : path.join(root, "CacheAlias/Cache");
    const unsafe = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir, indexMode: "indexed" }));
    await unsafe.initialize();
    try {
      const key = createHash("sha256").update(vault).digest("hex").slice(0, 16);
      const target = `Notes/Cache/${key}/search-index.json`;
      expect(await fs.readFile(path.join(vault, target), "utf8")).toContain("Secret/A.md");
      await expect(read(scoped(context(), unsafe), target)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally { await unsafe.close(); }
  });

  it("also denies scoped views when the vault is inside the configured cache root", async () => {
    const unsafe = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: root }));
    await unsafe.initialize();
    try { await expect(read(scoped(context(), unsafe))).rejects.toMatchObject({ code: "ACCESS_DENIED" }); }
    finally { await unsafe.close(); }
  });

  it("emits only action/outcome audit data even on denial", async () => {
    const events: unknown[] = [];
    const request = createRequestBackend(backend, { context: context(), grants, vaultId: "vault", resource, audit: (event) => { events.push(event); } });
    await read(request);
    await expect(read(request, "Secret/A.md")).rejects.toThrow();
    expect(events).toEqual([{ action: "readNote", allowed: true }, { action: "readNote", allowed: false }]);
    expect(JSON.stringify(events)).not.toMatch(/Secret|principal|grant|token|body/u);
  });
});

describe.each(["scan", "indexed"] as const)("private search projections in %s mode", (indexMode) => {
  beforeEach(async () => {
    await backend.close();
    backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: path.join(root, "cache"), indexMode }));
    await backend.initialize();
  });

  it("filters before snippets, ranks and pagination; parallel clients do not prune each other's cache", async () => {
    const a = scoped();
    const b = scoped(context("B"));
    const [first, secret] = await Promise.all([search(a), search(b)]);
    expect(first.results.map((item) => item.path)).toEqual(["Notes/A.md"]);
    expect(first.nextCursor).toBeDefined();
    expect(secret.results.map((item) => item.path)).toEqual(["Secret/A.md"]);
    expect(secret.nextCursor).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(/Secret|NotesExtra/u);
    expect((await search(a, first.nextCursor)).results.map((item) => item.path)).toEqual(["Notes/B.md"]);
    expect((await search(b)).results.map((item) => item.path)).toEqual(["Secret/A.md"]);
    expect((await backend.search({ query: "sharedmarker", limit: 20 })).results).toHaveLength(4);
    expect((await run(a, "obsidian_search_content_advanced", () => a.search({ regex: "Secret|NotesExtra", limit: 10 }))).results).toEqual([]);
  });

  it("rejects cross-client/tool/query, legacy and tampered cursors; supports a new request for the same consent", async () => {
    const a = scoped();
    const first = await search(a);
    const cursor = first.nextCursor!;
    await expect(search(scoped(context("B")), cursor)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(run(a, "obsidian_search_content_advanced", () => a.search({ query: "sharedmarker", sort: "path", limit: 1, cursor }))).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(run(a, "obsidian_search", () => a.search({ query: "different", sort: "path", limit: 1, cursor }))).rejects.toMatchObject({ code: "INVALID_QUERY" });
    for (const invalid of [`${cursor}tampered`, Buffer.from('{"offset":1}').toString("base64url"), "invalid"]) {
      await expect(search(a, invalid)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
    expect((await search(scoped(context("A", { requestId: "request-2" })), cursor)).results[0]?.path).toBe("Notes/B.md");
    grants.put(grant());
    await expect(search(scoped(), cursor)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("rejects a grant revoked while evaluating an asynchronous search projection", async () => {
    const a = scoped();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      if (String(args[0]).endsWith("Notes/A.md")) grants.revoke("grant-A");
      return stat;
    });
    await expect(search(a)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});

describe("grant storage persistence and invalidation", () => {
  it("persists grants and revocation in isolated versioned tables outside the vault", async () => {
    const directory = path.join(root, "identity");
    let storage = await openAuthStorage(directory, vault);
    let store = new SqliteGrantStore(storage.database);
    store.put(grant());
    expect(store.get("grant-A")).toMatchObject({ revision: 1, revoked: false });
    store.revoke("grant-A");
    await storage.close();
    storage = await openAuthStorage(directory, vault);
    try {
      store = new SqliteGrantStore(storage.database);
      expect(store.get("grant-A")).toMatchObject({ revision: 2, revoked: true });
      store.put(grant());
      expect(store.get("grant-A")).toMatchObject({ revision: 3, revoked: false });
      const tables = storage.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      expect(tables.sort()).toEqual(["vaultbridge_authz_migration", "vaultbridge_vault_grant"]);
      storage.database.exec("UPDATE vaultbridge_vault_grant SET document='invalid-json'");
      expect(store.get("grant-A")).toBeUndefined();
    } finally { await storage.close(); }
  });

  it("fails closed on unknown schema and never clears a grant on idempotent migration", () => {
    new SqliteGrantStore(db);
    expect(grants.get("grant-A")).toBeDefined();
    db.exec("INSERT INTO vaultbridge_authz_migration VALUES (2)");
    expect(() => new SqliteGrantStore(db)).toThrow("newer than this binary");
  });
});

describe("MCP tool family integration", () => {
  it("does not derive identities from spoofed HTTP headers or log caller credentials in the test-injected facade", async () => {
    const request = scoped();
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    // Existing application factory injection is test-only here. Production HTTP
    // still has no OAuth verifier, context issuer or request-identity bridge.
    const service = await startHttpServer(makeConfig({ vaultPath: vault, mcpHttpPort: 0 }), {
      createApplication: () => Promise.resolve({ backend: request, close: () => Promise.resolve() }),
    });
    const address = service.address();
    if (!address || typeof address === "string") throw new Error("Expected disposable listener");
    const client = new Client({ name: "header-spoof", version: "1" });
    try {
      const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: {
        "user-agent": "credential-not-to-log", authorization: "Bearer credential-not-to-log",
        "x-principal-id": "user-B", "x-client-id": "B", "x-vault-id": "other-vault", "x-scopes": "vault:write",
      } } }));
      expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
      const denied = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Secret/A.md" } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("Secret");
      expect(logs.join("\n")).toContain("caller=scoped");
      expect(logs.join("\n")).not.toMatch(/credential-not-to-log|user-B|other-vault|Secret|Bearer/u);
      expect((await fetch(new URL("/oauth2/authorize", url))).status).toBe(404);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("denies all registered tool families with a revoked grant, including no-op rename", async () => {
    const request = scoped();
    const server = createMcpServer(request);
    const client = new Client({ name: "revoked-tools", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    grants.revoke("grant-A");
    const note = { path: "Notes/A.md", expected_revision: "revision" };
    const canvas = { path: "Notes/Board.canvas", expected_revision: "revision" };
    const calls: Record<string, Record<string, unknown>> = {
      obsidian_list_files: { path: "Notes" },
      obsidian_read_note: note,
      obsidian_read_note_section: { ...note, heading: "Heading" },
      obsidian_read_note_metadata: note,
      obsidian_read_canvas: canvas,
      obsidian_write_note: { path: "Notes/New.md", content: "bad" },
      obsidian_write_notes_bulk: { files: [{ path: "Notes/New.md", content: "bad" }] },
      obsidian_create_canvas: { path: "Notes/New.canvas" },
      obsidian_update_canvas: { ...canvas, nodes: [] },
      obsidian_delete_canvas: canvas,
      obsidian_append_to_note: { ...note, content: "bad" },
      obsidian_apply_note_edits: { ...note, section_edits: [{ heading: "Heading", content: "bad" }] },
      obsidian_patch_heading: { ...note, heading: "Heading", content: "bad" },
      obsidian_patch_frontmatter: { ...note, field: "kind", value: "bad" },
      obsidian_search: { query: "sharedmarker" },
      obsidian_search_content_advanced: { regex: "sharedmarker" },
      obsidian_add_canvas_node: { ...canvas, node: { type: "text", id: "n", text: "bad", x: 0, y: 0, width: 100, height: 100 } },
      obsidian_update_canvas_node: { ...canvas, node_id: "n", updates: { text: "bad" } },
      obsidian_remove_canvas_node: { ...canvas, node_id: "n" },
      obsidian_add_canvas_edge: { ...canvas, edge: { id: "e", fromNode: "n1", toNode: "n2" } },
      obsidian_update_canvas_edge: { ...canvas, edge_id: "e", updates: { label: "bad" } },
      obsidian_remove_canvas_edge: { ...canvas, edge_id: "e" },
      obsidian_move_path: { source_path: "Notes/A.md", destination_path: "Notes/Moved.md", expected_revision: "revision" },
      obsidian_rename_path: { ...note, new_name: "A.md" },
      obsidian_delete_path: note,
      obsidian_stat_path: note,
      obsidian_tree: { path: "Notes" },
      obsidian_create_folder: { path: "Notes/New" },
      obsidian_backend_status: {},
      obsidian_vault_health: {},
      obsidian_rebuild_search_index: {},
      obsidian_get_active_file: {},
      obsidian_open_file: note,
    };
    expect(Object.keys(calls).sort()).toEqual([...tools].sort());
    try {
      for (const [name, args] of Object.entries(calls)) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        expect(JSON.stringify(result), name).toContain("ACCESS_DENIED: Request authorization denied.");
      }
    } finally { await client.close(); await server.close(); }
  });

  it("preflights every bulk destination before the first write and guards Canvas writes with revisions", async () => {
    grants.put(grant("A", "Notes", [...pathActions]));
    const request = scoped();
    const server = createMcpServer(request);
    const client = new Client({ name: "scoped-writes", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const bulk = await client.callTool({ name: "obsidian_write_notes_bulk", arguments: { files: [
        { path: "Notes/NotWritten.md", content: "safe" }, { path: "Secret/Denied.md", content: "bad" },
      ] } });
      expect(bulk.isError).toBe(true);
      await expect(fs.stat(path.join(vault, "Notes/NotWritten.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await client.callTool({ name: "obsidian_rename_path", arguments: { path: "Secret/A.md", new_name: "A.md" } })).isError).toBe(true);
      const note = await read(request);
      expect((await client.callTool({ name: "obsidian_rename_path", arguments: { path: "Notes/A.md", new_name: "A.md", expected_revision: note.revision } })).isError).not.toBe(true);
      const canvas = await backend.readNote("Notes/Board.canvas");
      const node = { id: "n", type: "text", text: "safe", x: 0, y: 0, width: 100, height: 100 };
      const args = { path: "Notes/Board.canvas", expected_revision: canvas.revision, node };
      expect((await client.callTool({ name: "obsidian_add_canvas_node", arguments: args })).isError).not.toBe(true);
      expect((await client.callTool({ name: "obsidian_add_canvas_node", arguments: { ...args, node: { ...node, id: "other" } } })).isError).toBe(true);
      expect((await backend.readNote("Notes/Board.canvas")).content).toContain('"safe"');
    } finally { await client.close(); await server.close(); }
  });

  it("binds exact tool identity and guards Canvas, bulk, tree, metadata and privileged calls", async () => {
    const request = scoped();
    const server = createMcpServer(request);
    const client = new Client({ name: "scoped-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const registered = await client.listTools();
      expect(registered.tools.map((tool) => tool.name).sort()).toEqual([...tools].sort());
      expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
      expect((await client.callTool({ name: "obsidian_read_canvas", arguments: { path: "Notes/Board.canvas" } })).isError).not.toBe(true);
      for (const call of [
        { name: "obsidian_write_notes_bulk", arguments: { files: [{ path: "Notes/Bad.md", content: "credential-not-to-log" }] } },
        { name: "obsidian_add_canvas_node", arguments: { path: "Notes/Board.canvas", expected_revision: "revision", node: { id: "n", type: "text", text: "bad", x: 0, y: 0, width: 100, height: 100 } } },
        { name: "obsidian_read_note_metadata", arguments: { path: "Secret/A.md" } },
        { name: "obsidian_tree", arguments: { path: "Secret" } },
        { name: "obsidian_backend_status", arguments: {} },
        { name: "obsidian_vault_health", arguments: {} },
        { name: "obsidian_rebuild_search_index", arguments: {} },
        { name: "obsidian_get_active_file", arguments: {} },
        { name: "obsidian_open_file", arguments: { path: "Notes/A.md" } },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError, call.name).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/Secret|credential-not-to-log|actualRevision/u);
      }
      expect(logs.join("\n")).not.toMatch(/Secret|credential-not-to-log|user-A|grant-A|body/u);
      const narrowed = grant();
      narrowed.clientPermissions[0]!.tools = ["obsidian_read_note"];
      grants.put(narrowed);
      expect((await client.callTool({ name: "obsidian_read_canvas", arguments: { path: "Notes/Board.canvas" } })).isError).toBe(true);
      expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
