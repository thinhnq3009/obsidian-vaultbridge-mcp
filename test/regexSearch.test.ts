import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import * as regexMatcher from "../src/backend/regex.js";
import { createMcpServer } from "../src/server.js";
import { VaultError } from "../src/types.js";
import { makeConfig } from "./helpers.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-regex-"));
  const vault = path.join(root, "vault");
  const cache = path.join(root, "cache");
  await fs.mkdir(vault);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { vault, cache };
}

async function setup(indexMode: "scan" | "indexed" = "scan") {
  const { vault, cache } = await fixture();
  const backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: cache, indexMode }));
  await backend.initialize();
  cleanups.push(() => backend.close());
  return backend;
}

describe("bounded filesystem regex search", () => {
  it.each(["(a|aa)+$", "(a|a?)+$", "a*a*a*a*b"])("terminates %s without stalling the event loop", async (regex) => {
    const { vault, cache } = await fixture();
    await fs.writeFile(path.join(vault, "Adversarial.md"), `${"a".repeat(32_768)}!`);
    const { stdout } = await run(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./fixtures/regexSearchProbe.ts", import.meta.url)), vault, cache, regex,
    ], { timeout: 6000, killSignal: "SIGKILL" });
    const result = JSON.parse(stdout) as { code: string; recovered: boolean; ticks: number; maxGap: number; elapsedMs: number };
    expect(result.code).toBe("INVALID_QUERY");
    expect(result.recovered).toBe(true);
    expect(result.ticks).toBeGreaterThan(5);
    expect(result.maxGap).toBeLessThan(500);
    expect(result.elapsedMs).toBeLessThan(4000);
  }, 10_000);

  it.each(["[", "(", "a{2,1}", "x".repeat(257), "(a+)+$", "(a)\\1", "(?<=a)b", "(?<name>a)"])("reports INVALID_QUERY for %s even in an empty vault", async (regex) => {
    const backend = await setup();
    await expect(backend.search({ regex, limit: 10 })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect((await backend.search({ limit: 10 })).results).toEqual([]);
  });

  it.each(["scan", "indexed"] as const)("preserves Unicode, case, lookahead, filters and pagination in %s mode", async (mode) => {
    const backend = await setup(mode);
    await backend.writeNote("Notes/A.md", "---\ntags: [mcp]\nstatus: active\n---\nXin chào 😀\nTODO: first");
    await backend.writeNote("Notes/B.md", "---\ntags: [mcp]\nstatus: active\n---\nxin chào 😀\nTODO: second");
    await backend.writeNote("Elsewhere/C.md", "Xin chào 😀\nTODO: excluded");
    const query = { regex: "xin chào .(?=\\nTODO)", folder: "Notes", tag: "mcp", frontmatter: { status: "active" }, sort: "path" as const, limit: 1 };
    const first = await backend.search(query);
    expect(first.results.map((item) => item.path)).toEqual(["Notes/A.md"]);
    const second = await backend.search({ ...query, cursor: first.nextCursor! });
    expect(second.results.map((item) => item.path)).toEqual(["Notes/B.md"]);
    expect(second.nextCursor).toBeUndefined();
    const sensitive = await backend.search({ ...query, caseSensitive: true });
    expect(sensitive.results.map((item) => item.path)).toEqual(["Notes/B.md"]);
    expect((await backend.search({ regex: "\\p{L}+ chào", query: "first", match: "exact", limit: 10 })).results.map((item) => item.path)).toEqual(["Notes/A.md"]);
  });

  it("rejects oversized candidate sets before executing user expressions", async () => {
    await expect(regexMatcher.matchRegex("a", false, Array<string>(10_001).fill(""))).rejects.toMatchObject({ code: "INVALID_QUERY" });
    // A multibyte input verifies that the limit counts UTF-8 bytes, not characters.
    await expect(regexMatcher.matchRegex("a", false, ["😀".repeat(4 * 1024 * 1024 + 1)])).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("supports workers when the host process uses an ESM eval entrypoint", async () => {
    const { stdout } = await run(process.execPath, [
      "--input-type=module", "--import", "tsx", "--eval",
      'const { matchRegex } = await import(process.argv[1]); console.log(JSON.stringify([...await matchRegex("hello", false, ["Hello"])]));',
      new URL("../src/backend/regex.ts", import.meta.url).href,
    ], { timeout: 6000, killSignal: "SIGKILL" });
    expect(JSON.parse(stdout)).toEqual([0]);
  });

  it.each(["scan", "indexed"] as const)("rechecks revoked path access after a worker finishes in %s mode", async (mode) => {
    const { vault, cache } = await fixture();
    const backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: cache, indexMode: mode }));
    await backend.initialize();
    cleanups.push(() => backend.close());
    const target = path.join(vault, "Revoked.md");
    await backend.writeNote("Revoked.md", "private-marker");
    const match = regexMatcher.matchRegex;
    vi.spyOn(regexMatcher, "matchRegex").mockImplementationOnce(async (...args) => {
      const matches = await match(...args);
      // Simulate revocation during the asynchronous worker boundary.
      await fs.rm(target);
      return matches;
    });
    expect((await backend.search({ regex: "private-marker", limit: 10 })).results).toEqual([]);
    expect((await backend.search({ query: "private-marker", limit: 10 })).results).toEqual([]);
  });

  for (const mode of ["scan", "indexed"] as const) {
    for (const revocation of ["delete", "symlink"] as const) {
      it.each(["timeout", "worker failure"])(`${mode}: reauthorizes the batch after %s and ${revocation}`, async (failure) => {
        const { vault, cache } = await fixture();
        const backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: cache, indexMode: mode }));
        await backend.initialize();
        cleanups.push(() => backend.close());
        await backend.writeNote("Public/Revoked.md", "private-marker");
        await backend.writeNote("Healthy.md", "healthy-marker");
        const workerError = new VaultError(`Simulated regex ${failure}`, { code: "INVALID_QUERY" });
        vi.spyOn(regexMatcher, "matchRegex").mockImplementationOnce(async () => {
          // Revoke only after the batch's initial authorization pass, while the
          // asynchronous regex request holds the queue against watcher updates.
          if (revocation === "delete") {
            await fs.rm(path.join(vault, "Public/Revoked.md"));
          } else {
            const outside = path.join(path.dirname(vault), "outside");
            await fs.mkdir(outside);
            await fs.writeFile(path.join(outside, "Revoked.md"), "outside-marker");
            await fs.rename(path.join(vault, "Public"), path.join(vault, "Original"));
            await fs.symlink(outside, path.join(vault, "Public"), process.platform === "win32" ? "junction" : "dir");
          }
          throw workerError;
        });
        // Queue without awaiting so all three requests share the same batch.
        const [regex, revoked, healthy] = await Promise.allSettled([
          backend.search({ regex: "private-marker", limit: 10 }),
          backend.search({ query: "private-marker", limit: 10 }),
          backend.search({ query: "healthy-marker", limit: 10 }),
        ]);
        expect(regex).toMatchObject({ status: "rejected", reason: workerError });
        expect(revoked).toEqual({ status: "fulfilled", value: { results: [] } });
        expect(healthy.status).toBe("fulfilled");
        if (healthy.status === "fulfilled") expect(healthy.value.results.map((result) => result.path)).toEqual(["Healthy.md"]);
        if (mode === "indexed") {
          const [indexDirectory] = await fs.readdir(cache);
          expect(await fs.readFile(path.join(cache, indexDirectory!, "search-index.json"), "utf8")).not.toContain("private-marker");
        }
      });
    }
  }

  it("returns INVALID_QUERY through the MCP tool and keeps the connection usable", async () => {
    const backend = await setup();
    const server = createMcpServer(backend);
    const client = new Client({ name: "regex-regression", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(async () => { try { await client.close(); } finally { await server.close(); } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invalid = await client.callTool({ name: "obsidian_search_content_advanced", arguments: { regex: "[" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatchObject([{ type: "text" }]);
    expect(JSON.stringify(invalid.content)).toContain("INVALID_QUERY:");
    const valid = await client.callTool({ name: "obsidian_search_content_advanced", arguments: { regex: "hello" } });
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toMatchObject({ results: [] });
  });
});
