import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { E2ELifecycle } from "../scripts/e2eLifecycle.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-lifecycle-test-"));
  directories.push(result);
  return result;
}

describe("E2E resource lifecycle", () => {
  it("waits for HTTP close AND owner/application teardown before deleting storage", async () => {
    const lifecycle = new E2ELifecycle();
    const temp = lifecycle.useDirectory(await directory());
    let finishTeardown!: () => void;
    const server = lifecycle.useServer(Object.assign(http.createServer(), {
      closed: new Promise<void>((resolve) => { finishTeardown = resolve; }),
    }));
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const closed = once(server, "close");
    const first = lifecycle.cleanup();
    expect(lifecycle.cleanup()).toBe(first);
    await closed;
    expect(await fs.stat(temp)).toBeTruthy();
    finishTeardown();
    await first;
    await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains storage and propagates teardown failure", async () => {
    const lifecycle = new E2ELifecycle();
    const temp = lifecycle.useDirectory(await directory());
    const failure = new Error("database close failed");
    const server = lifecycle.useServer(Object.assign(http.createServer(), {
      closed: Promise.resolve().then(() => { throw failure; }),
    }));
    void server.closed.catch(() => {});
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    await expect(lifecycle.cleanup()).rejects.toThrow("temporary storage retained");
    expect(await fs.stat(temp)).toBeTruthy();
  });

  it("bounds HTTP shutdown even when a client holds a streaming response open", async () => {
    const lifecycle = new E2ELifecycle(25);
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.write("open stream");
    });
    const closed = new Promise<void>((resolve) => { server.once("close", resolve); });
    lifecycle.useServer(Object.assign(server, { closed }));
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP port");
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${String(address.port)}`, resolve);
      request.once("error", reject);
    });
    response.on("error", () => {});
    try {
      await lifecycle.cleanup();
      expect(server.listening).toBe(false);
    } finally {
      response.destroy();
      server.closeAllConnections();
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("escalates even when SIGTERM was delivered and waits for a stubborn child to close", async () => {
    const lifecycle = new E2ELifecycle(50);
    const temp = lifecycle.useDirectory(await directory());
    const child = lifecycle.useChild(spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.stdout.write("ready");
    `], { stdio: ["ignore", "pipe", "pipe"] }));
    try {
      await once(child.stdout!, "data");
      const kill = vi.spyOn(child, "kill");
      await lifecycle.cleanup();
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.signalCode).toBe("SIGKILL");
      await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("handles a child that already exited or failed to spawn", async () => {
    const lifecycle = new E2ELifecycle(50);
    const child = lifecycle.useChild(spawn("vaultbridge-nonexistent-test-executable", [], { stdio: "ignore" }));
    await new Promise<void>((resolve) => { child.once("error", () => { resolve(); }); });
    await lifecycle.cleanup();
    const completed = new E2ELifecycle(50);
    const exited = completed.useChild(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
    await once(exited, "close");
    const kill = vi.spyOn(exited, "kill");
    await completed.cleanup();
    expect(kill).not.toHaveBeenCalled();
  });

  it("aborts pending network requests and waits", async () => {
    const lifecycle = new E2ELifecycle();
    lifecycle.controller.abort(new Error("interrupted"));
    expect(() => lifecycle.fetch("http://127.0.0.1:1")).toThrow("interrupted");
    await expect(lifecycle.wait(60_000)).rejects.toThrow();
    await expect(lifecycle.waitForAbort()).rejects.toThrow("interrupted");
  });

  it.each(process.platform === "win32" ? ["normal", "failure"] : ["normal", "failure", "SIGINT", "SIGTERM", "stalled"])(
    "unwinds %s, waits for late startup/teardown, and exits without retaining listeners",
    async (mode) => {
      const parent = await directory();
      const temp = path.join(parent, "run");
      await fs.mkdir(temp);
      const marker = path.join(parent, "teardown-complete");
      const helper = new URL("../scripts/e2eLifecycle.ts", import.meta.url).href;
      const script = `
        import fs from "node:fs/promises";
        import http from "node:http";
        import { setTimeout as delay } from "node:timers/promises";
        import { runE2E } from ${JSON.stringify(helper)};
        await runE2E(async (scope) => {
          scope.useDirectory(${JSON.stringify(temp)});
          scope.signal.addEventListener("abort", () => process.stdout.write("aborted\\n"));
          process.stdout.write("ready\\n");
          if (${JSON.stringify(mode)} === "stalled") {
            setInterval(() => {}, 1000);
            await new Promise(() => {});
          }
          // Simulate a non-abortable setup operation that returns after a signal.
          await delay(200);
          const server = Object.assign(http.createServer(), { closed: Promise.resolve() });
          server.closed = new Promise((resolve, reject) => {
            server.once("close", () => {
              delay(100).then(async () => {
                await fs.stat(${JSON.stringify(temp)});
                await fs.writeFile(${JSON.stringify(marker)}, "closed");
              }).then(resolve, reject);
            });
          });
          await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
          scope.useServer(server);
          scope.signal.throwIfAborted();
          if (${JSON.stringify(mode)} === "failure") throw new Error("expected test failure");
        }, { shutdownTimeoutMs: ${mode === "stalled" ? 100 : 30_000} });
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("close", (code, signal) => { resolve({ code, signal }); });
        child.once("error", reject);
      });
      let output = "";
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      try {
        const ready = new Promise<void>((resolve) => {
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("ready")) resolve();
          });
        });
        await Promise.race([ready, closed.then(() => { throw new Error(`Child exited before ready: ${errors}`); })]);
        if (mode === "SIGINT" || mode === "SIGTERM" || mode === "stalled") {
          const aborted = once(child.stdout, "data");
          child.kill(mode === "SIGINT" ? "SIGINT" : "SIGTERM");
          await aborted;
          child.kill(mode === "SIGINT" ? "SIGTERM" : "SIGINT");
        }
        const { code, signal } = await closed;
        expect(signal, errors).toBeNull();
        expect(code, errors).toBe(mode === "normal" ? 0 : mode === "failure" ? 1 : mode === "SIGINT" ? 130 : 143);
        if (mode === "stalled") {
          expect(errors).toContain("shutdown deadline exceeded");
          expect(await fs.stat(temp)).toBeTruthy();
          await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(marker, "utf8")).toBe("closed");
          await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );
});
