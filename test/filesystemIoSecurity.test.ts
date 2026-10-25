import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, revisionOf, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;

beforeEach(async () => { fixture = await createRegressionFixture({ maxFileSizeBytes: 1024 }); });
afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

// Exercise both the old pathname-stat seam and the descriptor-stat seam. The
// replacement happens after metadata is captured, before the body is read.
function afterTargetStat(target: string, action: () => Promise<void>) {
  let triggered = false;
  const run = async <T>(stat: T): Promise<T> => {
    if (!triggered) { triggered = true; await action(); }
    return stat;
  };
  const realStat = fs.stat;
  vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    const stat = await realStat(...args);
    if (args[0] === target) await run(stat);
    return stat;
  });
  const realOpen = fs.open;
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === target && args[1] !== "wx") {
      handles.push(handle);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => run(await stat()));
    }
    return handle;
  });
  return { handles, triggered: () => triggered };
}

describe("filesystem descriptor reads", () => {
  it("reads the checked file when its pathname is replaced after stat", async () => {
    const target = path.join(fixture.vault, "Race.md");
    await fs.writeFile(target, "original");
    const race = afterTargetStat(target, async () => {
      await fs.rename(target, `${target}.old`);
      await fs.writeFile(target, "replacement".repeat(200));
    });
    const note = await fixture.backend.readNote("Race.md");
    expect(race.triggered()).toBe(true);
    expect(note.content).toBe("original");
    expect(note.revision).toBe(revisionOf("original"));
    expect(race.handles).toHaveLength(1);
    expect(race.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("checks a mutation revision against the same file whose metadata was checked", async () => {
    const target = path.join(fixture.vault, "Race.md");
    await fs.writeFile(target, "original");
    const race = afterTargetStat(target, async () => {
      await fs.rename(target, `${target}.old`);
      await fs.writeFile(target, "replacement");
    });
    await expect(fixture.backend.writeNote("Race.md", "changed", {
      mode: "replace", expectedRevision: revisionOf("replacement"),
    })).rejects.toMatchObject({ code: "CONFLICT", details: { actualRevision: revisionOf("original") } });
    expect(race.triggered()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("replacement");
    expect(race.handles).toHaveLength(1);
    expect(race.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it.each(["read", "replace"] as const)("rejects a file growing beyond the byte limit during %s", async (operation) => {
    const target = path.join(fixture.vault, "Race.md");
    await fs.writeFile(target, "small");
    const race = afterTargetStat(target, () => fs.appendFile(target, "🚀".repeat(1024)));
    const result = operation === "read"
      ? fixture.backend.readNote("Race.md")
      : fixture.backend.writeNote("Race.md", "changed", { mode: "replace", expectedRevision: revisionOf("small") });
    await expect(result).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(race.triggered()).toBe(true);
    expect(race.handles).toHaveLength(1);
    expect(race.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects FIFOs without blocking on open", async () => {
    await promisify(execFile)("mkfifo", [path.join(fixture.vault, "Pipe.md")]);
    await expect(fixture.backend.readNote("Pipe.md")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(fixture.backend.writeNote("Pipe.md", "changed", { mode: "replace", expectedRevision: revisionOf("") }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("decodes multibyte characters across read chunks and accepts the exact byte limit", async () => {
    const content = `${"x".repeat(65535)}🚀`;
    const target = path.join(fixture.vault, "Boundary.md");
    await fs.writeFile(target, content);
    const backend = new FilesystemVaultBackend({ ...fixture.config, maxFileSizeBytes: Buffer.byteLength(content) });
    await backend.initialize();
    try { expect((await backend.readNote("Boundary.md")).content).toBe(content); }
    finally { await backend.close(); }
  });
});

describe("private atomic-write staging", () => {
  it.skipIf(process.platform === "win32")("keeps staging private even when replacing a shared note", async () => {
    const target = path.join(fixture.vault, "Shared.md");
    await fs.writeFile(target, "original");
    await fs.chmod(target, 0o664);
    const realOpen = fs.open;
    let observed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[1] === "wx") {
        try {
          observed = true;
          expect((await handle.stat()).mode & 0o777).toBe(0o600);
          expect((await fs.stat(path.dirname(String(args[0])))).mode & 0o777).toBe(0o700);
        } catch (error) { await handle.close(); throw error; }
      }
      return handle;
    });
    await fixture.backend.writeNote("Shared.md", "changed", { mode: "replace", expectedRevision: revisionOf("original") });
    expect(observed).toBe(true);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o664);
    expect(await fs.readFile(target, "utf8")).toBe("changed");
    expect((await fs.readdir(fixture.vault)).filter((name) => name.startsWith(".obsidian-vault-mcp-"))).toEqual([]);
  });

  it.each(["write", "sync", "rename"] as const)("removes staging and preserves the destination after a %s failure", async (operation) => {
    const target = path.join(fixture.vault, "Failure.md");
    await fs.writeFile(target, "original");
    const failure = new Error(`synthetic ${operation} failure`);
    if (operation === "rename") vi.spyOn(fs, "rename").mockRejectedValue(failure);
    else {
      const realOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[1] === "wx") vi.spyOn(handle, operation === "write" ? "writeFile" : "sync").mockRejectedValue(failure);
        return handle;
      });
    }
    await expect(fixture.backend.writeNote("Failure.md", "changed", {
      mode: "replace", expectedRevision: revisionOf("original"),
    })).rejects.toThrow(failure.message);
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect((await fs.readdir(fixture.vault)).filter((name) => name.startsWith(".obsidian-vault-mcp-"))).toEqual([]);
  });
});
