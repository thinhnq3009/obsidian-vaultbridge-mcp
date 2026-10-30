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
2. The owner signs in with valid credentials via `POST /api/auth/sign-in/email` with `X-VaultBridge-CSRF: 1`.
3. The owner shell resumes authorization via `POST /oauth/authorize` and transitions to `/consent`.
4. The owner selects an explicit subtree (e.g., `Notes`) and action permissions (`readNote`, `listFiles`). Root (`*` or `/`) paths are rejected fail-closed.
5. The grant is persisted in `vaultbridge_grant` SQLite storage.
6. The owner approves consent via `POST /oauth/consent`, and Better Auth produces the signed callback redirect:
```
Location: https://chatgpt.com/connector_platform_oauth_redirect?code=...&state=...&iss=https://<stable-host>/api/auth
```

### 5. PKCE Token Exchange
The MCP client backend exchanges the single-use authorization code and `code_verifier` at `POST /api/auth/oauth2/token`. Upon successful verification, opaque `access_token` and `refresh_token` are issued.

### 6. Permission-Scoped Tool Calls
Requests to `POST /mcp` with `Authorization: Bearer <access_token>` are verified against the active SQLite grant:
- Files inside the granted subtree (`Notes/Doc.md`) succeed.
- Files outside the granted subtree (`Secret/Denied.md`) fail with an authorization error.
- Tools not granted (e.g., write actions under a read-only grant) fail closed.

### 7. Refresh Token Rotation & Immediate Revocation
- Calling `POST /api/auth/oauth2/token` with `grant_type: refresh_token` issues a rotated access token and a newly rotated refresh token.
- Invoking `POST /oauth/grants/revoke` on the private owner listener immediately invalidates the grant; subsequent requests with previously issued tokens receive `403 Forbidden`.

## Negative Security Verifications

1. **Owner Isolation:** All owner routes (`/login`, `/consent`, `/admin`, `/owner-state`, `/api/auth/sign-in/email`, `/oauth/grants`) return `401` or `404` when accessed through the public tunnel.
2. **Host Header Validation:** Public requests with spoofed or unlisted `Host` headers are rejected with `403 Forbidden`.
3. **Origin Validation:** Cross-origin requests with unapproved `Origin` headers are rejected with `403 Forbidden`.
4. **Compression Ban:** Compressed request bodies (`Content-Encoding` != `identity`) are rejected with `415 Unsupported Media Type`.
5. **SSRF Protection:** CIMD client metadata fetching rejects private and loopback IPs and requires HTTPS.

## ChatGPT Integration Diagnostic

| Checkpoint | Result | Technical Detail |
|---|---|---|
| Client Metadata Document (CIMD) | **PASS** | `https://chatgpt.com/oauth/client.json` fetched over network with HTTP 200, valid JSON. |
| Redirect URI Matching | **PASS** | `https://chatgpt.com/connector_platform_oauth_redirect` strictly verified against CIMD `redirect_uris`. |
| Client Authentication Method | **VERIFIED** | ChatGPT registers `token_endpoint_auth_method: "private_key_jwt"` with `jwks_uri: "https://chatgpt.com/oauth/jwks.json"`. The provider correctly fails closed when `none` is attempted. |
| Browser Localhost Limitation | **LOCKED / DOCUMENTED** | The browser redirect target is `http://127.0.0.1:39146/login`. This architecture requires the browser performing login/consent to run on the local host machine. Remote cross-device sign-in is unsupported by design. |
| Live External ChatGPT E2E | **BLOCKED** | Verified end-to-end through tunnel with simulated client and real ChatGPT metadata. Live execution inside ChatGPT UI requires an active ChatGPT account with custom MCP connector developer entitlement. Per exit criteria #4, recorded as **BLOCKED**, not fabricated as PASSED. |
