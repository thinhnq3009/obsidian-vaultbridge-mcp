import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { LoginBudget } from "../src/auth/loginBudget.js";
import { principalVerifier } from "../src/auth/oauth.js";
import { verifyReadonlyTools } from "../scripts/e2eToolChecks.js";

describe("AUTH-002 login budget cardinality", () => {
  it("admits existing buckets at capacity without admitting new identities", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE vaultbridge_login_budget (key TEXT PRIMARY KEY, failures INTEGER, expires INTEGER, next_allowed INTEGER)");
      const budget = new LoginBudget(db, 5, 900);
      expect(budget.reserve("owner", "127.0.0.1", 1000)).toBe(0);
      const insert = db.prepare("INSERT INTO vaultbridge_login_budget VALUES (?, 1, 901000, 0)");
      for (let index = 0; index < 1022; index++) insert.run(`filler-${index}`);
      expect(budget.reserve("new-owner", "127.0.0.1", 1001)).toBeGreaterThan(0);
      expect(budget.reserve("owner", "127.0.0.1", 1001)).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM vaultbridge_login_budget").get()?.n).toBe(1024);
    } finally { db.close(); }
  });

  it("does not cross the cap when both keys are new", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE vaultbridge_login_budget (key TEXT PRIMARY KEY, failures INTEGER, expires INTEGER, next_allowed INTEGER)");
      const insert = db.prepare("INSERT INTO vaultbridge_login_budget VALUES (?, 1, 901000, 0)");
      for (let index = 0; index < 1023; index++) insert.run(`filler-${index}`);
      expect(new LoginBudget(db, 5, 900).reserve("owner", "127.0.0.1", 1000)).toBeGreaterThan(0);
      expect(db.prepare("SELECT count(*) AS n FROM vaultbridge_login_budget").get()?.n).toBe(1023);
    } finally { db.close(); }
  });
});

describe("AUTH-003 bearer scheme syntax", () => {
  const token = "AbCdEf0123456789_abcd";
  function verifier() {
    const validate = vi.fn(() => Promise.resolve({
      active: true, iss: "https://vault.example/api/auth", aud: "https://vault.example/mcp",
      sub: "owner", client_id: "client", scope: "vault:read", exp: Math.floor(Date.now() / 1000) + 300,
      token_type: "Bearer",
    }));
    return { validate, verify: principalVerifier(validate, {
      issuer: "https://vault.example/api/auth", resource: "https://vault.example/mcp", ownerId: () => "owner",
    }) };
  }
  it.each(["Bearer", "bearer", "BEARER", "bEaReR", "Bearer  "])("accepts %s without changing token bytes", async (scheme) => {
    const { validate, verify } = verifier();
    await expect(verify(`${scheme} ${token}`)).resolves.toMatchObject({ principalId: "owner" });
    expect(validate).toHaveBeenCalledWith(token);
  });
  it.each(["Basic", "Bearer\t", "Bearer,", "Bearer\n"])("rejects malformed scheme %j before provider validation", async (scheme) => {
    const { validate, verify } = verifier();
    await expect(verify(`${scheme} ${token}`)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("AUTH-005 authorization evidence", () => {
  it.each(["ALREADY_EXISTS", "CONFLICT", "Invalid arguments", "TOOL_ERROR: ACCESS_DENIED"])("does not misreport %s as a write authorization denial", async (error) => {
    const client = { callTool: vi.fn((input: { name: string; arguments: Record<string, unknown> }) => Promise.resolve(
      input.name === "obsidian_write_note" ? { isError: true, content: [{ type: "text", text: error }] }
        : input.arguments.path === "Secret/A.md" ? { isError: true, content: [{ type: "text", text: "ACCESS_DENIED: Request authorization denied." }] }
          : { content: [{ type: "text", text: "allowed marker" }], structuredContent: { revision: "revision-1" } },
    )) };
    await expect(verifyReadonlyTools(client, { notePath: "Notes/A.md", deniedPath: "Secret/A.md", expectedContent: "allowed marker" })).rejects.toThrow(/Write must fail for authorization/);
  });

  it("uses a revision-valid replacement and accepts an explicit authorization denial", async () => {
    const client = { callTool: vi.fn((input: { name: string; arguments: Record<string, unknown> }) => Promise.resolve(
      input.name === "obsidian_write_note" || input.arguments.path === "Secret/A.md"
        ? { isError: true, content: [{ type: "text", text: "ACCESS_DENIED: Request authorization denied." }] }
        : { content: [{ type: "text", text: "allowed marker" }], structuredContent: { revision: "revision-1" } },
    )) };
    await verifyReadonlyTools(client, { notePath: "Notes/A.md", deniedPath: "Secret/A.md", expectedContent: "allowed marker" });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "obsidian_write_note",
      arguments: { path: "Notes/A.md", content: "must not write", mode: "replace", expected_revision: "revision-1" },
    });
  });
});
