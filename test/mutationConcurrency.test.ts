import fs from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesystemVaultBackend } from "../src/backend/filesystem.js";
import { createRegressionFixture, type RegressionFixture } from "./regressionFixtures.js";

let fixture: RegressionFixture;
beforeEach(async () => { fixture = await createRegressionFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause just the move syscall; release after a peer commits or contends on its lock. */
async function raceMove(source: string | undefined, destination: string, move: () => Promise<unknown>, peer: () => Promise<unknown>) {
  const paused = signal();
  const resume = signal();
  const contended = signal();
  const rename = fs.rename;
  const lock = lockfile.lock;
  let heldTarget: string | undefined;
  let competing = false;
  let intercepted = false;
  vi.spyOn(lockfile, "lock").mockImplementation((...args) => {
    if (!competing) heldTarget ??= args[0];
    else if (args[0] === heldTarget) contended.resolve();
    return lock(...args);
  });
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (!intercepted && (source === undefined || from === path.join(fixture.vault, source)) && to === path.join(fixture.vault, destination)) {
      intercepted = true;
      paused.resolve();
      await resume.promise;
    }
    await rename(from, to);
  });
  const moving = move();
  // Attach rejection handlers immediately, including if setup unexpectedly fails.
  const moved = Promise.allSettled([moving]);
  try {
    await paused.promise;
    competing = true;
    const concurrent = Promise.allSettled([peer()]);
    await Promise.race([concurrent, contended.promise]);
    resume.resolve();
    return [(await moved)[0], (await concurrent)[0]];
  } finally {
    resume.resolve();
    await moved;
  }
}

describe("conflicting filesystem mutations", () => {
  it("does not overwrite a concurrent successful create when overwrite=false", async () => {
    const source = await fixture.backend.writeNote("source.md", "source");
    const results = await raceMove("source.md", "destination.md",
      () => fixture.backend.movePath("source.md", "destination.md", { expectedRevision: source.revision }),
      () => fixture.backend.writeNote("destination.md", "concurrent"));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "ALREADY_EXISTS" } }]);
  });

  it.each(["source", "destination"])("does not accept stale %s content during an overwrite move", async (target) => {
    const source = await fixture.backend.writeNote("source.md", "source");
    const destination = await fixture.backend.writeNote("destination.md", "destination");
    const results = await raceMove("source.md", "destination.md",
      () => fixture.backend.movePath("source.md", "destination.md", {
        overwrite: true, expectedRevision: source.revision, expectedDestinationRevision: destination.revision,
      }),
      () => fixture.backend.writeNote(`${target}.md`, "updated", {
        mode: "replace", expectedRevision: target === "source" ? source.revision : destination.revision,
      }));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[1]?.status).toBe("rejected");
    expect((await fixture.backend.readNote("destination.md")).content).toBe("source");
  });

  it("serializes two independent backends moving to the same destination", async () => {
    const source = await fixture.backend.writeNote("source.md", "source");
    const otherSource = await fixture.backend.writeNote("other.md", "other");
    const other = new FilesystemVaultBackend(fixture.config);
    await other.initialize();
    try {
      const results = await raceMove("source.md", "destination.md",
        () => fixture.backend.movePath("source.md", "destination.md", { expectedRevision: source.revision }),
        () => other.movePath("other.md", "destination.md", { expectedRevision: otherSource.revision }));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "ALREADY_EXISTS" } }]);
    } finally { await other.close(); }
  });

  it("serializes a directory move with writes to its descendants", async () => {
    const child = await fixture.backend.writeNote("folder/child.md", "child");
    const results = await raceMove("folder", "archive",
      () => fixture.backend.movePath("folder", "archive"),
      () => fixture.backend.writeNote("folder/child.md", "updated", { mode: "replace", expectedRevision: child.revision }));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await fixture.backend.readNote("archive/child.md")).content).toBe("child");
  });

  it.each(["source", "destination"])("rechecks a queued move after the %s writer commits first", async (target) => {
    const source = await fixture.backend.writeNote("source.md", "source");
    const destination = await fixture.backend.writeNote("destination.md", "destination");
    const results = await raceMove(undefined, `${target}.md`,
      () => fixture.backend.writeNote(`${target}.md`, "updated", {
        mode: "replace", expectedRevision: target === "source" ? source.revision : destination.revision,
      }),
      () => fixture.backend.movePath("source.md", "destination.md", {
        overwrite: true, expectedRevision: source.revision, expectedDestinationRevision: destination.revision,
      }));
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect((await fixture.backend.readNote(`${target}.md`)).content).toBe("updated");
  });

  it.skipIf(process.platform === "win32")("serializes writes through an in-vault directory alias", async () => {
    const source = await fixture.backend.writeNote("source.md", "source");
    await fs.mkdir(path.join(fixture.vault, "folder"));
    await fs.symlink(path.join(fixture.vault, "folder"), path.join(fixture.vault, "alias"), "dir");
    const results = await raceMove("source.md", "folder/destination.md",
      () => fixture.backend.movePath("source.md", "folder/destination.md", { expectedRevision: source.revision }),
      () => fixture.backend.writeNote("alias/destination.md", "concurrent"));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "ALREADY_EXISTS" } });
  });
});
