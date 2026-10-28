# Experimental OAuth runtime — AUTH-003

Production source integration, not a claim of production deployment approval.
Prerequisite to AUTH-004 Phase B. PR #59 supplied diagnostics only.

## Operator contract

OAuth is **default-off** while #60 remains unresolved. Existing STDIO, static
token and loopback unauthenticated installations retain their global policy.
Unconfigured HTTP resolves to legacy `token` when `MCP_AUTH_TOKEN` exists (with
a migration warning), otherwise legacy `none` (with an exposure warning).
`MCP_AUTH_MODE=oauth|token|none` selects exactly one mode; conflicting tokens
are startup errors, never fallback credentials.

1. Stop the MCP process. Run `owner-auth --vault /absolute/disposable-vault`
   to enroll the owner using the existing protected setup-token workflow.
   If runtime uses a custom `MCP_AUTH_DIRECTORY`, use that same environment
   variable or `--auth-directory /absolute/private/app-data` during setup and
   recovery; CLI takes precedence. Never bootstrap a different database.
2. Stop the setup listener before starting experimental OAuth: the database is
   single-process locked. Do not start a second owner-auth process.
3. Set `MCP_AUTH_MODE=oauth`, `MCP_OAUTH_ENABLED=true`,
   `MCP_OAUTH_ISSUER=https://your-host/api/auth`, `MCP_VAULT_ID=<stable-local-id>`,
   `MCP_ALLOWED_HOSTS=your-host`. Optional `MCP_AUTH_DIRECTORY` overrides the
   existing OS app-data location. It must remain outside the vault.
4. The HTTP process starts a separate literal-loopback owner listener on
   `MCP_OWNER_PORT` (39146 by default). Open the printed local login address.
   Browser authorization navigates to this local owner UI for login/consent.
   The browser must run on the server's machine; remote-owner login is not
   provided. Never forward the owner port through a tunnel/reverse proxy.
5. Public listeners still require trusted TLS termination and an explicit Host
   allowlist. HTTP issuers are accepted only for loopback testing.

No signup, password login, owner session, grant management, consent approval,
introspection or server-only verification endpoint is exposed on the public
listener. Public routes are discovery, authorize, token and revoke only.
Owner POSTs retain exact Origin, custom CSRF header, JSON, peer and Host checks.
Cross-site browser **top-level document navigation** may open only the static
`/login` and `/consent` shells. Cross-site API fetches, iframes, other owner
pages and all mutations are still denied. Loading the shell does not approve
consent: its API calls must be same-origin, session-authenticated and use the
provider-signed query. CSP frame denial and no-referrer remain intact.
OAuth consent uses the provider-signed query, verifies its expiry/signature
before preview, and never treats a cookie as an MCP bearer.

## Verified identity seam

Pinned Better Auth/MCP/CIMD 1.7.13. `mcp()` is the **only** OAuth provider.
Opaque access tokens expire after five minutes. The server-only companion
endpoint uses the published `getOAuthProviderApi(...).requireActiveAccessToken`
capability and client lookup; it never decodes unsigned JWTs or makes a public
introspection round trip. The immutable identity additionally checks exact
issuer, single audience/resource, owner subject, client, expiry, Bearer token
type and supported vault scopes. No request header supplies a principal.
The scoped-backend consumer must accept only objects in the in-process verified
identity registry. This prerequisite deliberately returns **403** for even valid
OAuth tokens until Phase B installs the live SQLite-grant bridge.

Provider owns PKCE S256, single-use codes, exact redirects, signed consent,
resource binding, refresh rotation/reuse and individual token revocation.
CIMD uses the maintained Node DNS-resolve-once / public-address-only /
connection-pinned / no-redirect transport. Provider body/time limits and
application concurrency/fetch/cache limits bound discovery. DCR is off.

MCP defaults: aggregate 1200 RPM / burst 120, concurrency 32, verified
principal/client 600 RPM, failed/missing credential attempts 60 RPM per TCP
peer. Successful auth refunds the failed-attempt reservation. Keys never use
forwarding, client-ID or principal headers. Stores have a hard entry bound.
These single-process budgets are not distributed enforcement or benchmark
results; a proxy may collapse all callers to one peer.

OAuth provider admission is a separate, directly attached `express-rate-limit`
middleware on `/api/auth` and `/.well-known`, **before body parsing and provider
authentication**. `MCP_OAUTH_ENDPOINT_RPM=60` (CLI `--oauth-endpoint-rpm`, 1–1000)
is an aggregate requests/minute ceiling for this single-process provider,
including discovery/authorize/token/revoke and unknown paths in those
namespaces. One fixed in-memory bucket prevents forwarding/client-header
spoofing and unbounded per-client allocation. Excess requests return 429 with
Retry-After, even for malformed bodies. This does not consume verified MCP
client capacity or the separate loopback-owner login budget. Provider-native
route limits still apply; all limiter state is released on shutdown.

## Compatibility, limits, rollback

- MCP transport remains the established SDK v1 stateless per-request adapter.
  SDK v2 / 2026-07-28 protocol cutover is a separate migration; the CIMD profile
  is not a claim of v2 protocol/client interoperability.
- **#60 is not fixed:** current opaque-token revocation is distinct from
  whole refresh-grant-family invalidation. Concurrent refresh/revoke can race
  and impact other grants upstream. Diagnostic scripts and known-fail workflow
  are unchanged. Public OAuth/release still requires explicit risk review.
- Security/release issues #55–57 and draft #58 are not bypassed.
- Disable OAuth and restart in explicit token mode (or STDIO) to roll back.
  Provider migrations are additive. Do not drop owner/provider tables or
  restore mismatched SQLite/session.key backups. Stop the process before
  backup/restore.

Tests use synthetic vaults, real loopback HTTP and the production provider/
SQLite/login/consent/verification path. Only external CIMD IO is substituted
with deterministic remote-client documents; no real remote DNS/TLS, public
proxy or ChatGPT compatibility is claimed.
