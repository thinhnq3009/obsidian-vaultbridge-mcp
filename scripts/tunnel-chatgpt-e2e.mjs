import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";

import { startHttpServer } from "../src/http.js";
import { makeConfig } from "../test/helpers.js";
import { runE2E } from "./e2eLifecycle.js";
import { verifyNativeFlow } from "./e2eNativeFlow.js";
import { verifyDiscovery } from "./e2eDiscovery.js";

async function main(lifecycle) {
  const fetch = lifecycle.fetch;
  console.log("=== STARTING AUTH-005A CLOUDFLARE TUNNEL & CHATGPT E2E TEST ===");

  const mcpPort = Number(process.env.MCP_PORT) || 39145;
  const ownerPort = Number(process.env.OWNER_PORT) || 39146;
  const ownerOrigin = `http://127.0.0.1:${ownerPort}`;
  const ownerPassword = "StrongOwnerPassword2026!";

  let tunnelUrl = process.env.TUNNEL_URL?.trim() || "";

  if (!tunnelUrl) {
    console.log(`Starting cloudflared tunnel to http://127.0.0.1:${mcpPort}...`);
    const cf = lifecycle.useChild(spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${mcpPort}`], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    }));

    tunnelUrl = await new Promise((resolve, reject) => {
      const finish = (error, url) => {
        clearTimeout(timer);
        cf.stdout?.off("data", onData);
        cf.stderr?.off("data", onData);
        cf.off("error", onError);
        cf.off("exit", onExit);
        lifecycle.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(url);
      };
      const onError = (error) => finish(error);
      const onExit = (code) => finish(new Error(`cloudflared exited before URL discovery with code ${code}`));
      const onAbort = () => finish(lifecycle.signal.reason);
      const timer = setTimeout(() => {
        finish(new Error("Timeout waiting for trycloudflare tunnel URL from process stdio"));
      }, 30000);

      let output = "";
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(/https:\/\/[-a-zA-Z0-9.]*\.trycloudflare\.com/);
        if (match) {
          finish(null, match[0]);
        }
      };

      cf.stdout?.on("data", onData);
      cf.stderr?.on("data", onData);
      cf.once("error", onError);
      cf.once("exit", onExit);
      lifecycle.signal.addEventListener("abort", onAbort, { once: true });
      if (lifecycle.signal.aborted) onAbort();
    });
    cf.once("error", (error) => { lifecycle.controller.abort(error); });
    cf.once("exit", (code, signal) => {
      lifecycle.controller.abort(new Error(`cloudflared exited unexpectedly: ${code ?? signal}`));
    });
  }

  const parsedTunnel = new URL(tunnelUrl);
  if (parsedTunnel.protocol !== "https:" || !parsedTunnel.hostname.endsWith(".trycloudflare.com")) {
    throw new Error(`Invalid or untrusted tunnel URL: ${tunnelUrl}`);
  }

  console.log(`✓ Cloudflare Tunnel established: ${tunnelUrl}`);
  const tunnelHost = parsedTunnel.host;

  // Wait for Cloudflare DNS propagation
  console.log(`Waiting for Cloudflare DNS propagation for ${tunnelHost}...`);
  let dnsReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(tunnelUrl, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      dnsReady = true;
      break;
    } catch {
      await lifecycle.wait(1000);
    }
  }
  if (!dnsReady) {
    console.warn("Warning: DNS check timed out, proceeding to retry during requests...");
  } else {
    console.log("✓ Cloudflare DNS is propagated and reachable");
  }

  const tempDir = lifecycle.useDirectory(await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-tunnel-")));
  console.log(`Disposable resources: ${tempDir}`);
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

  lifecycle.useServer(await startHttpServer(config));
  lifecycle.signal.throwIfAborted();
  console.log("✓ VaultBridge server started with canonical tunnel configuration");

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

  // 2. Validate protected-resource metadata and both authorization aliases.
  await verifyDiscovery(fetch, tunnelUrl, ownerOrigin);
  console.log("  ✓ Both discovery aliases use the canonical public origin with no owner leak");

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
  console.log(`  Redirect Location: ${location?.split(/[?#]/, 1)[0]}`);
  if (authorizeRes.status !== 302 || !location?.startsWith(`${ownerOrigin}/login`)) {
    throw new Error(`Expected 302 redirect to local owner login, got ${authorizeRes.status}: ${location?.split(/[?#]/, 1)[0]}`);
  }
  console.log(`  ✓ Authorize redirected to private loopback 127.0.0.1:${ownerPort}/login`);

  const redirectUrl = new URL(location);
  const oauthQuery = redirectUrl.search.slice(1);

  // 4. Local Owner Login on private port 39146
  console.log(`\n[4] Testing Local Owner Login on private port ${ownerPort}...`);
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
  console.log(`\n[5] Testing Consent and Grant creation on private port ${ownerPort}...`);
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
  if (resumeRes.status !== 200) throw new Error(`Resume failed: ${resumeRes.status}`);
  const resumeBody = await resumeRes.json();
  console.log(`  Consent page URL: ${resumeBody.url?.split(/[?#]/, 1)[0]}`);

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
  if (grantRes.status !== 200) throw new Error(`Grant failed: ${grantRes.status}`);
  const grantData = await grantRes.json();
  if (!grantData.grantId) throw new Error("Missing grant ID");
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
  if (consentRes.status !== 200) throw new Error(`Consent failed: ${consentRes.status}`);
  const consentData = await consentRes.json();
  console.log(`  Consent status: ${consentRes.status}`);
  console.log(`  Callback destination: ${new URL(consentData.url).origin}${new URL(consentData.url).pathname}`);
  const callbackUrl = new URL(consentData.url);
  const authCode = callbackUrl.searchParams.get("code");
  const callbackState = callbackUrl.searchParams.get("state");
  const callbackIss = callbackUrl.searchParams.get("iss");
  console.log(`  Code: ${authCode ? "received (redacted)" : "none"}`);
  console.log(`  State match: ${callbackState === state}`);
  console.log(`  Callback iss: ${callbackIss}`);
  if (callbackUrl.origin + callbackUrl.pathname !== chatGptRedirectUri || callbackIss !== `${tunnelUrl}/api/auth` || !authCode || callbackState !== state) {
    throw new Error("Callback does not match expected canonical parameters");
  }
  console.log("  ✓ Callback generated with canonical tunnel issuer and valid auth code");

  // 6. Token Endpoint private_key_jwt Enforcement via Tunnel
  console.log(`\n[6] Testing Token endpoint via tunnel (${tunnelUrl}/api/auth/oauth2/token)...`);

  // 6a. Negative test: 'none' auth method rejected
  const tokenProbeNone = await fetch(`${tunnelUrl}/api/auth/oauth2/token`, {
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
  console.log(`  Token 'none' probe status: ${tokenProbeNone.status}`);
  const noneBody = await tokenProbeNone.json();
  console.log(`  Token 'none' response: ${JSON.stringify(noneBody)}`);
  if (tokenProbeNone.status !== 400 || noneBody.error !== "invalid_client" || !noneBody.error_description?.includes("private_key_jwt")) {
    throw new Error(`Expected invalid_client for 'none' auth method, got status ${tokenProbeNone.status}: ${JSON.stringify(noneBody)}`);
  }
  console.log("  ✓ Expected provider security enforcement: client registered for private_key_jwt cannot use none");

  // 6b. Negative test: Forged/untrusted RS256 client assertion rejected
  const { privateKey: untrustedKey } = await generateKeyPair("RS256");
  const forgedAssertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "untrusted-key-id" })
    .setIssuer(chatGptClientId)
    .setSubject(chatGptClientId)
    .setAudience([`${tunnelUrl}/api/auth/oauth2/token`])
    .setJti(randomBytes(16).toString("hex"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(untrustedKey);

  const forgedRes = await fetch(`${tunnelUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: chatGptClientId,
      grant_type: "authorization_code",
      code: authCode,
      code_verifier: verifier,
      redirect_uri: chatGptRedirectUri,
      resource: `${tunnelUrl}/mcp`,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: forgedAssertion,
    }),
  });
  console.log(`  Forged assertion probe status: ${forgedRes.status}`);
  const forgedBody = await forgedRes.json();
  if (![400, 401].includes(forgedRes.status) || forgedBody.error !== "invalid_client" ||
      forgedBody.error_description !== "client assertion signature verification failed") {
    throw new Error(`Expected 400/401 for forged client assertion, got ${forgedRes.status}`);
  }
  console.log("  ✓ Untrusted client assertion correctly rejected fail-closed (not in ChatGPT JWKS)");

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
    if (probe.status !== 404 && probe.status !== 401 && probe.status !== 403) {
      throw new Error(`SECURITY ALERT: Owner route ${route} returned status ${probe.status} via tunnel!`);
    }
  }
  console.log("  ✓ All private owner endpoints fail closed / 404 on external tunnel");

  // 8. Negative Security Controls on Local and Public Listeners
  console.log("\n[8] Testing listener security boundaries (CSRF, Origin, Compression)...");

  // 8a. Owner route missing CSRF header
  const noCsrfRes = await fetch(`${ownerOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ownerOrigin },
    body: JSON.stringify({ username: "obsidian-admin", password: ownerPassword }),
  });
  console.log(`  Owner listener without CSRF header status: ${noCsrfRes.status} (expected 403)`);
  if (noCsrfRes.status !== 403) throw new Error(`Expected 403 for missing CSRF header, got ${noCsrfRes.status}`);

  // 8b. Owner route untrusted Origin
  const badOwnerOriginRes = await fetch(`${ownerOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vaultbridge-csrf": "1", origin: "https://evil.example" },
    body: JSON.stringify({ username: "obsidian-admin", password: ownerPassword }),
  });
  console.log(`  Owner listener with untrusted Origin status: ${badOwnerOriginRes.status} (expected 403)`);
  if (badOwnerOriginRes.status !== 403) throw new Error(`Expected 403 for untrusted Origin, got ${badOwnerOriginRes.status}`);

  // 8c. Public tunnel cross-site Origin
  const crossOriginRes = await fetch(`${tunnelUrl}/mcp`, {
    method: "POST",
    headers: { origin: "https://evil-attacker.example", "content-type": "application/json" },
    body: "{}",
  });
  console.log(`  Public tunnel with cross-site Origin status: ${crossOriginRes.status} (expected 403)`);
  if (crossOriginRes.status !== 403) throw new Error(`Expected 403 for cross-site Origin, got ${crossOriginRes.status}`);

  // 8d. Public tunnel compressed body ban (Content-Encoding != identity)
  const compressedRes = await fetch(`${tunnelUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-encoding": "gzip",
    },
    body: "grant_type=authorization_code",
  });
  console.log(`  Public tunnel with compressed body status: ${compressedRes.status} (expected 415)`);
  if (compressedRes.status !== 415) throw new Error(`Expected 415 for compressed body, got ${compressedRes.status}`);

  console.log("  ✓ Boundary controls PASSED");

  // Positive client traffic must actually traverse the public HTTPS tunnel.
  await verifyNativeFlow({
    lifecycle, authDirectory: authDir, publicOrigin: tunnelUrl, ownerOrigin, cookie: sessionCookie,
    notePath: "Notes/Test.md", deniedPath: "Secret/Hidden.md", expectedContent: "Verified via Cloudflare tunnel",
  });

  // Summary Report
  console.log("\n======================================================================");
  console.log("AUTH-005A TUNNEL & CHATGPT E2E VERIFICATION STATUS");
  console.log("======================================================================");
  console.log("401 WWW-Authenticate Challenge:           PASS");
  console.log("Public-Origin Consistent Discovery:        PASS");
  console.log(`Authorize 302 Redirect to Loopback:        PASS (http://127.0.0.1:${ownerPort}/login)`);
  console.log("Local Owner Sign-In & Scoped Consent:      PASS");
  console.log("ChatGPT-shaped authorize/callback:         PASS (provider diagnostic, not a real client)");
  console.log("Enforce RFC 7523 private_key_jwt:          PASS (client cannot use 'none')");
  console.log("Reject Forged Client Assertion:            PASS (untrusted key fails closed)");
  console.log(`Private Owner Port ${ownerPort} Isolation:        PASS (never exposed externally)`);
  console.log("CSRF & Origin Defense on Owner Port:       PASS");
  console.log("Origin & Compression via Public Tunnel:    PASS");
  console.log("----------------------------------------------------------------------");
  console.log("Simulated ChatGPT private_key_jwt Flow:    NOT RUN here (run Vitest separately)");
  console.log("HTTPS native MCP/Refresh/Revocation:       PASS (this run)");
  console.log("Live External ChatGPT Connector Flow:      NOT RUN (requires a real ChatGPT browser/connector session)");
  console.log("======================================================================");

  if (process.argv.includes("--keep-alive")) {
    console.log("\n[--keep-alive] Keeping tunnel open indefinitely. Press Ctrl+C to terminate.");
    console.log(`Public MCP URL: ${tunnelUrl}/mcp`);
    console.log(`Owner Login:    http://127.0.0.1:${ownerPort}/login`);
    await lifecycle.waitForAbort();
  }
}

await runE2E(main);
