import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this build with npm run build");

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
for (const args of [
  [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"],
  [npmCli, "run", "build:web"],
]) {
  // Keep npm pack --json machine-readable, including nested Vite build logs.
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: ["inherit", process.stderr, process.stderr] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
