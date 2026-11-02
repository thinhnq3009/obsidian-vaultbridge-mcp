import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestBudgets } from "../src/auth/budgets.js";

afterEach(() => { vi.useRealTimers(); });

describe("request token buckets", () => {
  it.each(["global", "client:verified", "attempt:peer"])("retains fractional refill after rejected %s requests", (key) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budgets = new RequestBudgets();
    expect(budgets.take(key, 60, 1)).toBe(true);
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      vi.setSystemTime(attempt * 500);
      expect(budgets.take(key, 60, 1)).toBe(attempt % 2 === 0);
    }
  });

  it("caps idle refill at burst capacity and isolates keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budgets = new RequestBudgets();
    expect(budgets.take("a", 60, 2)).toBe(true);
    expect(budgets.take("a", 60, 2)).toBe(true);
    expect(budgets.take("a", 60, 2)).toBe(false);
    expect(budgets.take("b", 60, 2)).toBe(true);
    vi.setSystemTime(60_000);
    expect(budgets.take("a", 60, 2)).toBe(true);
    expect(budgets.take("a", 60, 2)).toBe(true);
    expect(budgets.take("a", 60, 2)).toBe(false);
  });

  it("only reclaims expired buckets when the bounded map is full", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budgets = new RequestBudgets();
    for (let key = 0; key < 4096; key += 1) expect(budgets.take(String(key), 60, 1)).toBe(true);
    expect(budgets.take("overflow", 60, 1)).toBe(false);
    vi.setSystemTime(60_001);
    expect(budgets.take("overflow", 60, 1)).toBe(true);
  });
});
