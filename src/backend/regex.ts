import { Worker } from "node:worker_threads";

import { VaultError } from "../types.js";

const MAX_PATTERN_LENGTH = 256;
const MAX_DOCUMENTS = 10_000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 1000;

// Fixed JavaScript keeps workers usable in compiled, tsx and Vitest entrypoints.
// User input is structured-cloned data; it is never interpolated into this code.
const WORKER_SOURCE = `
import("node:worker_threads").then(({ parentPort, workerData }) => {
try {
  const regex = new RegExp(workerData.pattern, workerData.caseSensitive ? "u" : "iu");
  const matches = [];
  for (let index = 0; index < workerData.contents.length; index++) {
    if (regex.test(workerData.contents[index])) matches.push(index);
  }
  parentPort.postMessage({ matches });
} catch {
  parentPort.postMessage({ invalid: true });
}
});
`;

/** Evaluate an entire query under one deadline, never on the server event loop. */
export async function matchRegex(pattern: string, caseSensitive: boolean, contents: string[]): Promise<Set<number>> {
  // Preserve the existing syntax restrictions as an inexpensive early rejection.
  // They are not a ReDoS guarantee: the worker deadline enforces that boundary.
  if (pattern.length > MAX_PATTERN_LENGTH || /\\[1-9]|\(\?<([=!])|\(\?<[A-Za-z]/u.test(pattern)
    || /\([^)]*[+*][^)]*\)[+*{]/u.test(pattern)) {
    throw invalidQuery("Regular expression is too complex or unsupported.");
  }
  if (contents.length > MAX_DOCUMENTS) throw invalidQuery("Regex search exceeds 10000 candidate notes. Narrow the query with filters.");
  let bytes = 0;
  for (const content of contents) {
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_INPUT_BYTES) throw invalidQuery("Regex search exceeds 16 MiB of candidate content. Narrow the query with filters.");
  }

  return new Promise<Set<number>>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, caseSensitive, contents },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (matches: number[] | undefined, error?: VaultError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the queue only after the worker is stopped, including on timeout.
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(new Set(matches));
      }, () => { reject(invalidQuery("Regex worker could not be stopped.")); });
    };
    const timer = setTimeout(() => { finish(undefined, invalidQuery("Regex search exceeded its 1000 ms execution budget. Simplify the expression or narrow the query.")); }, TIMEOUT_MS);
    worker.once("message", (result: { matches?: number[]; invalid?: boolean }) => {
      if (result.invalid || !result.matches) finish(undefined, invalidQuery("Invalid or unsupported regular expression."));
      else finish(result.matches);
    });
    worker.once("error", () => { finish(undefined, invalidQuery("Regex worker failed or exceeded its memory budget.")); });
    worker.once("exit", () => { finish(undefined, invalidQuery("Regex worker exited before completing the query.")); });
  });
}

function invalidQuery(message: string): VaultError {
  return new VaultError(message, { code: "INVALID_QUERY" });
}
