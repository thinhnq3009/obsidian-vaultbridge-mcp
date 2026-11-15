import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { restrictWindowsAccess } from "./windowsPermissions.js";

export function authDataDirectory(platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === "win32") {
    if (!env.APPDATA || !path.isAbsolute(env.APPDATA)) throw new Error("Owner auth requires an absolute APPDATA directory");
    return path.join(env.APPDATA, "ObsidianVaultBridge");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ObsidianVaultBridge");
  if (env.XDG_DATA_HOME && !path.isAbsolute(env.XDG_DATA_HOME)) throw new Error("XDG_DATA_HOME must be absolute");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "obsidian-vaultbridge-mcp");
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors before creating anything, including symlink aliases. */
function canonical(candidate: string): string {
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  return path.join(canonical(path.dirname(candidate)), path.basename(candidate));
}

export function assertOutsideVault(directory: string, vaultPath: string): void {
  const resolved = canonical(directory);
  const vault = fs.realpathSync(vaultPath);
  if (contains(vault, resolved) || contains(resolved, vault)) throw new Error("Owner auth storage must be separate from the vault");
  // Also reject other recognizable vault ancestors, not just the configured vault.
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".obsidian"))) throw new Error("Owner auth storage cannot be inside an Obsidian vault");
    if (current === path.dirname(current)) break;
  }
}

export function assertPrivateFile(file: string): void {
  assertPrivateStat(fs.lstatSync(file));
}

function assertPrivateStat(stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe owner auth storage file");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error("Owner auth files must be owned by this user with mode 0600");
  }
}

/** ENOENT alone means absent; dangling links and permission errors fail closed. */
function privateEntry(file: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(file);
    assertPrivateStat(stat);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertIdentity(file: string, expected: fs.Stats): void {
  const actual = privateEntry(file);
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("Owner auth storage file changed during initialization");
  }
}

function openPrivateFile(file: string): number {
  const expected = privateEntry(file);
  if (!expected) throw new Error("Owner auth storage file disappeared during initialization");
  // O_NONBLOCK prevents a swapped FIFO from hanging before fstat can reject it.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateStat(stat);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error("Owner auth storage file changed during initialization");
    }
    assertIdentity(file, stat);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readSessionKey(file: string): string {
  const fd = openPrivateFile(file);
  try {
    const before = fs.fstatSync(fd);
    const bytes = Buffer.alloc(65);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fs.fstatSync(fd);
    assertPrivateStat(after);
    assertIdentity(file, after);
    const secret = bytes.subarray(0, length).toString("utf8");
    if (before.size !== 64 || after.size !== 64 || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || !/^[A-Za-z0-9_-]{64}$/u.test(secret)) {
      throw new Error("Invalid owner session key; restore a matching database/key backup");
    }
    return secret;
  } finally {
    fs.closeSync(fd);
  }
}

export async function openAuthStorage(directory: string, vaultPath: string) {
  assertOutsideVault(directory, vaultPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe owner auth directory");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error("Owner auth directory must be owned by this user with mode 0700");
  }
  for (const name of ["session.key", "auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm", "setup-token"]) {
    const file = path.join(directory, name);
    privateEntry(file);
  }
  restrictWindowsAccess(directory, true);
  const release = await lockfile.lock(directory, { realpath: true, retries: 0 });
  let database: DatabaseSync | undefined;
  let databaseFd: number | undefined;
  try {
    const secretPath = path.join(directory, "session.key");
    const databasePath = path.join(directory, "auth.sqlite");
    if (!privateEntry(secretPath)) {
      // Reserve a NEW database atomically before generating a key. An existing
      // database (even one that appeared after inspection) must never gain a
      // freshly generated, unrelated session key.
      let reserved: number;
      try { reserved = fs.openSync(databasePath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Missing owner session key; restore the matching key backup", { cause: error });
        }
        throw error;
      }
      try {
        fs.writeFileSync(secretPath, randomBytes(48).toString("base64url"), { flag: "wx", mode: 0o600 });
      } catch (error) {
        // Roll back only our still-empty reservation, never a replacement DB.
        const identity = fs.fstatSync(reserved);
        assertIdentity(databasePath, identity);
        if (identity.size === 0) fs.unlinkSync(databasePath);
        throw error;
      } finally { fs.closeSync(reserved); }
    }
    const secret = readSessionKey(secretPath);
    if (!privateEntry(databasePath)) fs.closeSync(fs.openSync(databasePath, "wx", 0o600));
    databaseFd = openPrivateFile(databasePath);
    const databaseIdentity = fs.fstatSync(databaseFd);
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      privateEntry(file);
    }
    // node:sqlite opens by pathname, not by our descriptor. Verify identity
    // before any PRAGMA, but retain the private-directory/ACL trust boundary.
    database = new DatabaseSync(databasePath);
    assertIdentity(databasePath, databaseIdentity);
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    // SQLite derives sidecar permissions from the pre-created 0600 database.
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${databasePath}${suffix}`;
      privateEntry(file);
    }
    assertIdentity(databasePath, databaseIdentity);
    fs.closeSync(databaseFd);
    databaseFd = undefined;
    const db = database;
    return {
      database: db,
      secret,
      async close() {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          try { db.close(); } finally { await release(); }
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      try {
        if (databaseFd !== undefined) fs.closeSync(databaseFd);
      } finally {
        await release();
      }
    }
    throw error;
  }
}

/** Custom schema is separate from Better Auth's library-owned tables. Forward-only. */
export function migrateOwnerSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS vaultbridge_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const latest = db.prepare("SELECT max(version) AS version FROM vaultbridge_migration").get()?.version;
  if (typeof latest === "number" && latest > 2) throw new Error("Owner database is newer than this binary; restore a pre-upgrade backup to roll back");
  if (latest === undefined || latest === null) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE vaultbridge_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL UNIQUE REFERENCES user(id));
    CREATE TABLE vaultbridge_login_budget (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, expires INTEGER NOT NULL, next_allowed INTEGER NOT NULL);
    INSERT INTO vaultbridge_migration VALUES (1, datetime('now'));
    COMMIT;`);
  if (latest !== 2) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE vaultbridge_owner ADD COLUMN username TEXT;
    ALTER TABLE vaultbridge_owner ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1));
    INSERT INTO vaultbridge_migration VALUES (2, datetime('now'));
    COMMIT;`);
}
