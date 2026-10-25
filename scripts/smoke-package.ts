import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Manifest = {
  name: string;
  version: string;
  bin: Record<string, string>;
  main: string;
  types: string;
  exports: { ".": { types: string; default: string } };
  repository: { url: string };
  homepage: string;
  bugs: { url: string };
  publishConfig: { tag: string };
  scripts: { test: string };
};
type PackResult = { filename: string; integrity: string; files: Array<{ path: string }> };

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run smoke:package");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-package-"));
const consumer = path.join(temporary, "consumer");
const vault = path.join(temporary, "vault");
const cache = path.join(temporary, "cache");
const canonical = "obsidian-vaultbridge-mcp";
const legacy = "obsidian-local-rest-mcp";
const repository = `https://github.com/thinhnq3009/${canonical}`;

function npm(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [npmCli!, ...args], {
    cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  await fs.mkdir(consumer);
  await fs.mkdir(vault);
  await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // An optional registry spec verifies the public artifact after an intentional publish.
  const spec = process.argv[2];
  let artifact = spec;
  if (!artifact) {
    const [pack] = JSON.parse(npm(["pack", "--json", "--pack-destination", temporary], root)) as PackResult[];
    assert(pack);
    for (const file of pack.files) {
      assert(file.path.startsWith("dist/") || ["package.json", "README.md", "MIGRATION.md", "CHANGELOG.md", "RELEASING.md", ".env.example"].includes(file.path), `Unexpected packed file: ${file.path}`);
    }
    artifact = path.join(temporary, pack.filename);
    process.stdout.write(`Packed ${pack.filename}: ${pack.integrity}\n`);
  }
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", artifact], consumer);
  npm(["ls", "--omit=dev"], consumer);
  npm(["audit", "--omit=dev", "--audit-level=high"], consumer);
  const installed = path.join(consumer, "node_modules", canonical);
  const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8")) as Manifest;
  assert.equal(manifest.name, canonical);
  // Validate the actual npm release channel without tying this smoke to alpha-only versions.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/u);
  const isAlpha = /-alpha\.\d+$/u.test(manifest.version);
  assert.equal(manifest.publishConfig.tag, isAlpha ? "alpha" : "latest");
  assert.equal(manifest.repository.url, `git+${repository}.git`);
  assert.equal(manifest.homepage, `${repository}#readme`);
  assert.equal(manifest.bugs.url, `${repository}/issues`);
  assert(manifest.scripts.test.includes("vitest"));
  assert.equal(manifest.exports["."].default, manifest.main);
  assert.equal(manifest.exports["."].types, manifest.types);
  for (const entry of [manifest.main, manifest.types, "README.md", "MIGRATION.md", "CHANGELOG.md", "RELEASING.md", ".env.example"]) {
    assert((await fs.stat(path.join(installed, entry))).isFile(), `Missing package entry: ${entry}`);
  }
  const readme = await fs.readFile(path.join(installed, "README.md"), "utf8");
  assert(readme.includes(`npx ${canonical}@${isAlpha ? "alpha" : manifest.version}`));
  assert(readme.includes(isAlpha ? "Early preview" : `v${manifest.version}`));
  for (const executable of [canonical, legacy]) {
    assert.equal(manifest.bin[executable], "./dist/index.js");
    const cli = path.join(installed, manifest.bin[executable]);
    assert((await fs.readFile(cli, "utf8")).startsWith("#!/usr/bin/env node\n"));
    if (process.platform !== "win32") assert((await fs.stat(cli)).mode & 0o111, "CLI must be executable");
    // Do not inherit real vault settings. npx runs in an independent installed consumer.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && /^(?:path|systemroot|windir|comspec|pathext|home|userprofile|tmp|temp|tmpdir)$/iu.test(key),
    )) as Record<string, string>;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(path.dirname(npmCli), "npx-cli.js"), "--offline", "--no", "--", executable,
        "--vault", vault, "--stdio", "--backend", "filesystem", "--index-mode", "scan", "--watch-mode", "off", "--cache-dir", cache],
      cwd: consumer, env: environment, stderr: "pipe",
    });
    const client = new Client({ name: "packed-tarball-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      assert.deepEqual(client.getServerVersion(), { name: manifest.name, version: manifest.version });
      const tools = await client.listTools();
      assert(tools.tools.some((tool) => tool.name === "obsidian_apply_note_edits"));
      const notePath = `${executable}.md`;
      const created = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: "# Packed smoke\n", mode: "create" } });
      assert(!created.isError, JSON.stringify(created));
      const read = await client.callTool({ name: "obsidian_read_note", arguments: { path: notePath } });
      assert(!read.isError, JSON.stringify(read));
      const note = read.structuredContent as { content: string; revision: string };
      assert(note.content.includes("# Packed smoke"));
      assert.match(note.revision, /^sha256:/u);
      const replaced = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: "# Updated package\n", mode: "replace", expected_revision: note.revision } });
      assert(!replaced.isError, JSON.stringify(replaced));
      const persisted = await fs.readFile(path.join(vault, notePath), "utf8");
      assert(persisted.includes("# Updated package"));
      const stale = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: "# Stale\n", mode: "replace", expected_revision: note.revision } });
      assert.equal(stale.isError, true);
      assert(JSON.stringify(stale).includes("CONFLICT"));
      assert.equal(await fs.readFile(path.join(vault, notePath), "utf8"), persisted);
      const metadata = await client.callTool({ name: "obsidian_read_note_metadata", arguments: { path: notePath } });
      assert(!metadata.isError, JSON.stringify(metadata));
      assert.equal((metadata.structuredContent as { headings: Array<{ text: string }> }).headings[0]?.text, "Updated package");
      const search = await client.callTool({ name: "obsidian_search", arguments: { query: "Updated package" } });
      assert(!search.isError, JSON.stringify(search));
      assert((search.structuredContent as { results: Array<{ path: string }> }).results.some(result => result.path === notePath));
      const canvasPath = `${executable}.canvas`;
      const canvas = await client.callTool({ name: "obsidian_create_canvas", arguments: { path: canvasPath } });
      assert(!canvas.isError, JSON.stringify(canvas));
      const canvasRead = await client.callTool({ name: "obsidian_read_canvas", arguments: { path: canvasPath } });
      assert(!canvasRead.isError, JSON.stringify(canvasRead));
      assert.equal((canvasRead.structuredContent as { nodeCount: number }).nodeCount, 0);
      const rootDelete = await client.callTool({ name: "obsidian_delete_path", arguments: { path: ".", recursive: true } });
      assert.equal(rootDelete.isError, true);
      assert.equal(await fs.readFile(path.join(vault, notePath), "utf8"), persisted);
      process.stdout.write(`${process.version}: npx ${executable} → ${manifest.name}@${manifest.version}, MCP round trip passed\n`);
    } finally {
      await client.close();
    }
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
