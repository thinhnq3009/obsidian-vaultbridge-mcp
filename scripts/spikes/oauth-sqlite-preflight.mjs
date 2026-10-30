#!/usr/bin/env node
/**
 * Isolated AUTH-001 SQLite feasibility probe; never touches the configured vault.
 * This is NOT an OAuth provider or a substitute for OAuth integration tests.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'obsidian-vaultbridge-oauth-'));
const databasePath = path.join(temporaryDirectory, 'probe.sqlite');
let db;

try {
  db = new DatabaseSync(databasePath);
  const mode = db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode;
  assert.equal(String(mode).toLowerCase(), 'wal', 'SQLite WAL must be available');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`CREATE TABLE code_probe (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  ) STRICT`);

  // Use a hash of random bytes: no plaintext auth code is stored or printed.
  const codeHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const now = Date.now();
  db.prepare('INSERT INTO code_probe(code_hash, expires_at) VALUES (?, ?)')
    .run(codeHash, now + 60_000);

  const consume = db.prepare(`UPDATE code_probe
    SET used_at = ?
    WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    RETURNING used_at`);
  const first = consume.get(now, codeHash, now);
  assert.equal(Number(first?.used_at), now, 'valid one-time code must be consumed once');
  assert.equal(consume.get(now, codeHash, now), undefined, 'consumed code must not be reusable');
  db.close();
  db = undefined;

  db = new DatabaseSync(databasePath);
  const persisted = db.prepare('SELECT used_at FROM code_probe WHERE code_hash = ?').get(codeHash);
  assert.equal(Number(persisted?.used_at), now, 'consumption must survive reopening SQLite');
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get()?.version;

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime: process.version,
    platform: process.platform,
    sqliteVersion,
    wal: true,
    singleUseCode: true,
    persistedAfterRestart: true,
    disposableDatabase: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AUTH-001 SQLite preflight FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
