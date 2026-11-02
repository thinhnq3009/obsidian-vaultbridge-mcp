import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

type ManagedServer = Server & { closed: Promise<void> };

/** Own all resources until the run has unwound, including interrupted startup. */
export class E2ELifecycle {
  readonly controller = new AbortController();
  private server: ManagedServer | undefined;
  private child: ChildProcess | undefined;
  private directory: string | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private retainStorage = false;

  constructor(private readonly terminationGraceMs = 1000) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  useServer(server: ManagedServer): ManagedServer {
    this.server = server;
    return server;
  }

  useChild(child: ChildProcess): ChildProcess {
    this.child = child;
    return child;
  }

  useDirectory(directory: string): string {
    this.directory = directory;
    return directory;
  }

  fetch: typeof globalThis.fetch = (input, init = {}) => {
    this.signal.throwIfAborted();
    return globalThis.fetch(input, {
      ...init,
      signal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(15_000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  };

  async wait(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.signal });
  }

  async waitForAbort(): Promise<void> {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      this.signal.addEventListener("abort", () => { resolve(); }, { once: true });
    });
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.closeResources();
    return this.cleanupPromise;
  }

  private async closeResources(): Promise<void> {
    // Complete both shutdowns even if one fails. Never delete storage on failure.
    const results = await Promise.allSettled([
      this.child ? stopChild(this.child, this.terminationGraceMs) : Promise.resolve(),
      this.server ? closeServer(this.server, this.terminationGraceMs) : Promise.resolve(),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, "E2E shutdown failed; temporary storage retained");
    if (this.directory && !this.retainStorage) await fs.rm(this.directory, { recursive: true, force: true });
  }

  async stopChildBeforeForcedExit(): Promise<void> {
    // A stalled, non-abortable startup/teardown cannot be safely cleaned up.
    // Stop the external child, but retain every file for recovery/diagnosis.
    this.retainStorage = true;
    console.error(`E2E shutdown deadline exceeded; retaining temporary storage: ${this.directory ?? "(not created)"}`);
    if (this.child) await stopChild(this.child, this.terminationGraceMs);
  }
}

async function closeServer(server: ManagedServer, graceMs: number): Promise<void> {
  // Node's close() returns the server, not a promise. closed also waits for the
  // private owner listener, database, and application watchers to be torn down.
  const timer = setTimeout(() => { server.closeAllConnections(); }, graceMs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    });
    await server.closed;
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve, reject) => {
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(killDeadline);
      child.off("close", onClose);
      child.off("error", finish);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => { finish(); };
    child.once("close", onClose);
    child.once("error", finish);
    // killed indicates successful signal delivery, NOT process termination.
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        killDeadline = setTimeout(() => {
          finish(new Error("Child did not close after SIGKILL"));
        }, 5000);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, graceMs);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function runE2E(
  run: (lifecycle: E2ELifecycle) => Promise<void>,
  { shutdownTimeoutMs = 30_000 } = {},
): Promise<void> {
  const lifecycle = new E2ELifecycle();
  let exitCode = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armShutdownDeadline = () => {
    watchdog ??= setTimeout(() => {
      void (async () => {
        try {
          await lifecycle.stopChildBeforeForcedExit();
        } catch (error) {
          console.error("Emergency child shutdown failed:", error);
        } finally {
          // Last resort only: never delete storage or claim orderly teardown.
          process.exit(exitCode || 1);
        }
      })();
    }, shutdownTimeoutMs);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (lifecycle.signal.aborted) return;
    exitCode = signal === "SIGINT" ? 130 : 143;
    lifecycle.controller.abort(new Error(`Interrupted by ${signal}`));
    armShutdownDeadline();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await run(lifecycle);
    lifecycle.signal.throwIfAborted();
  } catch (error) {
    if (exitCode === 0) {
      exitCode = 1;
      console.error("E2E failed:", error);
    }
  } finally {
    armShutdownDeadline();
    try {
      await lifecycle.cleanup();
    } catch (error) {
      exitCode ||= 1;
      console.error("E2E cleanup failed:", error);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearTimeout(watchdog);
    process.exitCode = exitCode;
  }
}
