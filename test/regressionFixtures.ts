import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import type { AppConfig } from "../src/types.js";
import { makeConfig } from "./helpers.js";

// Synthetic data only. Generate special bytes explicitly so Git/editor newline
// conversion cannot silently remove the BOM/CRLF regression inputs.
export const regressionNotes = {
  "Comments.md": "---\n# workflow comment\nstatus: open # keep status comment\nowner: 'Nguyễn'\nnested:\n  count: 3 # keep nested comment\ntags: [project/test, tiếng-việt]\n---\n# Kế hoạch 🚀\nBody stays byte-for-byte.\n",
  "BOM-CRLF.md": "\uFEFF---\r\nstatus: open # keep\r\nowner: Nguyễn\r\n---\r\n# Ghi chú 🚀\r\nFirst\r\n## Target\r\nOld\r\n## Tail\r\nUntouched\r\n",
  "Unicode.md": "# Tiếng Việt 🚀\nCafé / Cafe\u0301 / 日本語. #tiếng-việt\n",
  "Syntax.md": "---\ntags: [project/test]\n---\n# Real\nIssues #123 and #6120 and tag #release/v1.\nSee [[Notes/Target#Part|alias]] and [site](https://example.com).\n`#inline [[InlineFake]]`\n```md\n# Fake\n#fenced [[FenceFake]]\n```\n~~~md\n# TildeFake\n#tilde [[TildeFake]]\n~~~\n",
  "Duplicate.md": "# Same\nFirst\n## Child\nKeep child\n# Same\nSecond\n# Tail\nKeep tail\n",
  "Long.md": `# Long\n${"Long synthetic line tiếng Việt 🚀.\n".repeat(4096)}# End\nSentinel\n`,
  "Invalid.md": "---\nbroken: [\n---\n# Broken\nBody must survive errors.\n",
} satisfies Record<string, string>;

export type RegressionFixture = Awaited<ReturnType<typeof createRegressionFixture>>;

export async function createRegressionFixture(overrides: Partial<AppConfig> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "obs-001-")));
  const vault = path.join(root, "vault");
  const cache = path.join(root, "cache");
  const outside = path.join(root, "outside");
  await fs.mkdir(vault);
  await fs.mkdir(outside);
  for (const [name, content] of Object.entries(regressionNotes)) {
    await fs.writeFile(path.join(vault, name), content, "utf8");
  }
  const config = makeConfig({ ...overrides, vaultPath: vault, cacheDir: cache, indexMode: "scan", watchMode: "off" });
  const backend = new FilesystemVaultBackend(config);
  try {
    await backend.initialize();
  } catch (error) {
    await backend.close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root, vault, outside, config, backend,
    bytes: (name: string) => fs.readFile(path.join(vault, name)),
    async close() {
      try { await backend.close(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  };
}

export function revisionOf(bytes: string | Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
