import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDevOauthConfig } from "../scripts/dev-oauth-config.js";

const base = { VAULT_PATH: ".", MCP_OWNER_PASSWORD: "StrongOwnerPassword2026!" };
const config = (overrides: Record<string, string> = {}, argv: string[] = []) =>
  createDevOauthConfig({ ...base, ...overrides }, argv, {});

describe("OAuth development launcher", () => {
  it("starts loopback HTTP OAuth, private owner listener and a stable vault id by default", () => {
    const dev = config();
    expect(dev.mcpTransport).toBe("http");
    expect(dev.mcpAuthMode).toBe("oauth");
    expect(dev.mcpOauthEnabled).toBe(true);
    expect(dev.mcpHttpHost).toBe("127.0.0.1");
    expect(dev.mcpHttpPort).toBe(39145);
    expect(dev.mcpOwnerPort).toBe(39146);
    expect(dev.mcpOauthIssuer).toBe("http://127.0.0.1:39145/api/auth");
    expect(dev.mcpAllowedHosts).toEqual(["127.0.0.1"]);
    expect(dev.mcpVaultId).toMatch(/^dev-[a-f0-9]{32}$/u);
  });

  it("binds default OAuth grant identity to the canonical vault and never shares it across different vaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-dev-id-"));
    try {
      const a = path.join(root, "A");
      const b = path.join(root, "B");
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const first = config({ VAULT_PATH: a }).mcpVaultId;
      const second = config({ VAULT_PATH: b }).mcpVaultId;
      expect(first).not.toBe(second);
      expect(config({ VAULT_PATH: a }).mcpVaultId).toBe(first);
      expect(config({ VAULT_PATH: b, MCP_VAULT_ID: "explicit-reviewed-id" }).mcpVaultId).toBe("explicit-reviewed-id");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("overrides a copied .env STDIO setting without modifying the normal server", () => {
    expect(createDevOauthConfig(base, [], { MCP_TRANSPORT: "stdio" }).mcpTransport).toBe("http");
    expect(config({}, ["--port", "42145"]).mcpOauthIssuer).toBe("http://127.0.0.1:42145/api/auth");
    expect(config({}, ["--owner-port=42146"]).mcpOwnerPort).toBe(42146);
  });

  it("supports one public HTTPS tunnel with an explicit trusted proxy acknowledgement", () => {
    const dev = config({
      MCP_OAUTH_ISSUER: "https://mcp.example.com/api/auth",
      MCP_HTTP_TLS_PROXY: "true",
      MCP_VAULT_ID: "my-vault",
    });
    expect(dev.mcpHttpHost).toBe("127.0.0.1");
    expect(dev.mcpAllowedHosts).toEqual(["mcp.example.com"]);
    expect(dev.mcpOauthIssuer).toBe("https://mcp.example.com/api/auth");
    expect(dev.mcpVaultId).toBe("my-vault");
  });

  it("fails closed on missing credentials, conflicting transports, and unsafe public listeners", () => {
    expect(() => createDevOauthConfig({ VAULT_PATH: "." }, [], {})).toThrow(/MCP_OWNER_PASSWORD/);
    expect(() => config({ MCP_OWNER_PASSWORD: "admin39145" })).toThrow(/MCP_OWNER_PASSWORD/);
    expect(() => config({ MCP_HTTP_HOST: "0.0.0.0" })).toThrow(/127.0.0.1/);
    expect(() => config({ MCP_AUTH_MODE: "none" })).toThrow(/MCP_AUTH_MODE=oauth/);
    expect(() => config({}, ["--stdio"])).toThrow(/HTTP transport/);
    expect(() => config({ MCP_AUTH_TOKEN: "token" })).toThrow(/cannot be combined/);
  });

  it("rejects issuer/port mismatches and unsafe HTTPS defaults", () => {
    expect(() => config({ MCP_OAUTH_ISSUER: "http://localhost:39145/api/auth" })).toThrow(/local HTTP OAuth/);
    expect(() => config({ MCP_OAUTH_ISSUER: "http://127.0.0.1:5000/api/auth" })).toThrow(/same 127.0.0.1 port/);
    expect(() => config({ MCP_OAUTH_ISSUER: "https://mcp.example.com/api/auth" })).toThrow(/MCP_HTTP_TLS_PROXY=true/);
    expect(() => config({ MCP_OWNER_PORT: "39145" })).toThrow(/must be different/);
  });
});
