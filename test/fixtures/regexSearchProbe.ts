import { performance } from "node:perf_hooks";

import { FilesystemVaultBackend } from "../../src/backend/filesystem.js";
import { makeConfig } from "../helpers.js";

// Run adversarial expressions in a child that the test parent can always kill,
// including when a regression blocks the child's main event loop.
const backend = new FilesystemVaultBackend(makeConfig({
  vaultPath: process.argv[2]!,
  cacheDir: process.argv[3]!,
}));
await backend.initialize();
let ticks = 0;
let maxGap = 0;
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - previous);
  previous = now;
  ticks++;
}, 10);
const start = performance.now();
let code: unknown;
let recovered = false;
try {
  await backend.search({ regex: process.argv[4]!, limit: 10 });
} catch (error) {
  code = error instanceof Error && "code" in error ? error.code : undefined;
  await backend.writeNote("Recovery.md", "healthy query");
  const response = await backend.search({ regex: "healthy", limit: 10 });
  recovered = response.results.some((result) => result.path === "Recovery.md");
} finally {
  clearInterval(heartbeat);
  await backend.close();
}
console.log(JSON.stringify({ code, recovered, ticks, maxGap, elapsedMs: performance.now() - start }));
