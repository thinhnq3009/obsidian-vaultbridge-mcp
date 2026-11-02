import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Persistent, bounded account+TCP-peer and peer-wide budgets; never account-wide. */
export class LoginBudget {
  public constructor(private readonly db: DatabaseSync, private readonly maxFailures: number, private readonly windowSeconds: number) {}

  private keys(email: string, peer: string): string[] {
    return [`pair:${peer}:${email.trim().toLowerCase()}`, `peer:${peer}`].map((key) => createHash("sha256").update(key).digest("hex"));
  }

  public reserve(email: string, peer: string, now = Date.now()): number {
    this.db.prepare("DELETE FROM vaultbridge_login_budget WHERE expires <= ?").run(now);
    const keys = this.keys(email, peer);
    for (const [index, key] of keys.entries()) {
      const row = this.db.prepare("SELECT failures, expires, next_allowed FROM vaultbridge_login_budget WHERE key=?").get(key);
      if (row && Number(row.failures) >= this.maxFailures * (index === 0 ? 1 : 4)) return Math.max(1, Math.ceil((Number(row.expires) - now) / 1000));
      if (row && Number(row.next_allowed) > now) return Math.ceil((Number(row.next_allowed) - now) / 1000);
    }
    // The listener only accepts loopback peers; cap attacker-controlled account cardinality.
    if (Number(this.db.prepare("SELECT count(*) AS count FROM vaultbridge_login_budget").get()?.count) >= 1024) return this.windowSeconds;
    for (const key of keys) this.db.prepare(`INSERT INTO vaultbridge_login_budget VALUES (?, 1, ?, 0)
      ON CONFLICT(key) DO UPDATE SET failures=failures+1`).run(key, now + this.windowSeconds * 1000);
    return 0;
  }

  public finish(email: string, peer: string, success: boolean, now = Date.now()): void {
    const keys = this.keys(email, peer);
    for (const key of keys) {
      if (success) this.db.prepare("UPDATE vaultbridge_login_budget SET failures=max(0, failures-1) WHERE key=?").run(key);
      else {
        const count = Number(this.db.prepare("SELECT failures FROM vaultbridge_login_budget WHERE key=?").get(key)?.failures ?? 1);
        this.db.prepare("UPDATE vaultbridge_login_budget SET next_allowed=? WHERE key=?").run(now + Math.min(60, 2 ** Math.min(count - 1, 6)) * 1000, key);
      }
    }
    if (success) this.db.prepare("DELETE FROM vaultbridge_login_budget WHERE key=?").run(keys[0]!);
  }
}
