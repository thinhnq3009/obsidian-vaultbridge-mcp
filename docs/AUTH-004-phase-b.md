# AUTH-004 Phase B — verified OAuth request binding

Depends on the separate AUTH-003 runtime prerequisite PR #62. Both PRs target
`develop`; Phase B contains the prerequisite commits until #62 is merged.
This is **not** permission to merge or deploy either PR.

## Trust and lifecycle

1. Experimental HTTP OAuth verifies an active opaque token through the maintained
   Better Auth capability. It checks owner subject, registered enabled client,
   exact issuer/audience/resource, expiry, token type and supported scopes.
2. A server-private request WeakMap holds the immutable verified principal.
   No header, MCP argument, session cookie, decoded JWT or client-selected
   grant/vault ID supplies identity or rights.
3. Resolve **exactly one** live SQLite grant by
   `(principalId, clientId, configured vaultId, configured resource)`. Missing,
   revoked or ambiguous grants produce HTTP 403. Failed bearer verification
   produces HTTP 401 with the protected-resource metadata challenge.
4. Issue a frozen registered OAuth context from that verified object and grant;
   track its access-token expiration independently of the public context fields.
5. Call `createRequestBackend` then `createMcpServer` for this request. Never
   mutate the application backend, policy, index or global config.
6. Re-read the local grant for every backend operation. Revalidate the provider
   token before/after IO and in existing final mutation guards under the path
   lock. Expired/revoked tokens, changed scopes and revoked grants fail closed.
   Release the HTTP transport/server on disconnect, not the shared application.

Phase A's tool/action/path checks, canonical filesystem policy, aliases,
read-only, revision/atomic-write guards, private search projections and
authorization-bound HMAC cursors remain in effect. Scoped Local REST and
privileged status/index/active-file operations remain denied. Authenticated
tool denials use sanitized MCP `isError` results; HTTP 403 is used for absent
request-level vault authorization. HTTP budgets return 429 + Retry-After.

## Owner-only consent and grant management

The loopback owner UI/API remains separate from public MCP. All mutations
require the owner session plus exact local Origin/Host/peer, JSON and the
non-simple CSRF header. No management endpoint is an MCP tool.

- During consent, the UI displays the provider-signed client/scopes/resource.
  The owner must enter a non-root subtree and explicitly approve a read-only
  preset. There is no default path, wildcard rule or auto-consent.
- `POST /oauth/grants` accepts `oauth_query`, `principalPermissions` and
  `clientPermissions` only. The signed query supplies the validated client,
  scopes and resource; owner/vault/resource/grant ID are resolved server-side.
  Both permission arrays use the Phase A exact action/path schema; client rules
  also enumerate exact `obsidian_*` tools. Example owner-side JSON:

  ```json
  {
    "oauth_query": "<the current signed provider query>",
    "principalPermissions": [{"path":"Notes","actions":["readNote","search"]}],
    "clientPermissions": [{
      "path":"Notes","actions":["readNote","search"],
      "tools":["obsidian_read_note","obsidian_search_content_advanced"]
    }]
  }
  ```

  Use `Content-Type: application/json`, `X-VaultBridge-CSRF: 1` and the owner
  session, from the local owner origin. Never paste cookies/queries into logs,
  issues or shell history. Write rights require explicit write actions/tools
  **and** a `vault:write` token/consent scope; grants cannot elevate tokens.
- `GET /oauth/grants` lists only this configured owner/vault/resource's grants.
  UI rendering uses textContent, not HTML.
- `POST /oauth/grants/revoke` with `{"grantId":"<owner-managed ID>"}` increments
  the persisted revision and immediately disables the grant. It survives a
  restart and does not disable a different client's local grant.
- The store has a 1024-record ceiling (including revoked records) and bounded
  enumeration. At capacity, new grants fail closed; no automatic deletion of
  security history. Schema remains version 1 in application-owned tables,
  separate from provider tables.

Local grant revocation is **not** upstream refresh-family revocation. If the
owner explicitly regrants a client, still-active tokens for that same
principal/client/resource can use the new grant. There is no durable provider
family identifier to distinguish those tokens safely (#60). Session revocation
and current-access-token revocation are separately checked.

Owner logout, all-session revocation and local password recovery explicitly
revoke **all of that owner's local vault grants**. This conservative policy is
intentional: provider session deletion can detach an opaque token's session
reference, so deleting the session alone did not reliably reject the token in
the live test. The local authorization layer then denies with **403** when the
provider still considers the token active; when sign-out invalidates the token
at the provider, the request returns **401** instead. Neither outcome is a
claim of provider grant-family invalidation. Regrant requires
explicit owner action. This mitigation does not alter provider tables or solve
#60's refresh-family/concurrency contract.

## Validation and outstanding gates

Disposable live tests exercise owner login → signed consent → S256 → opaque
token → actual MCP client/tool, sibling/write/privileged denials, parallel
clients with distinct subtrees, scoped search/cursor replay, token/grant scope
intersection, restart persistence, local-grant and current-access-token
revocation at final commit, expiry/foreign-server rejection, management CSRF
and sanitized logging. Only external CIMD IO is replaced by deterministic
fixtures. Phase A's comprehensive malicious-input/backend/tool tests remain
part of the full suite.

The CI matrix is explicitly enabled for this Phase B PR into develop:
Linux/macOS/Windows, Node 22.23.4 and 24.22.1, plus dependency audits. Local
Linux tests do not stand in for pending CI or real remote DNS/TLS/proxy/ChatGPT
interop. No throughput/latency benchmark or multi-worker operation is claimed.
SQLite remains single-process locked. SDK v1 transport is preserved;
2026-07-28 wire-protocol migration is not included.

OAuth remains **default-off**, explicit opt-in only pending #60 residual-risk
review. Its known-fail diagnostic is unchanged and must not be represented as
passing. Security/release gates #55–57 and #58 remain separate. Required ChatGPT
review needs the workspace Project/chat connected; local regression tests are
not independent review.

## Rollback

Stop the HTTP process, disable OAuth and select static token or STDIO to return
to global policy. Revert Phase B to the #62 prerequisite to restore the
verified-but-no-grant 403 barrier; revert #62 too to remove experimental runtime.
Keep the additive grant/provider tables; do not drop owner tables. Back up and
restore matching SQLite/WAL/session.key only with the service stopped.
