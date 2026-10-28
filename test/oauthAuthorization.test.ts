import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pathActions } from "../src/auth/grants.js";
import { clientA, clientB, oauthHarness } from "./oauthHelpers.js";
import { createVerifiedAuthContext } from "../src/auth/requestContext.js";
import { principalVerifier } from "../src/auth/oauth.js";

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL) => {
    const clientId = String(input);
    if (!["https://client-a.example/metadata.json", "https://client-b.example/metadata.json"].includes(clientId)) throw new Error("Unrecognized fixture client");
    return Promise.resolve(Response.json({
      client_id: clientId, client_name: "Disposable test client", redirect_uris: ["http://127.0.0.1:49152/callback"],
      application_type: "native", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    }));
  },
}));

type Harness = Awaited<ReturnType<typeof oauthHarness>>;
const running: Harness[] = [];
const clients: Client[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  for (const harness of running.splice(0)) await harness.close();
});
async function setup() {
  const h = await oauthHarness(); running.push(h);
  for (const folder of ["Notes", "Other", "Secret"]) {
    await fs.mkdir(path.join(h.vault, folder));
    await fs.writeFile(path.join(h.vault, folder, "A.md"), `shared marker ${folder} private-body`);
    await fs.writeFile(path.join(h.vault, folder, "B.md"), `shared marker ${folder} second-body`);
  }
  // watch=off deliberately uses a startup snapshot; rebuild only via lifecycle,
  // never give the scoped client privileged index-management rights.
  await h.restart();
  return h;
}
const readTools = [
  "obsidian_read_note", "obsidian_read_note_metadata", "obsidian_read_canvas",
  "obsidian_list_files", "obsidian_tree", "obsidian_stat_path",
  "obsidian_search", "obsidian_search_content_advanced",
];
async function provision(h: Harness, clientId: string, folder: string, write = false, tokenWrite = write) {
  const scope = `vault:read${tokenWrite ? " vault:write" : ""} offline_access`;
  const pending = await h.consent(clientId, scope);
  const actions = write ? [...pathActions] : ["readNote", "readNoteMetadata", "listFiles", "statPath", "search"];
  const tools = [...readTools, ...(write ? ["obsidian_write_note", "obsidian_write_notes_bulk", "obsidian_append_to_note", "obsidian_move_path", "obsidian_delete_path"] : [])];
  const created = await h.post("/oauth/grants", {
    oauth_query: pending.query, principalPermissions: [{ path: folder, actions }],
    clientPermissions: [{ path: folder, actions, tools }],
  }, h.cookie);
  expect(created.status).toBe(200);
  const { grantId } = await created.json() as { grantId: string };
  const approved = await h.post("/oauth/consent", { oauth_query: pending.query, accept: true }, h.cookie);
  expect(approved.status).toBe(200);
  const callback = new URL((await approved.json() as { url: string }).url);
  const tokens = await h.exchange({ code: callback.searchParams.get("code")!, verifier: pending.verifier }, clientId);
  return { ...tokens, grantId };
}
async function connect(h: Harness, token: string) {
  const client = new Client({ name: "live-scoped-oauth-test", version: "1" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), {
    requestInit: { headers: {
      authorization: `Bearer ${token}`, "x-client-id": "forged-client", "x-principal-id": "forged-owner",
      "x-grant-id": "forged-grant", "x-vault-id": "other-vault",
    } },
  }));
  return client;
}

describe("AUTH-004 live verified OAuth → SQLite grant → request backend → MCP", () => {
  it.each([
    { label: "issuer", change: { iss: "https://foreign.example/api/auth" } },
    { label: "audience", change: { aud: "https://foreign.example/mcp" } },
    { label: "multiple audiences", change: { aud: ["https://vault.example/mcp", "https://foreign.example/mcp"] } },
    { label: "expired", change: { exp: 1 } },
    { label: "owner", change: { sub: "foreign-owner" } },
    { label: "inactive", change: { active: false } },
    { label: "scope", change: { scope: "vault:admin" } },
    { label: "missing vault scope", change: { scope: "offline_access" } },
    { label: "sender constraint", change: { token_type: "DPoP" } },
  ])("rejects invalid $label at the verified-claims boundary (isolated validator unit)", async ({ change }) => {
    // This unit substitutes the provider result to target the second validation
    // boundary. Every HTTP E2E below uses the real provider, without this seam.
    const verify = principalVerifier(() => Promise.resolve({
      active: true, iss: "https://vault.example/api/auth", aud: "https://vault.example/mcp",
      sub: "owner", client_id: clientA, scope: "vault:read", exp: Math.floor(Date.now() / 1000) + 300,
      token_type: "Bearer", ...change,
    }), { issuer: "https://vault.example/api/auth", resource: "https://vault.example/mcp", ownerId: () => "owner" });
    await expect(verify(`Bearer ${"x".repeat(32)}`)).rejects.toThrow();
  });
  it("allows a consented read, denies sibling paths/writes/privileged tools and sanitizes logs", async () => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes");
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    const client = await connect(h, token.access_token);
    const allowed = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain("Notes private-body");
    for (const call of [
      { name: "obsidian_read_note", arguments: { path: "Secret/A.md" } },
      { name: "obsidian_read_note", arguments: { path: "Other/A.md" } },
      { name: "obsidian_write_note", arguments: { path: "Notes/New.md", content: "must-not-write" } },
      { name: "obsidian_backend_status", arguments: {} },
      { name: "obsidian_rebuild_search_index", arguments: {} },
      { name: "obsidian_get_active_file", arguments: {} },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/Secret|Other|private-body|must-not-write/u);
    }
    const listed = await client.callTool({ name: "obsidian_list_files", arguments: { path: "Notes" } });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(/Secret|Other/u);
    expect(logs.join("\n")).not.toContain(token.access_token);
    expect(logs.join("\n")).not.toContain(h.cookie);
    expect(logs.join("\n")).not.toContain(token.grantId);
    expect(logs.join("\n")).not.toMatch(/private-body|Secret|client-a|forged-owner/u);
    await expect(fs.stat(path.join(h.vault, "Notes/New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates concurrent clients, search snippets and signed pagination cursors", async () => {
    const h = await setup();
    const a = await provision(h, clientA, "Notes");
    const b = await provision(h, clientB, "Other", true);
    const [ca, cb] = await Promise.all([connect(h, a.access_token), connect(h, b.access_token)]);
    await Promise.all(Array.from({ length: 8 }, async () => {
      const [ra, rb, denied] = await Promise.all([
        ca.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } }),
        cb.callTool({ name: "obsidian_read_note", arguments: { path: "Other/A.md" } }),
        ca.callTool({ name: "obsidian_read_note", arguments: { path: "Other/A.md" } }),
      ]);
      expect(ra.isError).not.toBe(true); expect(rb.isError).not.toBe(true); expect(denied.isError).toBe(true);
      expect(JSON.stringify(ra)).not.toMatch(/Other|Secret/u);
      expect(JSON.stringify(rb)).not.toMatch(/Notes|Secret/u);
    }));
    const args = { query: "shared marker", sort: "path", limit: 1 };
    const first = await ca.callTool({ name: "obsidian_search_content_advanced", arguments: args });
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/Other|Secret/u);
    const cursor = (first.structuredContent as { nextCursor: string }).nextCursor;
    expect(cursor).toBeTruthy();
    expect((await cb.callTool({ name: "obsidian_search_content_advanced", arguments: { ...args, cursor } })).isError).toBe(true);
    const second = await ca.callTool({ name: "obsidian_search_content_advanced", arguments: { ...args, cursor } });
    expect(second.isError).not.toBe(true);
    expect(JSON.stringify(second)).not.toMatch(/Other|Secret/u);
    expect((await cb.callTool({ name: "obsidian_write_note", arguments: { path: "Other/New.md", content: "client-b-only", mode: "create" } })).isError).not.toBe(true);
    expect((await ca.callTool({ name: "obsidian_read_note", arguments: { path: "Other/New.md" } })).isError).toBe(true);
  });

  it("intersects token scopes with owner-granted write rights", async () => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes", true, false);
    const client = await connect(h, token.access_token);
    expect((await client.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/New.md", content: "denied" } })).isError).toBe(true);
    expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
  });

  it("rejects expired and foreign-server bearer credentials before MCP execution", async () => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes");
    const other = await oauthHarness(); running.push(other);
    expect((await fetch(`${other.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).status).toBe(401);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 301000);
    const response = await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it.each(["revoke-sessions", "sign-out"])("denies live MCP access after owner %s", async (endpoint) => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes");
    const client = await connect(h, token.access_token);
    expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
    expect((await h.post(`/api/auth/${endpoint}`, {}, h.cookie)).status).toBe(200);
    // Provider session deletion can SET NULL opaque-token session references.
    // Local grants are therefore explicitly disabled: authorization 403, not
    // a false claim that upstream token/family verification now returns 401.
    expect((await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).status).toBe(endpoint === "sign-out" ? 401 : 403);
  });

  it("persists grant invalidation through standalone local owner recovery", async () => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes");
    const client = await connect(h, token.access_token);
    expect((await client.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/A.md" } })).isError).not.toBe(true);
    await client.close();
    await h.recoverOwner();
    expect((await fetch(`${h.ownerOrigin}/oauth/grants`, { headers: { cookie: h.cookie } })).status).toBe(401);
    expect((await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).status).toBe(403);
  });

  it("revokes a live SQLite grant immediately, persists across restart, and leaves another client authorized", async () => {
    const h = await setup();
    const a = await provision(h, clientA, "Notes");
    const b = await provision(h, clientB, "Other");
    const [ca, cb] = await Promise.all([connect(h, a.access_token), connect(h, b.access_token)]);
    const revoked = await h.post("/oauth/grants/revoke", { grantId: a.grantId }, h.cookie);
    expect(revoked.status).toBe(200);
    expect((await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a.access_token}` } })).status).toBe(403);
    expect((await cb.callTool({ name: "obsidian_read_note", arguments: { path: "Other/A.md" } })).isError).not.toBe(true);
    await ca.close(); await cb.close();
    await h.restart();
    expect((await fetch(`${h.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a.access_token}` } })).status).toBe(403);
    const continued = await connect(h, b.access_token);
    expect((await continued.callTool({ name: "obsidian_read_note", arguments: { path: "Other/A.md" } })).isError).not.toBe(true);
  });

  it.each(["grant", "access-token"])("rechecks %s revocation at the final filesystem commit boundary", async (kind) => {
    const h = await setup();
    const token = await provision(h, clientA, "Notes", true);
    const client = await connect(h, token.access_token);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("note.tmp")) {
        const response = kind === "grant"
          ? await h.post("/oauth/grants/revoke", { grantId: token.grantId }, h.cookie)
          : await h.form("revoke", { token: token.access_token, token_type_hint: "access_token" });
        expect(response.status).toBe(200);
      }
      return handle;
    });
    expect((await client.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/New.md", content: "never-committed", mode: "create" } })).isError).toBe(true);
    await expect(fs.stat(path.join(h.vault, "Notes/New.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps grant management owner-only, denies wildcard/spoofed bindings and never accepts structural principals", async () => {
    const h = await setup();
    const pending = await h.consent(clientA);
    const body = { oauth_query: pending.query, principalPermissions: [{ path: "*", actions: ["readNote"] }], clientPermissions: [{ path: "*", actions: ["readNote"], tools: ["obsidian_read_note"] }] };
    expect((await h.post("/oauth/grants", body, h.cookie)).status).toBe(400);
    expect((await h.post("/oauth/grants", body)).status).toBe(401);
    expect((await h.post("/oauth/grants", { ...body, principalId: "injected-owner" }, h.cookie)).status).toBe(400);
    expect((await fetch(`${h.origin}/oauth/grants`, { headers: { cookie: h.cookie } })).status).toBe(401);
    expect((await fetch(`${h.ownerOrigin}/oauth/grants`, { headers: { authorization: "Bearer fake-token" } })).status).toBe(401);
    const listing = await fetch(`${h.ownerOrigin}/oauth/grants`, { headers: { cookie: h.cookie } });
    expect(listing.status).toBe(200);
    expect((await listing.json() as { grants: unknown[] }).grants).toEqual([]);
    const port = new URL(h.origin).port;
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "127.0.0.1:1" } }, (response) => {
        response.resume(); response.on("end", () => { resolve(response.statusCode!); });
      });
      request.on("error", reject); request.end();
    });
    expect(wrongHost).toBe(403);
    // @ts-expect-error Deliberately structurally forged unverified identity.
    expect(() => createVerifiedAuthContext({ principalId: "owner", clientId: clientA, scopes: ["vault:write"] }, {}, "request")).toThrow();
  });
});
