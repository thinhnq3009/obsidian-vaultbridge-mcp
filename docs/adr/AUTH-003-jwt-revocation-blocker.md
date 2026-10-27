# AUTH-003 — provider revocation gate

**Status: BLOCKED / NOT IMPLEMENTED IN PRODUCTION — October 27, 2026.**

> **Latest investigation:** Supported APIs, stable 1.7.14 and beta
> 1.8.0-beta.3 do not resolve the contract. See
> [source/release research and the upstream review proposal](AUTH-003-provider-family-revocation-research.md)
> and [the new executable evidence](#supported-api-investigation-and-concurrent-revocation).

> **Continuation:** The owner authorized opaque-token investigation. Opaque
> issuance and immediate individual revocation now work with supported
> verification APIs, but whole-refresh-family revocation still fails. See
> [the continuation evidence](#continuation--opaque-access-tokens). No repeated
> approval of the opaque-token investigation is needed; the remaining gate is
> provider semantics, not permission to investigate.

Refs #47. Base: `develop@983bd50`. Working branch:
`feat/issue-47-mcp-oauth`.

ADR-001 locks Better Auth as the OAuth provider, requires the JWT plugin, assigns
token lifecycle to the maintained provider, and says to report a technical
blocker rather than substitute custom OAuth. This document records that gate;
it does **not** change the approved architecture or weaken the acceptance
criteria. An owner decision is required before continuing production work.

## Reproduction

```sh
npm ci --prefix scripts/spikes/better-auth-sdk-v2
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:revocation
```

The second command intentionally exits **1** when the security contract fails.
Exit **0** is reserved for satisfying all the exercised contracts; exit **2**
means a prerequisite assertion/setup failed, so the revocation result is
inconclusive. Do not convert exit 1 into a release PASS or suppress the probe's
failures.

The probe uses pinned Better Auth/MCP/CIMD/OAuth Provider **1.7.13**, official
MCP server SDK **2.4.0**, a temporary SQLite WAL database and a literal-loopback
listener. It creates only a disposable test identity. The listener refuses
non-loopback peers and unexpected Host headers, exposes only required provider
routes, and has admission/body bounds and explicitly enabled provider limits.
It closes the listener/SDK/limiter/database and removes its temporary directory.
No real vault, existing owner store, default password, or application bootstrap
is used. Secrets are not printed.

CIMD uses a deterministic metadata fixture for a public HTTPS client ID and a
native loopback callback. There is **no metadata network fetch**. This verifies
the plugin's metadata profile and protocol flow, **not** DNS pinning, SSRF
defenses, or real-client/browser interoperability.

## Observed results

Repeated locally on Linux, Node **22.23.4** and **24.22.1**, with aligned
1.7.13 packages:

| Contract | Expected | Observed |
| --- | --- | --- |
| Revoke issued JWT access token through provider endpoint | Supported revocation | **400 `unsupported_token_type`** |
| Existing access token after refresh-family revocation | 401 | **200**, accepted by `requireMcpAuth` |
| Original access token after refresh reuse detection | 401 | **200**, accepted by `requireMcpAuth` |

The provider's error description is: “JWT access tokens are self-contained and
cannot be revoked server-side”.

The aligned **1.7.14** patch set was also installed separately into a disposable
directory and exercised with this same probe on Linux Node **24.22.1**. It
produced the **same three failures**. No 1.7.14 dependency or lockfile change is
proposed for production. The probe reads package versions from the installed
manifests so that patch experiments do not misreport the pinned versions.

### Positive/negative prerequisites that passed

- Provider SQLite migrations, password hashing/login and session cookie.
- RFC 9728 resource metadata and authorization-server discovery.
- CIMD `mcp-2026-07-28` metadata fixture; DCR is not advertised.
- Signed consent query/state tampering rejected; correct state/issuer returned.
- Authorization Code + PKCE S256 exchange; missing PKCE and `plain` rejected.
- Wrong authorization resource/redirect, wrong verifier/token redirect,
  consumed authorization code, and expired authorization code rejected.
- Missing/invalid bearer gets a 401 discovery challenge.
- A real generic 2026-07-28 `tools/call` envelope, with required HTTP headers,
  reaches an SDK v2 tool and returns `pong` using a freshly issued access token.
- Maintained verifier rejects wrong issuer/audience and missing required scope.
- Refresh rotates; revoked refresh and rotated-refresh reuse are rejected.

These passing prerequisites do not compensate for the failed revocation gate.
The `pong` tool is a probe fixture, **not** a production vault operation.
Expiry fault injection only updates a disposable provider authorization-code
row in this test; it is not an application migration.

## Source-level cause

In `@better-auth/oauth-provider` 1.7.13 and 1.7.14:

- `revokeJwtAccessToken()` explicitly throws `unsupported_token_type`.
- `revokeRefreshToken()` changes refresh state and removes opaque access-token
  rows; it cannot invalidate previously signed JWTs.
- `validateJwtAccessToken()` checks signature/issuer, configured resources,
  client state and an optional session, but not refresh-family revocation.

In `@better-auth/mcp`, `requireMcpAuth()` composes the JWT protected-request
handler. Signature/issuer/audience/expiry/scope checks are necessary, but do not
query the local revocation state. Merely mounting that handler in production
would leave the reported lifecycle contract unimplemented.

This is a contract mismatch, not a claim of a new upstream vulnerability:
self-contained access tokens can intentionally remain valid until expiry.
AUTH-003 currently asks for revoked credentials/grants to be rejected. Silently
redefining that requirement as “JWTs remain usable for five minutes” would
require an owner-approved acceptance change.

## Decision needed / safe continuation

Keep Better Auth selected. Possible owner-approved directions are:

1. Use provider-issued **opaque access tokens** and its supported active-token
   validation/revocation APIs, preserving issuer/resource/scope validation and
   the required JWT plugin where applicable. Verify the entire flow before
   adopting this token format; this probe does not yet prove it.
2. Approve an explicitly designed, persistent resource-server JWT revocation
   policy integration, or adopt a maintained upstream implementation with this
   contract. Do not create a second OAuth provider, custom code/PKCE exchange,
   or unreviewed token endpoint.
3. Explicitly approve bounded access-token validity after refresh revocation as
   an acceptance change, with tests and operator/client documentation.

No direction has been chosen on the owner's behalf. Production integration,
`oauth|token|none` mode resolution, configurable MCP budgets, secure browser UI
and public-network gates remain **unimplemented** by this branch. Existing
STDIO, static Bearer, owner bootstrap, HTTP guards and filesystem/tool behavior
are untouched; there is no partially enabled OAuth server or silent downgrade.

## Verification scope and rollback

The main regression suite, lint/build, package smoke and dependency audits must
be reported separately from this probe. Those checks can pass while this
explicit security-contract probe remains BLOCKED. Existing CI does not run this
new diagnostic command, and a green existing workflow does not close #47.

The probe is excluded by the existing package `files` allowlist and the existing
spike `.mjs` lint exclusion. Its syntax is checked separately with `node --check`.
No production source, root manifest/lockfile, existing AUTH-001 smoke, runtime
key/database or vault content is changed. Rollback is removal/revert of this
diagnostic and document; no database migration or operator configuration change
is needed.

GitNexus discovery returned an internal error. No configured ChatGPT workspace
review connection exists for this checkout. Direct library-source inspection
and executable verification were used; no independent ChatGPT/human security
review or macOS/Windows lifecycle run is claimed. Issues #55–57 and draft
release PR #58 remain separate, unresolved release gates.

### Local regression results

Linux, Node **22.23.4** and **24.22.1**:

| Command | Result |
| --- | --- |
| `npm run lint` | PASS on both runtimes |
| `npm run build` | PASS on both runtimes |
| `npm test -- --maxWorkers=2` | PASS on both: 28 suites, 547 passed, 1 Windows-only skipped (548 total) |
| `npm run smoke:package` | PASS on both: both CLI aliases, packaged STDIO tool round trips and package allowlist |
| `npm --prefix scripts/spikes/better-auth-sdk-v2 run smoke` | PASS on both; unchanged AUTH-001 smoke |
| `node --check scripts/spikes/better-auth-sdk-v2/lifecycle-revocation.mjs` | PASS on both |
| `npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:revocation` | **BLOCKED**, exit 1 on both, three lifecycle failures above |

Additionally, `npm pack --dry-run` passed. Root full and production-only
`npm audit --audit-level=high`, and the isolated spike audit, reported **zero
vulnerabilities** at verification time. The aligned 1.7.14 diagnostic also
exited **1**, with the same three failures. Node 22 emits the known
`node:sqlite` experimental warning.

These are local results, not macOS/Windows or latest-PR CI evidence. The new
probe deliberately remains outside the existing green baseline; #47 is still
open and the investigation PR must remain draft pending the owner decision.

## Continuation — opaque access tokens

### Supported configurations investigated

The same diagnostic now supports three explicit modes:

```sh
npm ci --prefix scripts/spikes/better-auth-sdk-v2
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:revocation
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:opaque
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:opaque-local
```

- `probe:revocation` preserves the JWT baseline.
- `probe:opaque` uses provider `disableJwtPlugin: true` for OAuth access
  issuance (with `jwt()` still installed), and the official MCP
  `createMcpProtectedRequestHandler()` with forced RFC 7662 introspection.
  A confidential resource-server client is created using the provider's
  server-only `adminCreateOAuthClient` API, with resource links and
  `client_secret_post` as required by the maintained introspection helper.
  Registration/admin are not exposed over the test listener; credentials stay
  in the disposable process. No positive introspection cache is used.
- `probe:opaque-local` exercises the documented public
  `getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken()` API
  from a server-only, read-only companion endpoint. The application verifies
  the provider-returned issuer, audience, expiry and required scopes and uses
  the provider's challenge builder. It does not mint, rotate or revoke tokens.
  Unknown/inactive tokens, missing credentials and unsupported sender
  constraints fail closed; resource-policy failures do not become anonymous.
  The companion API is not exposed over HTTP, as tested by a 404.

`requireMcpAuth()` itself remains JWT-only: the diagnostic explicitly verifies
that it rejects the issued opaque token. The two alternate paths above avoid
that incompatibility using documented APIs rather than a second OAuth provider,
custom cryptography, a fork, a private provider import or direct database token
validation. All issuance, PKCE, consent, rotation and revocation still belong
to the single `mcp()` provider.

Reference API contracts:

- Better Auth OAuth Provider documentation, “Provider capabilities outside a
  grant”, “Introspect Endpoint”, “Revoke Endpoint”, and `disableJwtPlugin`.
- The installed 1.7.13/1.7.14 public exports/types for
  `getOAuthProviderApi`, `createResourceServerChallenge`, and the MCP
  `createMcpProtectedRequestHandler` options.

### Narrower, still-blocking result

Both opaque paths successfully issue a resource-bound access token, call the
SDK v2 fixture tool, revoke that access token and reject its immediate reuse.
The independent current-refresh test mints another live child before revoking
its refresh token, so the earlier direct-access revocation cannot mask a
failure. The freshly minted child is denied after refresh revocation, including
three concurrent tool requests.

**However, the earlier access token from the same rotated family remains
active. Three concurrent requests made after the successful refresh-revocation
response all return 200 with `pong`, instead of 401.** The same provider APIs
accept it without any cache. Reusing a rotated refresh token subsequently
invalidates the live family, but ordinary explicit revocation does not
invalidate all earlier access credentials.

The reuse-detection test now uses a separate live grant: it proves a live
access/refresh child works before replay and is denied afterwards, rather than
mistaking an already-revoked family's error response for reuse detection.
Access expiry is also tested through provider verification after disposable
expiry fault injection. Missing/plain PKCE, tampered state, wrong
resource/redirect/verifier, consumed/expired code and scope negatives remain.

The HTTP introspection middleware additionally returns **500** instead of a
401 discovery challenge for mismatching expected issuer/audience. These
requests do not reach the tool, but still violate the requested challenge
contract. The documented in-process API plus resource policy returns the
correct 401/403 responses, so this response-mapping issue is **not** the
fundamental remaining blocker.

### Exact cause and recommended solution

`revokeRefreshToken()` deletes opaque access rows only where `refreshId` equals
the supplied refresh row's ID. Rotation creates new refresh rows and leaves
older access tokens linked to their earlier row. Thus revoking the current
refresh row does not touch those older access credentials.

Neither HTTP introspection nor `requireActiveAccessToken()` can infer an
unstored whole-family revocation: the old access row and browser session are
still active. The public provider capability surface offers token validation
but no whole-family revocation operation. The broader private
`invalidateRefreshFamily()` path is triggered by reuse detection, not normal
revocation; importing/calling it or manufacturing reuse would not be a
supported production integration.

**Recommended unblock:** obtain a maintained provider change that atomically
invalidates the entire authorization grant/family on explicit refresh
revocation, including all access/refresh descendants across rotations. It
should use durable grant/family identity (the existing authorization-code
lineage is available), validate caller ownership, retain replay evidence, and
coordinate invalidation with rotation. Verify the pinned release with these
same probes before production integration. A separately reviewed provider
patch could be evaluated, but none is silently shipped here.

Ending the owner's entire login session is a supported, coarser control, not a
drop-in replacement for a client's refresh-family revocation. Do not silently
log out unrelated grants, make clients retain/revoke an old rotated token,
wait for expiry, rewrite provider tables in production, or redefine the
whole-family requirement to claim this resolved. The provider's documented
token-specific behavior is not presented as a newly discovered vulnerability;
it does not satisfy this project's stronger family-revocation contract.

Production remains unchanged because step 2 of the continuation is conditional
on resolving this gate. No AUTH-004 work was started.

### CI gate

`.github/workflows/auth003-revocation-gate.yml` now runs
`probe:opaque-local` on Ubuntu/macOS/Windows × Node 22.23.4/24.22.1 when the
probe/lockfile/workflow changes. It is deliberately **red** until the actual
family-revocation requirement passes. There is no inverted assertion,
`continue-on-error`, swallowed exit code, disabled provider limiter or
suppression. This supersedes the historical observation above that only the
green baseline ran in CI.

### Continuation validation — local Linux

| Provider set | Node runtimes | Probe | Result |
| --- | --- | --- | --- |
| Aligned 1.7.13 | 22.23.4 and 24.22.1 | JWT baseline | BLOCKED / exit 1; three lifecycle failures |
| Aligned 1.7.13 | 22.23.4 and 24.22.1 | Opaque + HTTP introspection | BLOCKED / exit 1; family failure and two incorrect 500 challenges |
| Aligned 1.7.13 | 22.23.4 and 24.22.1 | Opaque + public in-process API | BLOCKED / exit 1; family failure only |
| Aligned 1.7.14, separate disposable install | 22.23.4 and 24.22.1 | Opaque + HTTP introspection | Same three failures / exit 1 |
| Aligned 1.7.14, separate disposable install | 22.23.4 and 24.22.1 | Opaque + public in-process API | Same family failure / exit 1 |

All ten runs reached their lifecycle assertions; none exited 2 for an
inconclusive prerequisite failure. In every opaque run the three pre-rotation
tool calls after current-refresh revocation returned actual `pong` results.

Fresh continuation regressions on **both** supported runtimes:

- `npm run lint` and `npm run build`: PASS.
- `npm test -- --maxWorkers=2`: PASS, **28 suites, 547 passed and one
  Windows-only skipped (548 total)** per runtime.
- `npm run smoke:package`: PASS for both CLI aliases and packaged STDIO tool
  round trips; package-content allowlist passed.
- Unchanged AUTH-001 `npm --prefix scripts/spikes/better-auth-sdk-v2 run smoke`:
  PASS.
- `node --check scripts/spikes/better-auth-sdk-v2/lifecycle-revocation.mjs`:
  PASS.
- `npm pack --dry-run`, `git diff --check`, YAML parsing and the unmasked
  six-cell CI gate configuration: PASS.
- Root full/production-only and isolated spike audits: **zero vulnerabilities**
  at this verification time.

The nested manifest/lockfile now directly pins the already-installed
`@better-auth/oauth-provider@1.7.13`, because the diagnostic uses its public
API. No production dependency or schema changed. The test admission ceiling is
240 requests/minute for its expanded finite diagnostic workload, not the
production MCP budget requested by AUTH-003. The new contract CI gate must be
reported separately from baseline CI: it is expected to fail until a maintained
provider implementation satisfies whole-family revocation. No production
readiness, browser/CIMD-network interoperability or load benchmark is claimed.

## Supported-API investigation and concurrent revocation

**October 27, 2026 — still BLOCKED.** This supersedes the earlier
request to choose a token-format direction. Opaque investigation is authorized;
no supported, atomically grant-scoped revocation operation was found. See the
[primary-source research and proposed upstream contract](AUTH-003-provider-family-revocation-research.md).

Fresh registry and official release checks identify **1.7.14** as latest stable
and **1.8.0-beta.3** as latest beta. Neither resolves the gate in an isolated
aligned install. No root or committed spike dependency version was changed.
`deleteOAuthConsent` deletes consent metadata, not already-issued credentials;
client-wide disable/delete or owner logout is broader than a specific grant.
The documented provider capability API does not expose family revocation.
The internal `(client,user)` invalidator explicitly documents non-atomic
invalidation and rotation limitations; importing it is not a supported fix.

### Strengthened probes (existing assertions retained)

```sh
npm ci --prefix scripts/spikes/better-auth-sdk-v2
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:opaque-local
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:concurrency
```

Run both probes; a failed lifecycle probe does not replace the concurrency
probe. Exit 1 remains a failed security/behavior contract; exit 2 is
inconclusive setup, never PASS. Default JWT/HTTP/local modes retain all their
previous security assertions. New coverage:

- A third rotation leaves **two** independently live earlier access
  credentials: original and intermediate. Neither is the access credential
  revoked by the individual-access test. After current-refresh revocation,
  original access still permits **three concurrent `pong` calls**, and the
  intermediate access separately permits another call. Both must be 401.
- Expired refresh is rejected with `invalid_grant`, in addition to expired
  access/code checks. Expiry fault injection touches disposable rows only;
  no database manipulation implements revocation or token validation.
- Separate `probe:concurrency` uses fresh disposable storage/listener/provider
  so all existing limits, including 20 token requests/minute, remain enabled
  unchanged. It tests wrong-client revoke/refresh, two simultaneous HTTP
  launch orders, earlier/current access, any successfully issued descendant's
  access and refresh, and preservation of a separate same-user/client grant.
- Checks run only after both concurrent responses. A 500 is recorded as a
  failing contract, not confused with a setup/expiry/reuse success. Returned
  descendants are checked when issued; observed runs issued none. The probe
  records this explicitly and makes no successful-descendant or deterministic
  multi-worker scheduling claim.
- The six-cell CI gate now also runs the concurrency step after a lifecycle
  failure (`if: ${{ !cancelled() }}`). Both steps retain nonzero failure codes;
  no continue-on-error, assertion inversion, limiter change or suppression.

### Final local diagnostic matrix

| Provider set | Linux Node | Opaque public API lifecycle | Concurrent refresh/revoke |
| --- | --- | --- | --- |
| Pinned 1.7.13 | 22.23.4 and 24.22.1 | exit 1, **2** earlier-access failures | exit 1, **4** contract failures |
| Stable 1.7.14, temporary install | 22.23.4 and 24.22.1 | same 2 failures / exit 1 | same 4 failures / exit 1 |
| Beta 1.8.0-beta.3, temporary install | 24.22.1 | same 2 failures / exit 1 | **3** failures / exit 1 |

These **10 final runs** all reach their result reports; none exits 2.
On 1.7.13/1.7.14, refresh-first launch yields **refresh 500 + revoke 400**,
with `FOREIGN KEY constraint failed`; revoke-first yields **refresh 400 +
revoke 200**. Both launch orders invalidate a separately verified unrelated
grant (**401**, expected 200). Beta yields refresh-first **500/200**, not a
fix; unrelated-grant failures remain. Launch order is an observed scheduler
sample, not a guarantee of every interleaving. Baseline JWT/HTTP modes remain
blocked and AUTH-001 smoke still passes. No rate-limit response was accepted
as revocation evidence. One initial beta installation with the old stable
lock produced ERESOLVE; a fresh aligned beta manifest installed normally
without force or peer-check bypass, and only that successful install is
counted in the runtime matrix.

Fresh full regressions on **both Linux Node 22.23.4 and 24.22.1**:

- `npm run lint`, `npm run build`: PASS.
- `npm test -- --maxWorkers=2`: PASS, **28 suites; 547 passed, one
  pre-existing Windows-only skipped (548 total)**. The new probes do not skip
  security assertions; baseline's platform-specific skip is unchanged.
- `npm run smoke:package`: PASS for both CLI aliases, package allowlist and
  packaged STDIO tool round trips.
- Existing AUTH-001 smoke, probe syntax and `git diff --check`: PASS.
- `npm pack --dry-run`: PASS (Node 24).
- Root full/production-only and pinned spike `npm audit --audit-level=high`:
  zero vulnerabilities (Node 24, point-in-time registry audit).

Historical head `06422fb` CI is now fully resolved: baseline CI
**40532345543 SUCCESS**, Security analysis **40532345411 SUCCESS**, and all
**six** revocation jobs in **40532345400 FAILURE** at the lifecycle step.
This supersedes the earlier queued macOS Node 24 snapshot, not final-head CI.
Updated-head run evidence belongs in PR #59 and the Obsidian note; never
inherit a prior head's PASS. Production integration and acceptance remain
blocked regardless of green baseline checks.

### Concrete recommendation / review gate

Keep Better Auth. Request a maintained **public grant-family revocation
capability** with durable grant identity, client ownership validation,
retained replay evidence and cross-worker linearizability against issuance/
rotation. A transaction or an equivalently atomic grant tombstone must ensure
no previously issued or concurrently minted credential is active after
successful revoke, without deleting unrelated grants. Include barrier-driven
adapter/multi-connection races, restart/crash tests and migration/backfill in
upstream review. The research note specifies the review checklist and exact
immutable source references.

No application-side table rewrite, synthetic reuse, global logout, expiry
waiting, private helper import or unreviewed fork was adopted. If an upstream
patch is required, keep it isolated and **request security/maintainer/owner
review before adoption**; this branch contains only probes/docs/CI, not that
patch. No upstream issue was submitted on the owner's behalf.

**Production path stopped as requested.** `/mcp` OAuth integration, production
UI/network/auth-mode/rate-budget changes remain unimplemented. STDIO, legacy
token, owner setup and vault security are unchanged. GitNexus still returns
internal errors; ChatGPT workspace review remains unconfigured. Direct source
inspection and executable validation are not independent security review.
PR #59 remains draft, #47 open; no AUTH-004, merge or publish. Rollback only
removes diagnostics/docs/CI and requires no production migration.
