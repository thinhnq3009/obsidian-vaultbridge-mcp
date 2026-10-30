import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpServer } from "../src/http.js";
import { makeConfig } from "../test/helpers.js";

async function runLocalE2E() {
  console.log("=== STARTING AUTH-005A LOCAL E2E VERIFICATION (PORTS 39145 / 39146) ===");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-auth005a-"));
  const vaultPath = path.join(tempDir, "disposable-vault");
  const authDir = path.join(tempDir, "auth-data");
  const cacheDir = path.join(tempDir, "cache-data");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700);
  await fs.mkdir(cacheDir, { recursive: true });

  // Create notes in allowed and denied subtrees
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Secret"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Notes", "Welcome.md"), "# Welcome\nThis is permitted content in Notes.", "utf8");
  await fs.writeFile(path.join(vaultPath, "Secret", "Confidential.md"), "# Confidential\nThis is restricted content in Secret.", "utf8");

  const mcpPort = 39145;
  const ownerPort = 39146;
  const publicOrigin = `http://127.0.0.1:${mcpPort}`;
  const ownerOrigin = `http://127.0.0.1:${ownerPort}`;
  const ownerPassword = "DisposablePassword123!";

  console.log(`Disposable vault: ${vaultPath}`);
  console.log(`Public MCP: ${publicOrigin}`);
  console.log(`Private owner: ${ownerOrigin}`);

  const config = makeConfig({
    vaultPath,
    cacheDir,
    mcpTransport: "http",
    mcpHttpPort: mcpPort,
    mcpOwnerPort: ownerPort,
    mcpAuthMode: "oauth",
    mcpOauthEnabled: true,
    mcpOauthIssuer: `${publicOrigin}/api/auth`,
    mcpAuthDirectory: authDir,
    mcpVaultId: "disposable-vault-auth005a",
    mcpAllowedHosts: ["127.0.0.1"],
    mcpOwnerUsername: "obsidian-admin",
    mcpOwnerPassword: ownerPassword,
  });

  const server = await startHttpServer(config);
  console.log("✓ Server started successfully on ports 39145 (MCP/OAuth) and 39146 (owner)");

  try {
    // 1. 401 Challenge
    console.log("\n[1] Testing 401 WWW-Authenticate challenge on /mcp...");
    const challengeRes = await fetch(`${publicOrigin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })
    });
    console.log(`  Response status: ${challengeRes.status}`);
    const wwwAuth = challengeRes.headers.get("www-authenticate");
    console.log(`  WWW-Authenticate: ${wwwAuth}`);
    if (challengeRes.status !== 401 || !wwwAuth || !wwwAuth.includes("resource_metadata=")) {
      throw new Error(`401 challenge failed: status=${challengeRes.status}, wwwAuth=${wwwAuth}`);
    }
    console.log("  ✓ 401 Challenge PASSED");

    // 2. Discovery
    console.log("\n[2] Testing OAuth discovery endpoints...");
    const resourceMetaRes = await fetch(`${publicOrigin}/.well-known/oauth-protected-resource/mcp`);
    console.log(`  Protected resource metadata status: ${resourceMetaRes.status}`);
    const resourceMeta = await resourceMetaRes.json();
    console.log(`  Resource: ${resourceMeta.resource}`);
    console.log(`  Authorization servers: ${JSON.stringify(resourceMeta.authorization_servers)}`);
    if (resourceMetaRes.status !== 200 || resourceMeta.resource !== `${publicOrigin}/mcp`) {
      throw new Error("Protected resource metadata check failed");
    }

    const authServerUrl = resourceMeta.authorization_servers[0];
    const authServerMetaRes = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
    console.log(`  Authorization server metadata status: ${authServerMetaRes.status}`);
    const authServerMeta = await authServerMetaRes.json();
    console.log(`  Issuer: ${authServerMeta.issuer}`);
    console.log(`  Token endpoint: ${authServerMeta.token_endpoint}`);
    console.log(`  Code challenge methods: ${JSON.stringify(authServerMeta.code_challenge_methods_supported)}`);
    if (authServerMetaRes.status !== 200 || !authServerMeta.code_challenge_methods_supported.includes("S256")) {
      throw new Error("Authorization server metadata check failed");
    }
    console.log("  ✓ Discovery PASSED");

    // 3. Authorization initiate (PKCE)
    console.log("\n[3] Testing OAuth authorize initiate (PKCE S256)...");
    const clientId = "https://chatgpt.com/oauth/client.json";
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const authorizeParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "vault:read offline_access",
      resource: `${publicOrigin}/mcp`,
      state,
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    // Test with browser Accept header (text/html) -> expect 302 redirect to owner port 39146
    const authorizeRes = await fetch(`${publicOrigin}/api/auth/oauth2/authorize?${authorizeParams}`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      redirect: "manual",
    });
    console.log(`  Authorize status: ${authorizeRes.status}`);
    const location = authorizeRes.headers.get("location");
    console.log(`  Redirect location: ${location}`);
    if (authorizeRes.status !== 302 || !location || !location.startsWith(`${ownerOrigin}/login`)) {
      console.log("  Authorize body:", await authorizeRes.text());
      throw new Error(`Authorize redirect failed: status=${authorizeRes.status}, location=${location}`);
    }
    console.log("  ✓ Authorize redirect to private owner 39146 PASSED");

    const redirectUrl = new URL(location);
    const oauthQuery = redirectUrl.search.slice(1);

    // 4. Owner Login on private port 39146
    console.log("\n[4] Testing Owner Login on 127.0.0.1:39146...");
    const loginRes = await fetch(`${ownerOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: ownerOrigin,
      },
      body: JSON.stringify({ username: "obsidian-admin", password: ownerPassword }),
    });
    console.log(`  Login status: ${loginRes.status}`);
    const cookies = loginRes.headers.getSetCookie();
    const sessionCookie = cookies.map((c) => c.split(";")[0]).join("; ");
    console.log(`  Session cookie received: ${Boolean(sessionCookie)}`);
    if (loginRes.status !== 200 || !sessionCookie) {
      throw new Error(`Owner login failed: status=${loginRes.status}`);
    }
    console.log("  ✓ Owner Login PASSED");

    // 5. Consent and Grant Creation on private port 39146
    console.log("\n[5] Testing Consent and Grant creation...");
    const resumeRes = await fetch(`${ownerOrigin}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: ownerOrigin,
        cookie: sessionCookie,
      },
      body: JSON.stringify({ oauth_query: oauthQuery }),
    });
    console.log(`  Resume authorize status: ${resumeRes.status}`);
    const resumeBody = await resumeRes.json();
    console.log(`  Consent target URL: ${resumeBody.url}`);

    // Create scoped grant: Notes subtree only!
    const grantRes = await fetch(`${ownerOrigin}/oauth/grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: ownerOrigin,
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        oauth_query: oauthQuery,
        principalPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"] }],
        clientPermissions: [{ path: "Notes", actions: ["readNote", "listFiles"], tools: ["obsidian_read_note", "obsidian_list_files"] }],
      }),
    });
    console.log(`  Grant creation status: ${grantRes.status}`);
    const grantBody = await grantRes.json();
    console.log(`  Grant ID: ${grantBody.grantId}`);

    // Consent approval
    const consentRes = await fetch(`${ownerOrigin}/oauth/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: ownerOrigin,
        cookie: sessionCookie,
      },
      body: JSON.stringify({ oauth_query: oauthQuery, accept: true }),
    });
    console.log(`  Consent status: ${consentRes.status}`);
    const consentBody = await consentRes.json();
    console.log(`  Callback URL: ${consentBody.url}`);
    const callbackUrl = new URL(consentBody.url);
    const authCode = callbackUrl.searchParams.get("code");
    const callbackState = callbackUrl.searchParams.get("state");
    const callbackIss = callbackUrl.searchParams.get("iss");
    console.log(`  Authorization Code: ${authCode ? `${authCode.slice(0, 10)}...` : "null"}`);
    console.log(`  State matches: ${callbackState === state}`);
    console.log(`  Issuer: ${callbackIss}`);
    if (consentRes.status !== 200 || !authCode || callbackState !== state || callbackIss !== `${publicOrigin}/api/auth`) {
      throw new Error("Consent flow failed to produce valid callback parameters");
    }
    console.log("  ✓ Consent and callback generation PASSED");

    // 6. Token Exchange (Public Port 39145)
    console.log("\n[6] Testing Token Exchange on public port 39145...");
    const tokenRes = await fetch(`${publicOrigin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        resource: `${publicOrigin}/mcp`,
      }),
    });
    console.log(`  Token exchange status: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();
    console.log(`  Access token received: ${Boolean(tokenData.access_token)}`);
    console.log(`  Refresh token received: ${Boolean(tokenData.refresh_token)}`);
    console.log(`  Token type: ${tokenData.token_type}`);
    console.log(`  Expires in: ${tokenData.expires_in} seconds`);
    if (tokenRes.status !== 200 || !tokenData.access_token || !tokenData.refresh_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }
    console.log("  ✓ Token exchange PASSED");

    // 7. MCP Tool Call (Public Port 39145)
    console.log("\n[7] Testing MCP Tool Calls with OAuth Bearer Token...");
    const mcpClient = new Client({ name: "auth005a-local-e2e-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${tokenData.access_token}`,
        },
      },
    });
    await mcpClient.connect(transport);
    console.log("  ✓ Connected to MCP server");

    // 7a. Allowed note read
    console.log("  [7a] Reading allowed note (Notes/Welcome.md)...");
    const allowedRead = await mcpClient.callTool({
      name: "obsidian_read_note",
      arguments: { path: "Notes/Welcome.md" },
    });
    console.log(`  Allowed read error: ${allowedRead.isError ?? false}`);
    console.log(`  Allowed read content: ${JSON.stringify(allowedRead.content)}`);
    if (allowedRead.isError || !JSON.stringify(allowedRead.content).includes("permitted content")) {
      throw new Error("Allowed note read failed");
    }
    console.log("  ✓ Allowed note read PASSED");

    // 7b. Denied note read
    console.log("  [7b] Reading denied note (Secret/Confidential.md)...");
    const deniedRead = await mcpClient.callTool({
      name: "obsidian_read_note",
      arguments: { path: "Secret/Confidential.md" },
    });
    console.log(`  Denied read isError: ${deniedRead.isError}`);
    if (!deniedRead.isError) {
      throw new Error("Denied note read should have failed with error!");
    }
    console.log("  ✓ Denied note read correctly rejected PASSED");

    // 7c. Denied tool (write not granted)
    console.log("  [7c] Attempting ungranted tool (obsidian_write_note)...");
    const deniedWrite = await mcpClient.callTool({
      name: "obsidian_write_note",
      arguments: { path: "Notes/Welcome.md", content: "forbidden overwrite" },
    });
    console.log(`  Denied write isError: ${deniedWrite.isError}`);
    if (!deniedWrite.isError) {
      throw new Error("Ungranted write should have failed with error!");
    }
    console.log("  ✓ Ungranted tool correctly rejected PASSED");

    // 8. Refresh Token Exchange
    console.log("\n[8] Testing Refresh Token on public port 39145...");
    const refreshRes = await fetch(`${publicOrigin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token,
        resource: `${publicOrigin}/mcp`,
      }),
    });
    console.log(`  Refresh status: ${refreshRes.status}`);
    const refreshData = await refreshRes.json();
    console.log(`  New access token: ${Boolean(refreshData.access_token)}`);
    console.log(`  New refresh token: ${Boolean(refreshData.refresh_token)}`);
    console.log(`  Rotated refresh token matches old: ${refreshData.refresh_token === tokenData.refresh_token}`);
    if (refreshRes.status !== 200 || !refreshData.access_token || refreshData.refresh_token === tokenData.refresh_token) {
      throw new Error("Refresh token exchange failed or did not rotate");
    }
    console.log("  ✓ Refresh token rotation PASSED");

    // Verify new token works for MCP
    await mcpClient.close();
    const refreshedClient = new Client({ name: "auth005a-refreshed-client", version: "1.0.0" });
    const refreshedTransport = new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${refreshData.access_token}` } },
    });
    await refreshedClient.connect(refreshedTransport);
    const refreshedRead = await refreshedClient.callTool({
      name: "obsidian_read_note",
      arguments: { path: "Notes/Welcome.md" },
    });
    if (refreshedRead.isError) throw new Error("Refreshed access token failed MCP tool call");
    console.log("  ✓ Refreshed token MCP tool call PASSED");
    await refreshedClient.close();

    // 9. Revocation
    console.log("\n[9] Testing Revocation...");
    // 9a. Revoke grant
    const revokeGrantRes = await fetch(`${ownerOrigin}/oauth/grants/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vaultbridge-csrf": "1",
        origin: ownerOrigin,
        cookie: sessionCookie,
      },
      body: JSON.stringify({ grantId: grantBody.grantId }),
    });
    console.log(`  Revoke grant status: ${revokeGrantRes.status}`);
    if (revokeGrantRes.status !== 200) throw new Error("Grant revocation failed");

    // Check MCP call with revoked grant
    const revokedClient = new Client({ name: "auth005a-revoked-client", version: "1.0.0" });
    const revokedTransport = new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${refreshData.access_token}` } },
    });
    let callFailed = false;
    try {
      await revokedClient.connect(revokedTransport);
      const res = await revokedClient.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/Welcome.md" } });
      if (res.isError) callFailed = true;
    } catch {
      callFailed = true;
    }
    console.log(`  MCP call after grant revocation rejected: ${callFailed}`);
    if (!callFailed) throw new Error("MCP call should have been rejected after grant revocation");
    console.log("  ✓ Revocation enforcement PASSED");

    console.log("\n=== AUTH-005A LOCAL E2E VERIFICATION COMPLETED SUCCESSFULLY ===");
  } finally {
    await server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

runLocalE2E().catch((err) => {
  console.error("FATAL ERROR in local E2E:", err);
  process.exit(1);
});
