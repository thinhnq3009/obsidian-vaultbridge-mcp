// Reproducible OBS-006 load smoke, deliberately separate from the Vitest suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FilesystemVaultBackend } from "../../src/backend/filesystem.js";
import { VaultAccessPolicy } from "../../src/backend/accessPolicy.js";
import type { SearchQuery } from "../../src/backend/types.js";
import { makeConfig } from "../helpers.js";

const option = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const sizes = option("sizes", "1000,5000,10000").split(",").map(Number);
const concurrencies = option("concurrency", "1,10,50").split(",").map(Number);
const modes = option("modes", "scan,indexed").split(",");
const scenarios = option("scenarios", "queries,write,watcher,rebuild").split(",");
const rounds = Number(option("rounds", "1"));
const label = option("label", "working-tree");
const watchMode = option("watch", "on") === "on" ? "on" : "off";
if (![...sizes, ...concurrencies, rounds].every((n) => Number.isInteger(n) && n > 0)) throw new Error("Positive integers required");
if (!modes.every((mode) => mode === "scan" || mode === "indexed")) throw new Error("Unknown mode");
if (!scenarios.every((scenario) => ["queries", "write", "watcher", "rebuild"].includes(scenario))) throw new Error("Unknown scenario");
process.stdout.write(`${JSON.stringify({ label, node: process.version, os: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.availableParallelism(), rounds, watchMode, sizes, concurrencies, scenarios, cache: "warm snapshot, fresh authorization each operation/batch", requests: "max(3, concurrency) * rounds per cell; one simultaneous wave at c>=3" })}\n`);

const quantile = (values: number[], p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
// Deliberately preserve the receiver with .call when instrumenting this method.
// eslint-disable-next-line @typescript-eslint/unbound-method
const check = VaultAccessPolicy.prototype.allowsSearchPath;
let authorizationChecks = 0;
VaultAccessPolicy.prototype.allowsSearchPath = async function (this: VaultAccessPolicy, absolute, directory) {
  authorizationChecks += 1;
  return check.call(this, absolute, directory);
};

try {
  for (const size of sizes) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "obs006-load-"));
    const vault = path.join(root, "vault");
    await fs.mkdir(vault);
    for (let start = 0; start < size; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, size - start) }, (_, i) => fs.writeFile(path.join(vault, `Note-${start + i}.md`), `---\nstatus: active\ntags: [bench]\n---\n# Note ${start + i}\ncommonmarker cohort${(start + i) % 20} Café 日本語\n`)));
    }
    try {
      for (const mode of modes) {
        const backend = new FilesystemVaultBackend(makeConfig({ vaultPath: vault, cacheDir: path.join(root, `cache-${mode}`), indexMode: mode === "scan" ? "scan" : "indexed", watchMode, autoAgentEditAt: true }));
        try {
          await backend.initialize();
          const query: SearchQuery = { query: "commonmarker", match: "exact", tag: "bench", frontmatter: { status: "active" }, limit: 20, sort: "path" };
          await backend.search(query);
          for (const concurrency of concurrencies) {
            for (const scenario of scenarios) {
              const count = Math.max(3, concurrency) * rounds;
              const latencies: number[] = [];
              let next = 0;
              const beforeChecks = authorizationChecks;
              const start = performance.now();
              const auxiliaryStart = performance.now();
              const auxiliary = (async () => {
                const marker = `${mode}-${concurrency}-${scenario}-${rounds}`;
                if (scenario === "write") {
                  const note = await backend.readNote("Note-0.md");
                  await backend.writeNote("Note-0.md", `${note.content}\nwrite${marker}`, { mode: "replace", expectedRevision: note.revision });
                } else if (scenario === "watcher") {
                  await fs.writeFile(path.join(vault, "Watch.md"), `watch${marker}`);
                  const deadline = performance.now() + 30_000;
                  while (!(await backend.search({ query: `watch${marker}`, match: "exact", limit: 1 })).results.length) {
                    if (performance.now() > deadline) throw new Error("Watcher did not reconcile");
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                  }
                } else if (scenario === "rebuild") {
                  await backend.rebuildSearchIndex();
                }
              })();
              const queries = Promise.all(Array.from({ length: concurrency }, async () => {
                while (next++ < count) {
                  const requestStart = performance.now();
                  const result = await backend.search(query);
                  if (result.results.length !== 20) throw new Error("Incorrect search result count");
                  latencies.push(performance.now() - requestStart);
                }
              }));
              const completedQueries = queries.then(() => performance.now() - start);
              const completedAuxiliary = auxiliary.then(() => performance.now() - auxiliaryStart);
              const [totalMs, auxiliaryMs] = await Promise.all([completedQueries, completedAuxiliary]);
              latencies.sort((a, b) => a - b);
              const round = (n: number) => Number(n.toFixed(2));
              process.stdout.write(`${JSON.stringify({ label, size, mode, watch: watchMode, concurrency, scenario, count, durationMs: round(totalMs), allWorkMs: round(performance.now() - start), qps: round(count * 1000 / totalMs), p50Ms: round(quantile(latencies, .5)), p95Ms: round(quantile(latencies, .95)), p99Ms: round(quantile(latencies, .99)), auxiliaryMs: round(auxiliaryMs), authorizationChecks: authorizationChecks - beforeChecks })}\n`);
              // Allow debounced self-write events to settle outside the timer.
              if (watchMode === "on") await new Promise<void>((resolve) => setTimeout(resolve, 400));
              await backend.search({ limit: 1 });
            }
          }
        } finally { await backend.close(); }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
} finally { VaultAccessPolicy.prototype.allowsSearchPath = check; }
