import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalRestBackend } from "../src/backend/localRest.js";
import type { VaultBackend } from "../src/backend/types.js";
import { LocalRestBackend as RestClient } from "../src/obsidian/client.js";
import { makeConfig } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); });

// Mock the HTTP client boundary: these tests never initialize a connection,
// discover an Obsidian vault, or send requests to a running REST plugin.
describe("OBS-001 Local REST adapter boundary", () => {
  const config = makeConfig({ backend: "local-rest", readOnly: true, readPaths: ["Allowed"], writePaths: ["Allowed"], obsidianApiKey: "synthetic-test-key", obsidianBaseUrl: "https://obs-001.invalid:1" });
  const calls: Array<["writeNote" | "appendToNote" | "patchHeading" | "patchFrontmatter", (backend: VaultBackend) => Promise<unknown>, unknown[]]> = [
    ["writeNote", (backend) => backend.writeNote("Note.md", "bad", { mode: "replace", expectedRevision: "stale" }), ["Note.md", "bad"]],
    ["appendToNote", (backend) => backend.appendToNote("Note.md", "bad", "stale"), ["Note.md", "bad"]],
    ["patchHeading", (backend) => backend.patchHeading("Note.md", "H", "bad", "replace", { expectedRevision: "stale", occurrence: 2 }), ["Note.md", "H", "bad", "replace"]],
    ["patchFrontmatter", (backend) => backend.patchFrontmatter("Note.md", "status", "bad", "replace", true, "stale"), ["Note.md", "status", "bad", "replace", true]],
  ];
  it.each(calls)("KNOWN K06: %s forwards mutation despite readOnly/scope/stale revision options", async (method, call, args) => {
    const forwarded = vi.spyOn(RestClient.prototype, method).mockResolvedValue({ path: "Note.md", message: "mock mutation forwarded", heading: "H", field: "status", operation: "replace" });
    const backend = new LocalRestBackend(config);
    await call(backend);
    expect(forwarded).toHaveBeenCalledExactlyOnceWith(...args);
    // In particular, neither revision nor occurrence is forwarded.
  });

  it("KNOWN K06: status reports writable even when configured read-only", async () => {
    const backend = new LocalRestBackend(config);
    expect((await backend.status()).readOnly).toBe(false);
  });
});
