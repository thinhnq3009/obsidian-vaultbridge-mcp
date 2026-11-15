import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAuthStorage } from "../src/auth/storage.js";

let root: string;
let directory: string;
let vault: string;
const key = "a".repeat(64);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-storage-races-"));
  directory = path.join(root, "identity");
  vault = path.join(root, "vault");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(directory, "session.key"), key, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("owner storage descriptor validation", () => {
  it("keeps an existing key and database across restart", async () => {
    const first = await openAuthStorage(directory, vault);
    first.database.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep')");
    await first.close();
    const second = await openAuthStorage(directory, vault);
    try {
      expect(second.secret).toBe(key);
      expect(second.database.prepare("SELECT value FROM sentinel").get()?.value).toBe("keep");
    } finally { await second.close(); }
  });

  it("rejects a key replaced between pathname validation and open and releases its lock", async () => {
    const secretPath = path.join(directory, "session.key");
    const originalOpen = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === secretPath && typeof flags === "number" && !swapped) {
        swapped = true;
        fs.renameSync(secretPath, `${secretPath}.saved`);
        fs.writeFileSync(secretPath, "b".repeat(64), { mode: 0o644 });
        if (process.platform === "win32") {
          fs.unlinkSync(secretPath);
          fs.linkSync(`${secretPath}.saved`, secretPath);
        }
      }
      return originalOpen(file, flags, mode);
    });
    await expect(openAuthStorage(directory, vault)).rejects.toThrow(/0600|Unsafe/u);
    vi.restoreAllMocks();
    fs.unlinkSync(secretPath);
    fs.renameSync(`${secretPath}.saved`, secretPath);
    const retry = await openAuthStorage(directory, vault);
    await retry.close();
  });

  it("rejects replacement of the key pathname after descriptor open without reading the replacement", async () => {
    const secretPath = path.join(directory, "session.key");
    const originalRead = fs.readSync;
    let swapped = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(secretPath, `${secretPath}.saved`);
        fs.writeFileSync(secretPath, "b".repeat(64), { mode: 0o600 });
      }
      return originalRead(...args);
    });
    await expect(openAuthStorage(directory, vault)).rejects.toThrow("changed during initialization");
    expect(fs.readFileSync(secretPath, "utf8")).toBe("b".repeat(64));
  });

  it("does not overwrite a key created concurrently before exclusive initialization", async () => {
    const secretPath = path.join(directory, "session.key");
    fs.unlinkSync(secretPath);
    const write = fs.writeFileSync;
    let created = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === secretPath && !created) {
        created = true;
        write(secretPath, "c".repeat(64), { flag: "wx", mode: 0o600 });
      }
      return write(file, data, options);
    });
    await expect(openAuthStorage(directory, vault)).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(secretPath, "utf8")).toBe("c".repeat(64));
    expect(fs.existsSync(path.join(directory, "auth.sqlite"))).toBe(false);
    vi.restoreAllMocks();
    const retry = await openAuthStorage(directory, vault);
    try { expect(retry.secret).toBe("c".repeat(64)); } finally { await retry.close(); }
  });

  it("rejects database replacement before its descriptor open", async () => {
    const databasePath = path.join(directory, "auth.sqlite");
    fs.writeFileSync(databasePath, "", { mode: 0o600 });
    const originalOpen = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === databasePath && typeof flags === "number" && !swapped) {
        swapped = true;
        fs.renameSync(databasePath, `${databasePath}.saved`);
        fs.writeFileSync(databasePath, "do not open or modify", { mode: 0o600 });
      }
      return originalOpen(file, flags, mode);
    });
    await expect(openAuthStorage(directory, vault)).rejects.toThrow("changed during initialization");
    expect(fs.readFileSync(databasePath, "utf8")).toBe("do not open or modify");
  });

  it("never generates a key when a competing database appears before exclusive creation", async () => {
    const secretPath = path.join(directory, "session.key");
    const databasePath = path.join(directory, "auth.sqlite");
    fs.unlinkSync(secretPath);
    const open = fs.openSync;
    let created = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === databasePath && flags === "wx" && !created) {
        created = true;
        fs.writeFileSync(databasePath, "unrelated database; preserve", { mode: 0o600 });
      }
      return open(file, flags, mode);
    });
    await expect(openAuthStorage(directory, vault)).rejects.toThrow();
    expect(created).toBe(true);
    expect(fs.existsSync(secretPath)).toBe(false);
    expect(fs.readFileSync(databasePath, "utf8")).toBe("unrelated database; preserve");
    expect(fs.existsSync(`${directory}.lock`)).toBe(false);
  });

  it("bounds key reads and releases descriptors and locks after malformed content", async () => {
    const secretPath = path.join(directory, "session.key");
    fs.writeFileSync(secretPath, "x".repeat(1024 * 1024));
    const spy = vi.spyOn(fs, "readSync");
    await expect(openAuthStorage(directory, vault)).rejects.toThrow("Invalid owner session key");
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) {
      const buffer = call[1];
      expect(ArrayBuffer.isView(buffer) && buffer.byteLength <= 65).toBe(true);
      expect(() => fs.fstatSync(call[0])).toThrow();
    }
    vi.restoreAllMocks();
    fs.writeFileSync(secretPath, key);
    const retry = await openAuthStorage(directory, vault);
    await retry.close();
  });

  it("never generates a replacement key when an existing database lost its key", async () => {
    fs.unlinkSync(path.join(directory, "session.key"));
    const database = path.join(directory, "auth.sqlite");
    fs.writeFileSync(database, "must not modify", { mode: 0o600 });
    await expect(openAuthStorage(directory, vault)).rejects.toThrow("Missing owner session key");
    expect(fs.existsSync(path.join(directory, "session.key"))).toBe(false);
    expect(fs.readFileSync(database, "utf8")).toBe("must not modify");
  });

  it("releases its lock even when database shutdown reports an error", async () => {
    const store = await openAuthStorage(directory, vault);
    const close = store.database.close.bind(store.database);
    vi.spyOn(store.database, "close").mockImplementation(() => {
      close();
      throw new Error("injected close failure");
    });
    await expect(store.close()).rejects.toThrow("injected close failure");
    vi.restoreAllMocks();
    const retry = await openAuthStorage(directory, vault);
    await retry.close();
  });

  it.skipIf(process.platform === "win32")("rejects dangling key, database and sidecar links without creating targets", async () => {
    for (const name of ["session.key", "auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm", "setup-token"]) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const target = path.join(root, `missing-${name}`);
      fs.symlinkSync(target, file);
      await expect(openAuthStorage(directory, vault)).rejects.toThrow("Unsafe");
      expect(fs.existsSync(target)).toBe(false);
      fs.unlinkSync(file);
      if (name === "session.key") fs.writeFileSync(file, key, { mode: 0o600 });
    }
  });
});
