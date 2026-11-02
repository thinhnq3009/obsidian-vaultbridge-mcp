# AUTH-005A — Single Tunnel OAuth Architecture Verification & Deployment

## Architectural Overview

AUTH-005A locks the architecture for remote MCP and OAuth access via a single public HTTPS tunnel while preserving strict local-only isolation for the owner administrative and consent interfaces:

```
[ External MCP Client / ChatGPT ]
               │
               │ HTTPS (Tunnel)
               ▼
┌────────────────────────────────────────────────────────┐
│ Cloudflare Tunnel (`https://<stable-host>`)            │
└──────────────────────────────┬─────────────────────────┘
                               │
                               │ Local loopback proxy
                               ▼
┌────────────────────────────────────────────────────────┐
│ Public Listener (`127.0.0.1:39145`)                    │
│ - `/mcp` (Streamable HTTP MCP protocol)                │
│ - `/.well-known/oauth-protected-resource/mcp`          │
│ - `/.well-known/oauth-authorization-server/api/auth`   │
│ - `/api/auth/.well-known/oauth-authorization-server`   │
│ - `/api/auth/oauth2/authorize`                         │
│ - `/api/auth/oauth2/token`                             │
│ - `/api/auth/oauth2/revoke`                            │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ Private Owner Listener (`127.0.0.1:39146`)             │
│ - Loopback only (`127.0.0.1`, `::1`), strictly private │
│ - No public tunnel, proxy route, or wildcard forward   │
│ - `/login`, `/consent`, `/admin`, `/owner-state`       │
│ - `/api/auth/sign-in/email`, `/oauth/grants`           │
│ - Mandatory custom CSRF header `X-VaultBridge-CSRF: 1` │
└────────────────────────────────────────────────────────┘
```

## Protocol & Flow Verification (E2E Checkpoints)

### 1. 401 Challenge
Unauthenticated requests to the MCP endpoint `POST /mcp` receive a `401 Unauthorized` response containing RFC 9728 Protected Resource Metadata in the `WWW-Authenticate` header:
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<stable-host>/.well-known/oauth-protected-resource/mcp"
Content-Type: application/json

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```

### 2. Public-Origin Consistent Discovery
Discovery metadata endpoints on port 39145 expose only canonical HTTPS URLs matching `https://<stable-host>`:
- `GET /.well-known/oauth-protected-resource/mcp` returns `resource: "https://<stable-host>/mcp"` and `authorization_servers: ["https://<stable-host>/api/auth"]`.
- `GET /api/auth/.well-known/oauth-authorization-server` and `GET /.well-known/oauth-authorization-server/api/auth` return:
  - `issuer`: `https://<stable-host>/api/auth`
  - `authorization_endpoint`: `https://<stable-host>/api/auth/oauth2/authorize`
  - `token_endpoint`: `https://<stable-host>/api/auth/oauth2/token`
  - `revocation_endpoint`: `https://<stable-host>/api/auth/oauth2/revoke`
  - `code_challenge_methods_supported`: `["S256"]`
  - Zero leakage of loopback host or private owner port 39146.

### 3. Authorize Redirect to Private Loopback
Browser navigation to the public authorize endpoint (`GET /api/auth/oauth2/authorize?...` with `Accept: text/html`) validates the client metadata (via CIMD) and responds with `302 Found`:
```http
HTTP/1.1 302 Found
Location: http://127.0.0.1:39146/login?response_type=code&client_id=...&redirect_uri=...&scope=...&resource=...&code_challenge=...&code_challenge_method=S256&state=...&sig=...
```

### 4. Local Owner Authentication & Consent
1. The host browser follows the 302 redirect to `http://127.0.0.1:39146/login`.
2. The owner signs in with valid credentials via `POST /api/auth/sign-in/email` with mandatory `X-VaultBridge-CSRF: 1` header.
3. The owner shell resumes authorization via `POST /oauth/authorize` and transitions to `/consent`.
4. The owner selects an explicit subtree (e.g., `Notes`) and action permissions (`readNote`, `listFiles`). Root (`*` or `/`) paths are rejected fail-closed.
5. The grant is persisted in `vaultbridge_grant` SQLite storage.
6. The owner approves consent via `POST /oauth/consent`, and Better Auth produces the signed callback redirect:
```
Location: https://chatgpt.com/connector_platform_oauth_redirect?code=...&state=...&iss=https://<stable-host>/api/auth
```

### 5. PKCE Token Exchange & RFC 7523 Client Authentication
The MCP client exchanges the single-use authorization code and `code_verifier` at `POST /api/auth/oauth2/token`.
- **Generic Native Clients (`token_endpoint_auth_method: none`)**: Single-use authorization code exchanged with PKCE S256 verifier.
- **ChatGPT Client (`token_endpoint_auth_method: private_key_jwt`)**: Better Auth enforces RFC 7523 client assertions:
  - Requires `client_assertion_type: urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and signed RS256 JWT `client_assertion`.
  - Calling token endpoint with `none` fails closed: `{"error":"invalid_client","error_description":"client registered for private_key_jwt cannot use none"}`.
  - Assertions with untrusted keys, mismatched audience, or expired timestamps are rejected with HTTP 400/401.
  - Replay attacks are prevented via `oauthClientAssertion` SQLite table caching assertion `jti`.
  - Token refresh requires a fresh client assertion with a unique `jti`.

### 6. Permission-Scoped Tool Calls
Requests to `POST /mcp` with `Authorization: Bearer <access_token>` are verified against the active SQLite grant:
- Files inside the granted subtree (`Notes/Doc.md`) succeed.
- Files outside the granted subtree (`Secret/Denied.md`) fail with an authorization error.
- Tools not granted (e.g., write actions under a read-only grant) fail closed.

### 7. Refresh Token Rotation & Immediate Revocation
- Calling `POST /api/auth/oauth2/token` with `grant_type: refresh_token` issues a rotated access token and a newly rotated refresh token.
- Invoking `POST /oauth/grants/revoke` on the private owner listener immediately invalidates the grant; subsequent requests with previously issued tokens receive `403 Forbidden`.

## Negative Security Verifications

| Security Control | Test Mechanism | Expected & Observed Result |
|---|---|---|
| **Owner Listener Isolation** | Accessing `/login`, `/consent`, `/admin`, `/owner-state`, `/api/auth/sign-in/email`, `/oauth/grants` on port 39145 or via public tunnel | **401 Unauthorized / 404 Not Found** (fail-closed) |
| **Owner CSRF Defense** | `POST` requests to owner listener without `X-VaultBridge-CSRF: 1` | **403 Forbidden** |
| **Owner Origin Defense** | `POST` requests to owner listener with cross-site `Origin` | **403 Forbidden** |
| **Public Host Defense** | Public requests with forged or unlisted `Host` headers | **403 Forbidden** |
| **Public Origin Defense** | Public requests with untrusted cross-origin `Origin` headers | **403 Forbidden** |
| **Compression Ban** | Requests with `Content-Encoding` != `identity` | **415 Unsupported Media Type** |
| **SSRF Prevention** | CIMD fetching resolves once, verifies TLS, and rejects loopback/private IPs | **Type/Resolution Error** |
| **PKCE Enforcement** | Token exchange without PKCE or with mismatched `code_verifier` | **400 Bad Request** |
| **Client Auth Enforcement** | Token exchange for `private_key_jwt` client using `none` | **400 Bad Request (`invalid_client`)** |
| **JWT Assertion Signature** | Token exchange using forged key not present in client JWKS | **400 / 401 Unauthorized** |
| **JWT Assertion Audience** | Token assertion with `aud` not matching token endpoint URL | **400 / 401 Unauthorized** |
| **JWT Assertion Expiry** | Token assertion with past `exp` timestamp | **400 / 401 Unauthorized** |
| **JWT Assertion Replay** | Reusing the same `jti` across multiple token requests | **400 Bad Request (`jti has already been used`)** |

## Script Lifecycle & Isolation Hardening

Both `scripts/local-e2e.mjs` and `scripts/tunnel-chatgpt-e2e.mjs` implement:
1. **Isolated Temp Directories**:
   - Creates a unique per-run folder in `os.tmpdir()` (`vaultbridge-auth005a-XXXXXX` and `vaultbridge-tunnel-XXXXXX`).
   - Disposable vaults, SQLite auth databases, and cache folders are isolated within this directory. Script and cloudflared diagnostics go to process output; the script does not create a `cloudflared.log`.
2. **Process Lifecycle Management**:
   - Shared `scripts/e2eLifecycle.ts` handles normal completion, failures, `SIGINT` (Ctrl+C), and `SIGTERM`. Signals cancel pending requests/waits; startup unwinds before cleanup, including resources acquired after interruption.
   - Cleanup is a shared promise. It awaits the HTTP close callback **and** `server.closed` (owner service/application teardown), and awaits the tunnel child's close event. SIGTERM escalates to SIGKILL if the child has not exited; `ChildProcess.killed` is not used as an exit check.
   - Storage is removed only after teardown succeeds. Teardown errors fail the run and retain storage for diagnosis. Active public HTTP connections are forcibly closed after the grace period.
   - If non-abortable startup or teardown stalls for 30 seconds after a signal/cleanup begins, an emergency watchdog stops the managed tunnel child and exits **without deleting storage or claiming orderly teardown**. Ordinary success/failure/signal paths await cleanup and use `process.exitCode`, not an early `process.exit()`.
3. **No Arbitrary Hangs**:
   - Script HTTP requests have a 15-second timeout and are abortable. Tunnel URL discovery has a 30-second timeout; DNS retry waits are abortable.
   - Live tunnel debugging is available on-demand via `--keep-alive`.

## ChatGPT Integration Diagnostic: Simulated vs Real

| Checkpoint | Result | Technical Detail |
|---|---|---|
| Provider-side client metadata handling | **DIAGNOSTIC PASS** | Provider accepts an authorization request identifying `https://chatgpt.com/oauth/client.json`. This invocation does not independently assert the metadata HTTP response or inspect its JSON. |
| Redirect URI Handling | **DIAGNOSTIC PASS** | Provider accepts the requested `https://chatgpt.com/connector_platform_oauth_redirect` and returns that exact callback destination with matching state/issuer. This is not an independent comparison to CIMD `redirect_uris`. |
| Client Auth Method Enforcement | **PASS** | ChatGPT registers `token_endpoint_auth_method: "private_key_jwt"` with `jwks_uri: "https://chatgpt.com/oauth/jwks.json"`. Provider fails closed (`400 invalid_client`) when `none` is attempted. |
| Forged Assertion Defense | **PASS** | Client assertions signed with private keys not in `chatgpt.com/oauth/jwks.json` are rejected fail-closed (400/401). |
| Browser Localhost Limitation | **LOCKED / DOCUMENTED** | The browser redirect target is `http://127.0.0.1:39146/login`. This architecture requires the browser performing login/consent to run on the local host machine. Remote cross-device sign-in is unsupported by design. |
| Simulated ChatGPT `private_key_jwt` Flow | **PASS** | Fully verified in Vitest automated suite (`test/oauthSingleTunnel.test.ts`): simulated RSA key pair, RS256 assertion, valid JWKS exchange, token issuance, MCP tool execution (`obsidian_read_note`), replay prevention, and token refresh. |
| Real Live ChatGPT Connector E2E | **NOT RUN / BLOCKED** | These scripts do not drive an actual ChatGPT browser/connector session. Access to OpenAI's private signing key is neither required nor appropriate: the real client signs its own assertions. No current account-entitlement diagnosis is established by these scripts. Per exit criteria #4, never report real interoperability as PASSED from fixtures or HTTP probes. |

## Reproduce and Interpret Evidence

Use the supported Node version from `package.json`, then:

```bash
npm ci
npm run build
npm run lint
npx vitest run test/e2eLifecycle.test.ts test/e2eDiscovery.test.ts test/oauthSingleTunnel.test.ts
npx tsx scripts/local-e2e.mjs
# Requires cloudflared and public network access. Exposes only a disposable vault.
npx tsx scripts/tunnel-chatgpt-e2e.mjs
# Optional: retain the disposable server/tunnel until Ctrl+C.
npx tsx scripts/tunnel-chatgpt-e2e.mjs --keep-alive
```

`MCP_PORT` / `OWNER_PORT` override the canonical 39145 / 39146 defaults. `TUNNEL_URL` may select an existing HTTPS `*.trycloudflare.com` origin that forwards to the configured public port; the script does not manage that external tunnel's process. Do not point these probes at real vault/auth storage.

The evidence layers are intentionally separate:

- **Vitest (deterministic, fixture metadata/JWKS):** simulated `private_key_jwt` positive exchange, wrong key/audience/expiry, replay and refresh; native PKCE failures; root grant rejection; owner route isolation even with valid owner cookies, CSRF headers, and MCP bearer credentials. Discovery tests reject inconsistent aliases, bad responses, and private metadata leaks. Lifecycle tests cover delayed/failed teardown, active streaming connections, repeated cleanup, child escalation, interruption during startup, and emergency retention for stalled startup. POSIX signal-specific cases are not exercised on Windows.
- **Local CLI:** live ChatGPT CIMD/client-auth rejection diagnostics, plus a **pre-provisioned disposable native client** that performs valid PKCE, a scoped MCP read, denied subtree/write, refresh rotation, and grant revocation. Native client provisioning uses only the disposable SQLite fixture; it is not DCR and does not change ChatGPT's registered authentication method.
- **HTTPS CLI:** the same native positive flow actually traverses the public tunnel for authorization, token exchange, MCP, and refresh; grant management stays on the private listener. Authenticated GET/POST probes assert private endpoints remain absent on the public origin. Host spoofing is a local-listener/Vitest check, not a claimed live tunnel probe.
- **Real ChatGPT UI/client:** remains NOT RUN unless separately exercised and evidenced with the actual connector. A successful native or simulated client is not proof of ChatGPT browser/cookie compatibility.

Each CLI summary describes **only that invocation**; the simulated Vitest result is NOT RUN there. Historical PASS entries above describe the original verification, not an automatic certification of a later checkout or network environment.

OAuth remains experimental and opt-in (#60). This subtask does not clear parent AUTH-005 release gates (#55–57 / #58), replace cross-platform CI/package/security reviews, authorize merge, or publish a release. To roll back these verification-only changes, stop the scripts and their managed tunnel, remove any retained disposable directory after confirming processes have exited, and return to the previous revision. Production transport configuration is unchanged.

### PR #67 review verification — October 31, 2026

On Linux with Node 22.23.4:

- `npm run build`, `npm run lint`: PASS, including basic ESLint checks for the two `.mjs` scripts and type-aware checks for shared TypeScript helpers.
- `npm test -- --maxWorkers=2`: **34 files, 722 passed, 1 skipped**.
- Focused lifecycle/discovery/OAuth/STDIO suites: **35 passed**.
- Local E2E: PASS using `MCP_PORT=42145 OWNER_PORT=42146`; live Cloudflare HTTPS E2E: PASS using `MCP_PORT=43145 OWNER_PORT=43146`. Existing services on the default ports were left untouched.
- `npm pack --dry-run` and `npm run smoke:package`: PASS. The installed package completed revision-safe MCP operations through both the canonical and legacy executable names; the smoke's production-dependency audit also succeeded.
- The initial STDIO test timeout was traced to this checkout's untracked `.env` selecting HTTP. The STDIO regression now explicitly passes `--stdio`; `.env` is unchanged.
- Advisory `npx tsc --noEmit` (including all test files) still reports **9 pre-existing diagnostics**. Comparison against an isolated copy of original PR head `60756c5` produced identical normalized diagnostics. The production build is green; this is not a claim that whole-repository test typechecking is clean.

The same 35 focused tests also passed on Linux with Node 24.22.1. This records CLI/fixture evidence, **not** a real ChatGPT browser E2E or a complete cross-platform release-matrix result.
