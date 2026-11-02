/** Bounded, peer/verified-identity keyed token buckets; no caller-supplied keys. */
export class RequestBudgets {
  private readonly entries = new Map<string, { tokens: number; at: number; expires: number }>();
  public take(key: string, rpm: number, burst = rpm): boolean {
    const now = Date.now();
    const entry = this.entries.get(key);
    const tokens = entry ? Math.min(burst, entry.tokens + (now - entry.at) * rpm / 60000) : burst;
    // Do not evict active buckets (which would reset an attacker's allowance).
    if (!entry && this.entries.size >= 4096) {
      for (const [id, value] of this.entries) if (now > value.expires) this.entries.delete(id);
      if (this.entries.size >= 4096) return false;
    }
    this.entries.set(key, { tokens: Math.max(0, tokens - 1), at: now, expires: now + Math.max(60000, burst * 60000 / rpm) });
    return tokens >= 1;
  }
  public refund(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.tokens += 1;
  }
}
