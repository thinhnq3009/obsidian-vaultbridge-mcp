import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";

import { startHttpServer } from "../src/http.js";
import { makeConfig } from "../test/helpers.js";
import { runE2E } from "./e2eLifecycle.js";
import { verifyNativeFlow } from "./e2eNativeFlow.js";
import { verifyDiscovery } from "./e2eDiscovery.js";

async function runLocalE2E(lifecycle) {
  const fetch = lifecycle.fetch;
  console.log("=== STARTING AUTH-005A LOCAL E2E VERIFICATION (isolated disposable vault) ===");

  const tempDir = lifecycle.useDirectory(await fs.mkdtemp(path.join(os.tmpdir(), "vaultbridge-auth005a-")));
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

  const mcpPort = Number(process.env.MCP_PORT) || 39145;
  const ownerPort = Number(process.env.OWNER_PORT) || 39146;
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

  lifecycle.useServer(await startHttpServer(config));
  lifecycle.signal.throwIfAborted();
  console.log(`✓ Server started successfully on ports ${mcpPort} (MCP/OAuth) and ${ownerPort} (owner)`);

  // 1. 401 Challenge
  console.log("\n[1] Testing 401 WWW-Authenticate challenge on /mcp...");
  const challengeRes = await fetch(`${publicOrigin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
  console.log(`  Response status: ${challengeRes.status}`);
  const wwwAuth = challengeRes.headers.get("www-authenticate");
  console.log(`  WWW-Authenticate: ${wwwAuth}`);
  if (challengeRes.status !== 401 || !wwwAuth || !wwwAuth.includes("resource_metadata=")) {
    throw new Error(`401 challenge failed: status=${challengeRes.status}, wwwAuth=${wwwAuth}`);
  }
  console.log("  ✓ 401 Challenge PASSED");

  // 2. Validate protected-resource metadata and both authorization aliases.
  await verifyDiscovery(fetch, publicOrigin, ownerOrigin);
  console.log("  ✓ Both discovery aliases use the canonical public origin with no owner leak");

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

  const authorizeRes = await fetch(`${publicOrigin}/api/auth/oauth2/authorize?${authorizeParams}`, {
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "manual",
  });
  console.log(`  Authorize status: ${authorizeRes.status}`);
  const location = authorizeRes.headers.get("location");
  console.log(`  Redirect location: ${location?.split(/[?#]/, 1)[0]}`);
  if (authorizeRes.status !== 302 || !location || !location.startsWith(`${ownerOrigin}/login`)) {
    throw new Error(`Authorize redirect failed: status=${authorizeRes.status}, location=${location?.split(/[?#]/, 1)[0]}`);
  }
  console.log(`  ✓ Authorize redirect to private owner ${ownerPort} PASSED`);

  const redirectUrl = new URL(location);
  const oauthQuery = redirectUrl.search.slice(1);

  // 4. Owner Login on private port 39146
  console.log(`\n[4] Testing Owner Login on 127.0.0.1:${ownerPort}...`);
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
  if (resumeRes.status !== 200) throw new Error(`Resume failed: ${resumeRes.status}`);
  const resumeBody = await resumeRes.json();
  console.log(`  Consent target URL: ${resumeBody.url?.split(/[?#]/, 1)[0]}`);

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
  if (grantRes.status !== 200) throw new Error(`Grant failed: ${grantRes.status}`);
  const grantBody = await grantRes.json();
  if (!grantBody.grantId) throw new Error("Missing grant ID");
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
  console.log(`  Callback destination: ${new URL(consentBody.url).origin}${new URL(consentBody.url).pathname}`);
  const callbackUrl = new URL(consentBody.url);
  const authCode = callbackUrl.searchParams.get("code");
  const callbackState = callbackUrl.searchParams.get("state");
  const callbackIss = callbackUrl.searchParams.get("iss");
  console.log(`  Authorization Code: ${authCode ? "received (redacted)" : "null"}`);
  console.log(`  State matches: ${callbackState === state}`);
  console.log(`  Issuer: ${callbackIss}`);
  if (consentRes.status !== 200 || callbackUrl.origin + callbackUrl.pathname !== redirectUri || !authCode || callbackState !== state || callbackIss !== `${publicOrigin}/api/auth`) {
    throw new Error("Consent flow failed to produce valid callback parameters");
  }
  console.log("  ✓ Consent and callback generation PASSED");

  // 6. Token Endpoint private_key_jwt Enforcement (Public Port 39145)
  console.log(`\n[6] Testing Token endpoint private_key_jwt enforcement on public port ${mcpPort}...`);

  // 6a. Negative test: 'none' auth method rejected for ChatGPT
  const tokenProbeNone = await fetch(`${publicOrigin}/api/auth/oauth2/token`, {
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
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience([`${publicOrigin}/api/auth/oauth2/token`])
    .setJti(randomBytes(16).toString("hex"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(untrustedKey);

  const forgedRes = await fetch(`${publicOrigin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code: authCode,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      resource: `${publicOrigin}/mcp`,
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

  // 7. Revocation
  console.log(`\n[7] Testing Revocation on private owner port ${ownerPort}...`);
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
  console.log("  ✓ Grant revocation PASSED");

  // 8. Comprehensive Negative Security Tests
  console.log("\n[8] Running negative security and boundary tests...");

  // 10a. Missing CSRF header on owner port
  const noCsrfRes = await fetch(`${ownerOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ownerOrigin },
    body: JSON.stringify({ username: "obsidian-admin", password: ownerPassword }),
  });
  console.log(`  Owner route without X-VaultBridge-CSRF status: ${noCsrfRes.status} (expected 403)`);
  if (noCsrfRes.status !== 403) throw new Error(`Expected 403 for missing CSRF header, got ${noCsrfRes.status}`);

  // 10b. Untrusted Origin on owner port
  const badOwnerOriginRes = await fetch(`${ownerOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vaultbridge-csrf": "1", origin: "https://evil.example" },
    body: JSON.stringify({ username: "obsidian-admin", password: ownerPassword }),
  });
  console.log(`  Owner route with untrusted Origin status: ${badOwnerOriginRes.status} (expected 403)`);
  if (badOwnerOriginRes.status !== 403) throw new Error(`Expected 403 for untrusted Origin, got ${badOwnerOriginRes.status}`);

  // 10c. Spoofed Host header on public listener
  const spoofedHostStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: mcpPort,
      path: "/mcp",
      method: "POST",
      headers: { host: "spoofed-host.example:39145" },
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(15_000)]),
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  console.log(`  Public listener with spoofed Host status: ${spoofedHostStatus} (expected 403)`);
  if (spoofedHostStatus !== 403) throw new Error(`Expected 403 for spoofed Host header, got ${spoofedHostStatus}`);

  // 10d. Untrusted cross-site Origin on public listener
  const crossOriginRes = await fetch(`${publicOrigin}/mcp`, {
    method: "POST",
    headers: { host: `127.0.0.1:${mcpPort}`, origin: "https://malicious.example", "content-type": "application/json" },
    body: "{}",
  });
  console.log(`  Public listener with untrusted Origin status: ${crossOriginRes.status} (expected 403)`);
  if (crossOriginRes.status !== 403) throw new Error(`Expected 403 for untrusted Origin, got ${crossOriginRes.status}`);

  // 10e. Compressed body rejection (Content-Encoding != identity)
  const compressedRes = await fetch(`${publicOrigin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${mcpPort}`,
      "content-type": "application/x-www-form-urlencoded",
      "content-encoding": "gzip",
    },
    body: "grant_type=authorization_code",
  });
  console.log(`  Public listener with compressed body status: ${compressedRes.status} (expected 415)`);
  if (compressedRes.status !== 415) throw new Error(`Expected 415 for compressed body, got ${compressedRes.status}`);

  // 10f. Private owner routes via public port
  for (const route of ["/login", "/consent", "/admin", "/owner-state", "/api/auth/sign-in/email", "/oauth/grants"]) {
    const probe = await fetch(`${publicOrigin}${route}`);
    if (probe.status !== 401 && probe.status !== 404) {
      throw new Error(`Owner route ${route} accessible on public port: status ${probe.status}`);
    }
  }
  console.log("  ✓ All private owner endpoints fail closed / 404 on public port");

  // Exercise a pre-provisioned native client, independently of ChatGPT's keys.
  await verifyNativeFlow({
    lifecycle, authDirectory: authDir, publicOrigin, ownerOrigin, cookie: sessionCookie,
    notePath: "Notes/Welcome.md", deniedPath: "Secret/Confidential.md", expectedContent: "permitted content",
  });

  console.log("  ✓ Negative security verifications PASSED");

  console.log("\n======================================================================");
  console.log("AUTH-005A LOCAL E2E VERIFICATION STATUS");
  console.log("======================================================================");
  console.log("401 WWW-Authenticate Challenge:           PASS");
  console.log("Public-Origin Consistent Discovery:        PASS");
  console.log(`Authorize 302 Redirect to Loopback:        PASS (http://127.0.0.1:${ownerPort}/login)`);
  console.log("Local Owner Sign-In & Scoped Consent:      PASS");
  console.log("ChatGPT-shaped authorize/callback:         PASS (provider diagnostic, not a real client)");
  console.log("Enforce RFC 7523 private_key_jwt:          PASS (client cannot use 'none')");
  console.log("Reject Forged Client Assertion:            PASS (untrusted key fails closed)");
  console.log("PKCE S256 Verifier Mismatch Isolated:      PASS (code verification failed)");
  console.log("PKCE S256 Valid Exchange (Native Client):  PASS (access_token issued)");
  console.log(`Private Owner Port ${ownerPort} Isolation:        PASS (never exposed externally)`);
  console.log("CSRF & Origin Defense on Owner Port:       PASS");
  console.log("Host, Origin & Compression on Public Port: PASS");
  console.log("----------------------------------------------------------------------");
  console.log("Simulated ChatGPT private_key_jwt Flow:    NOT RUN here (run Vitest separately)");
  console.log("Native client MCP/Refresh/Revocation:       PASS (this run)");
  console.log("Live External ChatGPT Connector Flow:      NOT RUN (requires a real ChatGPT browser/connector session)");
  console.log("======================================================================");
}

await runE2E(runLocalE2E);
