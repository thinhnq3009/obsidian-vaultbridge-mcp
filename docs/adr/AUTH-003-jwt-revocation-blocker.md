# AUTH-003 — provider revocation gate

**Status: BLOCKED / NOT IMPLEMENTED IN PRODUCTION — October 27, 2026.**

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
