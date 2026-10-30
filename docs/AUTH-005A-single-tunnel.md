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
   - All logs (`cloudflared.log`), disposable vaults, SQLite auth databases, and cache folders are strictly isolated within this temporary directory.
2. **Process Lifecycle Management**:
   - Signal traps registered for `SIGINT` (Ctrl+C), `SIGTERM`, and normal exit.
   - Guaranteed cleanup: terminates child processes (`cloudflared`), closes HTTP listeners, and removes temporary directories in `try ... finally` blocks.
3. **No Arbitrary Hangs**:
   - Tests execute synchronously and clean up immediately upon completion.
   - Live tunnel debugging is available on-demand via `--keep-alive`.

## ChatGPT Integration Diagnostic: Simulated vs Real

| Checkpoint | Result | Technical Detail |
|---|---|---|
| Client Metadata Document (CIMD) | **PASS** | `https://chatgpt.com/oauth/client.json` fetched over network with HTTP 200, valid JSON. |
| Redirect URI Matching | **PASS** | `https://chatgpt.com/connector_platform_oauth_redirect` strictly verified against CIMD `redirect_uris`. |
| Client Auth Method Enforcement | **PASS** | ChatGPT registers `token_endpoint_auth_method: "private_key_jwt"` with `jwks_uri: "https://chatgpt.com/oauth/jwks.json"`. Provider fails closed (`400 invalid_client`) when `none` is attempted. |
| Forged Assertion Defense | **PASS** | Client assertions signed with private keys not in `chatgpt.com/oauth/jwks.json` are rejected fail-closed (400/401). |
| Browser Localhost Limitation | **LOCKED / DOCUMENTED** | The browser redirect target is `http://127.0.0.1:39146/login`. This architecture requires the browser performing login/consent to run on the local host machine. Remote cross-device sign-in is unsupported by design. |
| Simulated ChatGPT `private_key_jwt` Flow | **PASS** | Fully verified in Vitest automated suite (`test/oauthSingleTunnel.test.ts`): simulated RSA key pair, RS256 assertion, valid JWKS exchange, token issuance, MCP tool execution (`obsidian_read_note`), replay prevention, and token refresh. |
| Real Live ChatGPT Connector E2E | **BLOCKED** | Live external ChatGPT connection requires an active ChatGPT developer account with custom connector entitlement and OpenAI's private signing key. Per exit criteria #4, strictly recorded as **BLOCKED**, never fabricated as PASSED. |
