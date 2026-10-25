import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { assertSupportedNode, supportedNodeRange } from "../src/runtime.js";
describe("SEC-09 runtime policy", () => {
  it("keeps the published and locked runtime requirements aligned with startup enforcement", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { engines: { node: string } }> };
    expect(manifest.engines.node).toBe(supportedNodeRange);
    expect(lock.packages[""]?.engines.node).toBe(supportedNodeRange);
  });
  it.each(["22.23.4", "22.24.0", "24.22.1", "24.23.0"])("supports patched Node %s", (version) => { expect(() => assertSupportedNode(version)).not.toThrow(); });
  it.each(["20.20.0", "22.23.3", "22.22.9", "23.99.0", "24.22.0", "24.21.99", "25.0.0", "26.12.1", "24.22.1-rc.1", "invalid"])("rejects unpatched/EOL/untested Node %s", (version) => { expect(() => assertSupportedNode(version)).toThrow(/patched release/); });
});
