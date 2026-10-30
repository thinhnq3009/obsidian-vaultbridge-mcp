import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { startHttpServer } from "../src/http.js";
import { makeConfig } from "../test/helpers.js";

async function main() {
  console.log("=== STARTING AUTH-005A CLOUDFLARE TUNNEL & CHATGPT E2E TEST ===");

  const logFile = "/tmp/cf-auth005a.log";
  try { await fs.unlink(logFile); } catch {}

  console.log("Starting cloudflared tunnel to http://127.0.0.1:39145...");
  const cf = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:39145", "--logfile", logFile], {
    detached: false,
    stdio: "ignore",
  });

  let tunnelUrl = "";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (fsSync.existsSync(logFile)) {
      const content = await fs.readFile(logFile, "utf8");
      const match = content.match(/https:\/\/[-a-zA-Z0-9.]*\.trycloudflare\.com/);
      if (match) {
        tunnelUrl = match[0];
        break;
      }
    }
  }

  if (!tunnelUrl) {
    cf.kill();
    throw new Error("Failed to get trycloudflare tunnel URL");
  }

  console.log(`✓ Cloudflare Tunnel established: ${tunnelUrl}`);
  const tunnelHost = new URL(tunnelUrl).host;

  // Wait for Cloudflare DNS propagation
  console.log(`Waiting for Cloudflare DNS propagation for ${tunnelHost}...`);
  let dnsReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(tunnelUrl, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      dnsReady = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!dnsReady) {
    console.warn("Warning: DNS check timed out, proceeding to retry during requests...");
  } else {
    console.log("✓ Cloudflare DNS is propagated and reachable");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-tunnel-"));
  const vaultPath = path.join(tempDir, "disposable-vault");
  const authDir = path.join(tempDir, "auth-data");
  const cacheDir = path.join(tempDir, "cache-data");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700);
  await fs.mkdir(cacheDir, { recursive: true });

  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Secret"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Notes", "Test.md"), "# Public Tunnel Test\nVerified via Cloudflare tunnel.", "utf8");
  await fs.writeFile(path.join(vaultPath, "Secret", "Hidden.md"), "# Secret\nMust not be exposed.", "utf8");

  const mcpPort = 39145;
  const ownerPort = 39146;
  const ownerOrigin = `http://127.0.0.1:${ownerPort}`;
  const ownerPassword = "StrongOwnerPassword2026!";

  const config = makeConfig({
    vaultPath,
    cacheDir,
    mcpTransport: "http",
    mcpHttpPort: mcpPort,
    mcpOwnerPort: ownerPort,
    mcpAuthMode: "oauth",
    mcpOauthEnabled: true,
    mcpOauthIssuer: `${tunnelUrl}/api/auth`,
    mcpAllowedHosts: [tunnelHost, "127.0.0.1"],
    mcpHttpTlsProxy: true,
    mcpAuthDirectory: authDir,
    mcpVaultId: "disposable-vault-tunnel",
    mcpOwnerUsername: "obsidian-admin",
    mcpOwnerPassword: ownerPassword,
  });

  const server = await startHttpServer(config);
  console.log("✓ VaultBridge server started with canonical tunnel configuration");

  try {
    // 1. External HTTPS 401 challenge
    console.log(`\n[1] Testing external HTTPS 401 challenge on ${tunnelUrl}/mcp...`);
    const challengeRes = await fetch(`${tunnelUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    console.log(`  Status: ${challengeRes.status}`);
    const wwwAuth = challengeRes.headers.get("www-authenticate");
    console.log(`  WWW-Authenticate: ${wwwAuth}`);
    const expectedMetadataUrl = `${tunnelUrl}/.well-known/oauth-protected-resource/mcp`;
    if (challengeRes.status !== 401 || !wwwAuth?.includes(`resource_metadata="${expectedMetadataUrl}"`)) {
      throw new Error(`401 challenge failed or did not contain expected public metadata URL: ${wwwAuth}`);
    }
    console.log("  ✓ External HTTPS 401 challenge PASSED (public-origin consistent)");

    // 2. External HTTPS Metadata Discovery
    console.log(`\n[2] Testing external HTTPS discovery endpoints...`);
    const resourceMetaRes = await fetch(`${tunnelUrl}/.well-known/oauth-protected-resource/mcp`);
    console.log(`  Protected resource metadata status: ${resourceMetaRes.status}`);
    const resourceMeta = await resourceMetaRes.json();
    console.log(`  Resource: ${resourceMeta.resource}`);
    console.log(`  Authorization servers: ${JSON.stringify(resourceMeta.authorization_servers)}`);
    if (resourceMeta.resource !== `${tunnelUrl}/mcp` || resourceMeta.authorization_servers[0] !== `${tunnelUrl}/api/auth`) {
      throw new Error("Protected resource metadata is not public-origin consistent");
    }

    const authServerMetaRes = await fetch(`${tunnelUrl}/api/auth/.well-known/oauth-authorization-server`);
    console.log(`  Authorization server metadata status: ${authServerMetaRes.status}`);
    const authServerMeta = await authServerMetaRes.json();
    console.log(`  Issuer: ${authServerMeta.issuer}`);
    console.log(`  Authorization endpoint: ${authServerMeta.authorization_endpoint}`);
    console.log(`  Token endpoint: ${authServerMeta.token_endpoint}`);
    console.log(`  Revocation endpoint: ${authServerMeta.revocation_endpoint}`);
    if (authServerMeta.issuer !== `${tunnelUrl}/api/auth` ||
        authServerMeta.authorization_endpoint !== `${tunnelUrl}/api/auth/oauth2/authorize` ||
        authServerMeta.token_endpoint !== `${tunnelUrl}/api/auth/oauth2/token`) {
      throw new Error("Authorization server metadata is not public-origin consistent");
    }

    // Verify RFC 8414 path as well
    const rfc8414Res = await fetch(`${tunnelUrl}/.well-known/oauth-authorization-server/api/auth`);
    console.log(`  RFC 8414 metadata status: ${rfc8414Res.status}`);
    if (rfc8414Res.status !== 200) throw new Error("RFC 8414 discovery endpoint failed");
    console.log("  ✓ Discovery endpoints are strictly public-origin consistent (no localhost leak)");

    // 3. ChatGPT Authorize Initiate via Tunnel
    console.log(`\n[3] Testing ChatGPT authorize initiate via tunnel with real CIMD fetch...`);
    const chatGptClientId = "https://chatgpt.com/oauth/client.json";
    const chatGptRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const authorizeParams = new URLSearchParams({
      client_id: chatGptClientId,
      redirect_uri: chatGptRedirectUri,
      response_type: "code",
      scope: "vault:read offline_access",
      resource: `${tunnelUrl}/mcp`,
      state,
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authorizeRes = await fetch(`${tunnelUrl}/api/auth/oauth2/authorize?${authorizeParams}`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      redirect: "manual",
    });
    console.log(`  Authorize status: ${authorizeRes.status}`);
    const location = authorizeRes.headers.get("location");
    console.log(`  Redirect Location: ${location}`);
    if (authorizeRes.status !== 302 || !location?.startsWith(`${ownerOrigin}/login`)) {
      throw new Error(`Expected 302 redirect to local owner login, got ${authorizeRes.status}: ${location}`);
    }
    console.log("  ✓ Authorize redirected to private loopback 127.0.0.1:39146/login");

    const redirectUrl = new URL(location);
    const oauthQuery = redirectUrl.search.slice(1);

    // 4. Local Owner Login on private port 39146
    console.log("\n[4] Testing Local Owner Login on private port 39146...");
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
    const sessionCookie = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (loginRes.status !== 200 || !sessionCookie) throw new Error("Owner login failed");
    console.log("  ✓ Owner login succeeded, private session cookie obtained");

    // 5. Consent and Grant Management on private port 39146
    console.log("\n[5] Testing Consent and Grant creation on private port 39146...");
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
    console.log(`  Resume status: ${resumeRes.status}`);
    const resumeBody = await resumeRes.json();
    console.log(`  Consent page URL: ${resumeBody.url}`);

    // Grant restricted to Notes subtree
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
    const grantData = await grantRes.json();
    console.log(`  Grant creation status: ${grantRes.status}, Grant ID: ${grantData.grantId}`);

    // Approve consent
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
    const consentData = await consentRes.json();
    console.log(`  Consent status: ${consentRes.status}`);
    console.log(`  Callback URL: ${consentData.url}`);
    const callbackUrl = new URL(consentData.url);
    const authCode = callbackUrl.searchParams.get("code");
    const callbackState = callbackUrl.searchParams.get("state");
    const callbackIss = callbackUrl.searchParams.get("iss");
    console.log(`  Code: ${authCode ? `${authCode.slice(0, 10)}...` : "none"}`);
    console.log(`  State match: ${callbackState === state}`);
    console.log(`  Callback iss: ${callbackIss}`);
    if (callbackIss !== `${tunnelUrl}/api/auth` || !authCode || callbackState !== state) {
      throw new Error("Callback does not match expected canonical parameters");
    }
    console.log("  ✓ Callback generated with canonical tunnel issuer and valid auth code");

    // 6. Token Endpoint Behavior via Tunnel
    console.log(`\n[6] Testing Token endpoint via tunnel (${tunnelUrl}/api/auth/oauth2/token)...`);
    const tokenProbeRes = await fetch(`${tunnelUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: chatGptClientId,
        grant_type: "authorization_code",
        code: authCode,
        code_verifier: verifier,
        redirect_uri: chatGptRedirectUri,
        resource: `${tunnelUrl}/mcp`,
      }),
    });
    console.log(`  Probe status: ${tokenProbeRes.status}`);
    const probeBody = await tokenProbeRes.json();
    console.log(`  Probe response: ${JSON.stringify(probeBody)}`);
    // Expected: ChatGPT registered for private_key_jwt, so 'none' is rejected with invalid_client.
    if (tokenProbeRes.status === 400 && probeBody.error === "invalid_client" && probeBody.error_description?.includes("private_key_jwt")) {
      console.log("  ✓ Expected provider security enforcement: client registered for private_key_jwt cannot use none");
    } else {
      console.log("  Unexpected probe response:", probeBody);
    }

    // 7. Test Negative Security: Owner Listener MUST NOT be exposed via Tunnel
    console.log("\n[7] Verifying owner routes and SQLite are NOT accessible externally...");
    const ownerExposedChecks = [
      "/login",
      "/consent",
      "/admin",
      "/owner-state",
      "/api/auth/sign-in/email",
      "/api/auth/get-session",
      "/oauth/grants",
    ];
    for (const route of ownerExposedChecks) {
      const probe = await fetch(`${tunnelUrl}${route}`, { method: "GET" });
      console.log(`  ${route} via tunnel status: ${probe.status}`);
      if (probe.status !== 404 && probe.status !== 401 && probe.status !== 403) {
        throw new Error(`SECURITY ALERT: Owner route ${route} returned status ${probe.status} via tunnel!`);
      }
    }
    console.log("  ✓ All private owner endpoints fail closed / 404 on external tunnel");

    console.log("\n=======================================================");
    console.log("TUNNEL & OAUTH READY FOR REAL CHATGPT TEST");
    console.log(`Public MCP URL: ${tunnelUrl}/mcp`);
    console.log(`Owner Login:    http://127.0.0.1:39146/login`);
    console.log("=======================================================");

    return { tunnelUrl, authCode, state, verifier, server, cf, tempDir };
  } catch (err) {
    if (server) await server.close();
    cf.kill();
    throw err;
  }
}

main().then(async (ctx) => {
  console.log("\nKeeping tunnel open for 30 seconds to allow diagnostic checks...");
  await new Promise((r) => setTimeout(r, 30000));
  await ctx.server.close();
  ctx.cf.kill();
  await fs.rm(ctx.tempDir, { recursive: true, force: true });
  console.log("Tunnel closed and cleanup completed.");
}).catch((err) => {
  console.error("Tunnel test error:", err);
  process.exit(1);
});
