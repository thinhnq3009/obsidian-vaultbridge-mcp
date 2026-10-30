import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { createTempVault } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => { for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true }); });

describe("standalone STDIO server", () => {
  it.each(["20.20.0", "22.23.3", "24.22.0", "26.12.1"])("refuses unsupported Node %s before reading configuration or opening a vault", (version) => {
    // Simulate runtime metadata in a disposable child; never run a decoder payload.
    const preload = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)}})`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, "src/index.ts", "--invalid-config-option"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unsupported Node.js ${version}`);
    expect(result.stderr).not.toContain("Unknown argument");
  });

  it("starts without Obsidian and performs revision-safe note operations", async () => {
    const vault = await createTempVault(); cleanup.push(vault);
    const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, "src/index.ts", "--stdio", "--vault", vault, "--watch-mode", "off", "--index-mode", "scan"],
      env: { ...process.env, VAULT_PATH: vault },
      stderr: "pipe",
    });
    const client = new Client({ name: "standalone-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      const created = await client.callTool({ name: "obsidian_write_note", arguments: { path: "E2E.md", content: "# E2E\n", mode: "create" } });
      expect(created.isError).not.toBe(true);
      const read = await client.callTool({ name: "obsidian_read_note", arguments: { path: "E2E.md" } });
      const structured = read.structuredContent as { revision?: string; content?: string };
      expect(structured.content).toContain("# E2E");
      expect(structured.revision).toMatch(/^sha256:/u);
      const replaced = await client.callTool({ name: "obsidian_write_note", arguments: { path: "E2E.md", content: "# Updated\n", mode: "replace", expected_revision: structured.revision } });
      expect(replaced.isError).not.toBe(true);
      const reread = await client.callTool({ name: "obsidian_read_note", arguments: { path: "E2E.md" } });
      const updated = reread.structuredContent as { revision?: string };
      const overwrite = await client.callTool({ name: "obsidian_write_note", arguments: { path: "E2E.md", content: "# Overwrite alias\n", overwrite: true, expected_revision: updated.revision } });
      expect(overwrite.isError).not.toBe(true);
      const bulk = await client.callTool({
        name: "obsidian_write_notes_bulk",
        arguments: {
          files: [
            { path: "Bulk/One.md", content: "# One\n" },
            { path: "Bulk/Two.md", content: "# Two\n" },
          ],
        },
      });
      expect(bulk.isError).not.toBe(true);
      expect((bulk.structuredContent as { count?: number }).count).toBe(2);
    } finally {
      await client.close();
    }
  }, 20_000);
});
