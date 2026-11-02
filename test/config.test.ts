import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, parseCliArgs } from "../src/config.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("validates the independent OAuth endpoint admission budget and CLI precedence", () => {
    expect(loadConfig({ VAULT_PATH: "." }, []).mcpOauthEndpointRpm).toBe(60);
    expect(loadConfig({ VAULT_PATH: ".", MCP_OAUTH_ENDPOINT_RPM: "12" }, []).mcpOauthEndpointRpm).toBe(12);
    expect(loadConfig({ VAULT_PATH: ".", MCP_OAUTH_ENDPOINT_RPM: "12" }, ["--oauth-endpoint-rpm=7"]).mcpOauthEndpointRpm).toBe(7);
    for (const value of ["0", "-1", "1001", "Infinity", "invalid"]) {
      expect(() => loadConfig({ VAULT_PATH: ".", MCP_OAUTH_ENDPOINT_RPM: value }, [])).toThrow(/Invalid configuration/);
    }
  });
  it("defaults automatic agent timestamps on and accepts environment/CLI rollback", () => {
    expect(loadConfig({ VAULT_PATH: "." }, []).autoAgentEditAt).toBe(true);
    expect(loadConfig({ VAULT_PATH: ".", AUTO_AGENT_EDIT_AT: "false" }, []).autoAgentEditAt).toBe(false);
    expect(loadConfig({ VAULT_PATH: "." }, ["--auto-agent-edit-at=false"]).autoAgentEditAt).toBe(false);
    expect(() => loadConfig({ VAULT_PATH: ".", AUTO_AGENT_EDIT_AT: "invalid" }, [])).toThrow(/Invalid configuration/);
  });

  it("uses standalone filesystem defaults", () => {
    const config = loadConfig({ VAULT_PATH: "." }, []);
    expect(config.backend).toBe("filesystem");
    expect(config.vaultPath).toBe(path.resolve("."));
    expect(config.readOnly).toBe(false);
    expect(config.indexMode).toBe("auto");
    expect(config.watchMode).toBe("auto");
    expect(config.mcpTransport).toBe("stdio");
    expect(config.colorfulLogs).toBe(false);
  });

  it("requires only vault path in filesystem mode", () => {
    expect(() => loadConfig({}, [])).toThrow(/no Obsidian vault could be auto-detected/);
    expect(() => loadConfig({ VAULT_PATH: "." }, [])).not.toThrow();
  });

  it("keeps explicit vault path above auto-detected registry paths", async () => {
    const root = await createTempDir();
    const detectedVault = await createVault(root, "Detected");
    const explicitVault = await createVault(root, "Explicit");
    const registry = await createRegistry(root, { detected: { path: detectedVault, open: true } });

    const config = loadConfig({ ...registry.environment, VAULT_PATH: explicitVault }, []);

    expect(config.vaultPath).toBe(path.resolve(explicitVault));
  });

  it("auto-detects the single open Obsidian registry vault", async () => {
    const root = await createTempDir();
    const closedVault = await createVault(root, "Closed");
    const openVault = await createVault(root, "Open");
    const registry = await createRegistry(root, {
      closed: { path: closedVault, open: false },
      open: { path: openVault, open: true },
    });

    const config = loadConfig(registry.environment, []);

    expect(config.vaultPath).toBe(path.resolve(openVault));
  });

  it.each([false, true])("falls back to the current directory when it is an Obsidian vault (symlink: %s)", async (useSymlink) => {
    const root = await createTempDir();
    const target = await createVault(root, "Current");
    const vault = useSymlink ? path.join(root, "CurrentLink") : target;
    if (useSymlink) await fs.symlink(target, vault, "junction");
    process.chdir(vault);

    const config = loadConfig({}, []);

    // cwd may resolve directory symlinks, including macOS /var -> /private/var.
    expect(config.vaultPath).toBe(process.cwd());
  });

  it("fails when no vault can be auto-detected", async () => {
    const root = await createTempDir();
    process.chdir(root);

    expect(() => loadConfig({}, [])).toThrow(/Pass --vault or set VAULT_PATH/);
  });

  it("fails when multiple registered vaults are valid and none is open", async () => {
    const root = await createTempDir();
    const firstVault = await createVault(root, "First");
    const secondVault = await createVault(root, "Second");
    const registry = await createRegistry(root, {
      first: { path: firstVault, open: false },
      second: { path: secondVault, open: false },
    });

    expect(() => loadConfig(registry.environment, [])).toThrow(/multiple Obsidian vaults/);
  });

  it("validates Local REST configuration only in compatibility mode", () => {
    expect(() => loadConfig({ BACKEND: "local-rest" }, [])).toThrow(/OBSIDIAN_API_KEY is required/);
    const config = loadConfig({ BACKEND: "local-rest", OBSIDIAN_API_KEY: "secret" }, []);
    expect(config.backend).toBe("local-rest");
    expect(config.obsidianBaseUrl).toBe("https://127.0.0.1:27124");
  });

  it("parses access scopes and standalone flags", () => {
    const config = loadConfig({ VAULT_PATH: ".", READ_ONLY: "yes", READ_PATHS: "Notes,Projects", WRITE_PATHS: "Projects", INDEX_MODE: "indexed", WATCH_MODE: "off" }, []);
    expect(config.readOnly).toBe(true);
    expect(config.readPaths).toEqual(["Notes", "Projects"]);
    expect(config.writePaths).toEqual(["Projects"]);
    expect(config.indexMode).toBe("indexed");
    expect(config.watchMode).toBe("off");
  });

  it("requires authentication for non-loopback HTTP", () => {
    expect(() => loadConfig({ VAULT_PATH: ".", MCP_HTTP_HOST: "0.0.0.0" }, [])).toThrow(/MCP_AUTH_TOKEN is required/);
    expect(loadConfig({ VAULT_PATH: ".", MCP_HTTP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: "secret" }, []).mcpAuthToken).toBe("secret");
  });

  it("rejects invalid http path", () => {
    expect(() => loadConfig({ VAULT_PATH: ".", MCP_HTTP_PATH: "mcp" }, [])).toThrow(/MCP_HTTP_PATH must start with/);
  });
});

describe("parseCliArgs", () => {
  it("supports standalone flags and repeated scopes", () => {
    expect(parseCliArgs(["--vault", "C:/Vault", "--read-only", "--read-path=Notes", "--read-path", "Projects", "--index-mode=indexed", "--watch-mode", "off"])).toEqual({
      VAULT_PATH: "C:/Vault", READ_ONLY: "true", READ_PATHS: "Notes,Projects", INDEX_MODE: "indexed", WATCH_MODE: "off",
    });
  });

  it("supports compatibility and transport flags", () => {
    expect(parseCliArgs(["--backend=local-rest", "--api-key", "abc", "--http", "--port=9999"])).toEqual({ BACKEND: "local-rest", OBSIDIAN_API_KEY: "abc", MCP_TRANSPORT: "http", MCP_HTTP_PORT: "9999" });
  });

  it("supports colorful log flags", () => {
    expect(parseCliArgs(["--colorful"])).toEqual({ COLORFUL_LOGS: "true" });
    expect(loadConfig({ VAULT_PATH: "." }, ["--colorful"]).colorfulLogs).toBe(true);
  });
});

async function createTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-config-"));
  tempDirs.push(directory);
  return directory;
}

async function createVault(root: string, name: string): Promise<string> {
  const vault = path.join(root, name);
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  return vault;
}

async function createRegistry(root: string, vaults: Record<string, { path: string; open: boolean }>): Promise<{ environment: NodeJS.ProcessEnv }> {
  const registryPath = registryFilePath(root);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify({ vaults }), "utf8");
  return { environment: registryEnvironment(root) };
}

function registryFilePath(root: string): string {
  if (process.platform === "win32") return path.join(root, "AppData", "obsidian", "obsidian.json");
  if (process.platform === "darwin") return path.join(root, "Library", "Application Support", "obsidian", "obsidian.json");
  return path.join(root, "config", "obsidian", "obsidian.json");
}

function registryEnvironment(root: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") return { APPDATA: path.join(root, "AppData") };
  if (process.platform === "darwin") return { HOME: root };
  return { XDG_CONFIG_HOME: path.join(root, "config") };
}
