import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRestBackend } from "../src/backend/localRest.js";
import type { VaultBackend } from "../src/backend/types.js";
import { LocalRestBackend as RestClient } from "../src/obsidian/client.js";
import { makeConfig } from "./helpers.js";
afterEach(() => { vi.restoreAllMocks(); });
const config = makeConfig({ backend: "local-rest", readOnly: true, readPaths: ["Allowed"], writePaths: ["Allowed"], obsidianApiKey: "synthetic-test-key", obsidianBaseUrl: "https://sec-17.invalid:1" });
const mutations: Array<[string, (backend: VaultBackend) => Promise<unknown>]> = [
  ["writeNote", (b) => b.writeNote("Allowed/Note.md", "bad")],
  ["writeFile", (b) => b.writeFile("Allowed/Note.canvas", "bad")],
  ["appendToNote", (b) => b.appendToNote("Allowed/Note.md", "bad")],
  ["patchHeading", (b) => b.patchHeading("Allowed/Note.md", "H", "bad", "replace")],
  ["patchFrontmatter", (b) => b.patchFrontmatter("Allowed/Note.md", "status", "bad", "replace", true)],
  ["deletePath", (b) => b.deletePath("Allowed/Note.md")],
  ["createFolder", (b) => b.createFolder("Allowed/New")],
  ["movePath", (b) => b.movePath("Allowed/A.md", "Allowed/B.md")],
  ["applyNoteEdits", (b) => b.applyNoteEdits("Allowed/A.md", "rev", { frontmatter: [], sections: [] })],
];
describe("SEC-06A Local REST policy", () => {
  it.each(mutations)("denies %s in read-only mode before any network request", async (_name, call) => {
    const requests = ["writeNote", "writeFile", "appendToNote", "patchHeading", "patchFrontmatter", "deletePath", "readNote", "readNoteMetadata", "listFiles"] as const;
    const spies = requests.map((method) => vi.spyOn(RestClient.prototype, method).mockRejectedValue(new Error("must not call REST")));
    await expect(call(new LocalRestBackend(config))).rejects.toMatchObject({ code: "READ_ONLY" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it("reports read-only state truthfully", async () => { expect((await new LocalRestBackend(config).status()).readOnly).toBe(true); });
  it.each(["Private/Secret.md", "Allowed/.env", "Allowed/.git/config", "../Allowed/Note.md"])("denies read and write path %s without forwarding", async (target) => {
    const read = vi.spyOn(RestClient.prototype, "readNote");
    const write = vi.spyOn(RestClient.prototype, "writeNote");
    const backend = new LocalRestBackend({ ...config, readOnly: false });
    await expect(backend.readNote(target)).rejects.toHaveProperty("code");
    await expect(backend.writeNote(target, "bad")).rejects.toHaveProperty("code");
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("allows scoped reads and legacy writes without emulating timestamp/revision guarantees", async () => {
    const write = vi.spyOn(RestClient.prototype, "writeNote").mockResolvedValue({ path: "Allowed/Note.md", message: "forwarded" });
    const read = vi.spyOn(RestClient.prototype, "readNote").mockResolvedValue({ path: "Allowed/Note.md", content: "safe", etag: null, lastModified: null, contentType: "text/markdown" });
    const backend = new LocalRestBackend({ ...config, readOnly: false, autoAgentEditAt: true });
    await backend.writeNote("Allowed/./Note.md", "body");
    expect(write).toHaveBeenCalledExactlyOnceWith("Allowed/Note.md", "body");
    await backend.readNote("Allowed/Note.md"); expect(read).toHaveBeenCalledOnce();
    await expect(backend.writeNote("Allowed/Note.md", "body", { expectedRevision: "rev" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
  it("hides protected/out-of-scope listing entries and rejects unsupported remote search/active/move operations", async () => {
    vi.spyOn(RestClient.prototype, "listFiles").mockResolvedValue({ root: "Allowed", entries: ["Allowed/Note.md", "Allowed/.env", "Private/S.md"].map((p) => ({ path: p, name: p.split("/").at(-1)!, isFolder: false })) });
    const active = vi.spyOn(RestClient.prototype, "getActiveFile"); const search = vi.spyOn(RestClient.prototype, "search");
    const backend = new LocalRestBackend({ ...config, readOnly: false });
    expect((await backend.listFiles("Allowed")).entries.map((e) => e.path)).toEqual(["Allowed/Note.md"]);
    await expect(backend.getActiveFile()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(backend.search({ query: "secret", limit: 10 })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(backend.movePath("Allowed/A.md", "Allowed/B.md")).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(active).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });
});
