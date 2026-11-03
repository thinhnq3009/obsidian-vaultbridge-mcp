import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openAuthStorage } from "../src/auth/storage.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("owner storage directory identity", () => {
  it.each(["replacement", "permissions"])("rejects %s while waiting for the directory lock before writing credentials", async (change) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-directory-"));
    roots.push(root);
    const directory = path.join(root, "identity");
    const vault = path.join(root, "vault");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(vault);
    const original = lockfile.lock;
    vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      const release = await original(file, options);
      if (change === "replacement") {
        fs.renameSync(directory, `${directory}.saved`);
        fs.mkdirSync(directory, { mode: 0o700 });
      } else if (process.platform !== "win32") {
        fs.chmodSync(directory, 0o755);
      } else {
        fs.renameSync(directory, `${directory}.saved`);
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      return release;
    });
    // Close a mistakenly accepted store as well, so the red run cannot leak it.
    const attempt = openAuthStorage(directory, vault).then(async (store) => {
      await store.close();
      return "accepted";
    });
    await expect(attempt).rejects.toThrow(/directory/u);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.existsSync(`${directory}.lock`)).toBe(false);
  });
});
