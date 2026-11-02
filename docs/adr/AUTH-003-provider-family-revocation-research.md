# AUTH-003 — Better Auth provider-family revocation research

**Verified October 27, 2026.** Scope: maintained/provider-supported API for revoking an entire authorization grant / refresh-token family, including pre-rotation opaque access tokens and descendants, with race-safe coordination against refresh rotation. Initial source research was followed by the executable checks recorded below; no production integration or provider patch was adopted.

## Finding

No documented public OAuth Provider extension/API for revoking a consent/grant family (including `revokeOAuthConsent`) was found. The documented RFC 7009 endpoint is token-oriented, and the current docs explicitly say revoking a refresh token deletes access tokens it minted and removes that refresh row. On rotation, newer descendants are separate rows; this does not promise traversal to ancestors/siblings or atomic family-wide invalidation. The documented provider capability surface includes `getClient`, `authenticateClient`, `issueTokens`, `hashToken`, `validateAccessToken`, and `requireActiveAccessToken`, but no grant/family revoke operation. Extensions can add endpoints/grants but that is not itself a supported family invalidation primitive. [OAuth Provider docs](https://better-auth.com/docs/plugins/oauth-provider)

The public consent API includes `deleteOAuthConsent`, but this deletes consent metadata; it does not revoke already-issued access/refresh credentials. It is therefore not a grant-family revocation API, and no public `revokeOAuthConsent` operation was found. [Consent API reference](https://better-auth.com/docs/plugins/oauth-provider#oauth-consent)

## Current upstream evidence

- The latest stable Better Auth release visible on the official releases page is **v1.7.14**, commit `a936663` (October 26, 2026); the latest prerelease is **v1.8.0-beta.3**, commit `3c47b46` (October 27, 2026). The beta release notes shown do not announce grant-family revocation. [Official releases](https://github.com/better-auth/better-auth/releases)
- The immutable v1.7.14 source contains internal `invalidateRefreshFamily(ctx, clientId, userId)`, which deletes access rows associated with refresh-row IDs, then refresh rows for a `(clientId,userId)` pair. It is marked `@internal`, and the source itself warns the two deletes are not atomic: a concurrent worker may create a refresh/access row between them. [token.ts](https://github.com/better-auth/better-auth/blob/v1.7.14/packages/oauth-provider/src/token.ts#L520-L568)
- The same source calls family invalidation on detected reuse of an already-rotated refresh token, not ordinary explicit revocation. Refresh rotation uses a compare-and-swap on the parent row, but source comments state strict family invalidation on contested concurrent redemption needs a transaction around CAS + mint chain and is deferred pending adapter transaction support. [token.ts](https://github.com/better-auth/better-auth/blob/v1.7.14/packages/oauth-provider/src/token.ts#L652-L667)
- Official docs describe reuse semantics: after the optional replay interval expires, reuse of an old token invalidates the refresh-token family. This is replay response, not a public explicit grant-revoke API. [OAuth Provider docs](https://better-auth.com/docs/plugins/oauth-provider)
- The latest stable v1.7.14 release notes do not list an OAuth-provider family-revoke change; v1.8.0-beta.3’s listed OAuth-provider feature is consentReferenceId callback enhancement, not family revocation. [Release notes](https://github.com/better-auth/better-auth/releases)

## Concurrency / identity assessment

There is no upstream guarantee verified for atomic coordination of explicit grant revocation with refresh rotation. Current upstream source explicitly documents a race in its internal family invalidation and defers strict rotation/reuse transactionality. Further, that helper groups by client and user, not a unique authorization-grant identifier; using it as a public grant-scoped revoke could over-revoke unrelated grants for that user/client. Existing authorization-code lineage (`authorizationCodeId`) is a better durable family key, but current token rotation carries lineage without the documented revocation API promising a lineage-wide transactional delete. These are source-level observations, not claims that the owner’s pinned probe was reproduced here. The existence of a race/TODO is not by itself a demonstrated vulnerability; black-box refresh/revoke race, unrelated-grant isolation, and ownership behavior require executable validation. The main agent is handling those probes; this research did not duplicate them.

A further ordering concern is visible in the project’s inspected local source: `revokeRefreshToken` handles an already-revoked token by invoking `invalidateRefreshFamily` before comparing the request’s client ownership. This is a source-level concern requiring the main agent’s black-box ownership probes; it is not asserted here as an exploitable vulnerability. The project’s reported opaque-token symptom is consistent with per-token/row semantics and blocker evidence: revoking the current refresh row does not invalidate prior rotated-family rows. Do not treat the internal helper or replay detection as a supported production workaround.

## Recommendation to upstream

Request a **maintained public grant/family revocation API** in `@better-auth/oauth-provider` (and document it), not a private import or app-side DB deletion. Specify a durable grant/family ID shared by authorization-code issuance and every refresh descendant; require explicit revocation to invalidate all associated opaque access tokens and refresh descendants, while preserving unrelated grants for the same user/client. Make revocation linearizable with rotation (transaction/locking or an equivalent atomic tombstone checked by issuance and introspection); ensure a rotation concurrent with revocation cannot commit a usable child after the revoke succeeds. Define caller ownership/client authorization and replay-evidence retention. Add upstream tests for (1) pre-rotation access token, (2) current child and multiple descendants, (3) unrelated grant preservation, and (4) barriers racing refresh against revoke in both orderings. Retest the project’s existing opaque probe against a released stable version before production adoption.

Until such a documented API and concurrency contract exists, keep AUTH-003 blocked. Do not use `revokeOAuthConsent` assumptions, private `invalidateRefreshFamily`, direct production table edits, session-wide logout as a grant substitute, or a silent token-lifetime relaxation.

- [OAuth Consent docs](https://better-auth.com/docs/plugins/oauth-provider#oauth-consent)

## Exact primary sources

- [OAuth Provider docs — revocation, refresh, extension capabilities](https://better-auth.com/docs/plugins/oauth-provider)
- [OAuth Provider source `token.ts` — internal family invalidation and transaction/race TODO](https://github.com/better-auth/better-auth/blob/v1.7.14/packages/oauth-provider/src/token.ts#L520-L568)
- [OAuth Provider source `token.ts` — rotation CAS and deferred strict family invalidation](https://github.com/better-auth/better-auth/blob/v1.7.14/packages/oauth-provider/src/token.ts#L652-L667)
- [OAuth Provider source `token.ts` — consent metadata API; no issued-token invalidation contract](https://github.com/better-auth/better-auth/blob/v1.7.14/packages/oauth-provider/src/oauthConsent/endpoints.ts#L68-L101)
- [Official releases and immutable release commits](https://github.com/better-auth/better-auth/releases)


## Executable follow-through (same date, Linux)

Registry `dist-tags` and the official latest-release API were freshly checked:
stable **1.7.14**, prerelease **1.8.0-beta.3**. The aligned 1.7.14 set was installed
in a separate temporary directory, with `npm ls` confirming all Better Auth/core/
MCP/CIMD/provider versions aligned; root and committed spike dependencies remain
unchanged. A fresh aligned beta manifest (without the stable lockfile) installed
normally, without `--force` or `--legacy-peer-deps`. An initial beta overlay onto
the stable lock produced ERESOLVE and is not counted as runtime evidence.

| Provider set | Linux Node | Public opaque lifecycle | Concurrent refresh/revoke |
| --- | --- | --- | --- |
| 1.7.13 pinned | 22.23.4, 24.22.1 | exit 1; original (three tool calls) and intermediate access still 200 | exit 1; refresh-first 500/revoke 400, unrelated grant 401 in both launch orders |
| 1.7.14 stable | 22.23.4, 24.22.1 | same exit 1 / two earlier-access failures | same exit 1 / four contract failures |
| 1.8.0-beta.3 | 24.22.1 | same exit 1 / two earlier-access failures | exit 1; refresh-first 500/revoke 200, unrelated grant 401 in both launch orders |

The refresh-first 500 logs contain `FOREIGN KEY constraint failed`. These are
single-process real concurrent HTTP requests against disposable SQLite WAL,
not a deterministic multi-worker scheduler or a proof of every possible
interleaving. Both requests are awaited before checking credentials. If a
refresh succeeds, its returned access and refresh descendants must also be
denied; the observed runs above returned 500/400 instead, so no successful
raced-descendant claim is made. Fresh wrong-client refresh/revoke checks pass.
The lifecycle suite additionally verifies individual access revocation, live
refresh reuse and expired access/refresh tokens. No provider limits were raised
or disabled; concurrency uses a separate disposable process to remain within
the existing 20 token requests/minute.

Reproduce the committed set:

```sh
npm ci --prefix scripts/spikes/better-auth-sdk-v2
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:opaque-local
npm --prefix scripts/spikes/better-auth-sdk-v2 run probe:concurrency
```

Run **both** commands even when the first exits 1. They are distinct gate
assertions, not alternatives. Exit 1 is a failed contract; exit 2 is an
inconclusive prerequisite failure, never PASS. The CI workflow executes the
concurrency step with `if: ${{ !cancelled() }}` to collect evidence after a
lifecycle failure, preserving each step's nonzero exit status.

To test stable without modifying either committed dependency tree:

```sh
scratch=$(mktemp -d)
cp scripts/spikes/better-auth-sdk-v2/{package.json,package-lock.json,*.mjs} "$scratch/"
npm install --prefix "$scratch" --save-exact better-auth@1.7.14 \
  @better-auth/mcp@1.7.14 @better-auth/cimd@1.7.14 @better-auth/oauth-provider@1.7.14
npm --prefix "$scratch" ls better-auth @better-auth/core @better-auth/mcp @better-auth/cimd @better-auth/oauth-provider
npm --prefix "$scratch" run probe:opaque-local
npm --prefix "$scratch" run probe:concurrency
rm -rf "$scratch" # remove only this disposable experiment
```

PowerShell users can create a temporary directory and copy the same files;
the actual committed CI probes themselves use only cross-platform Node APIs.

## Required review before any patch adoption

**Stop production integration.** Request maintainer review of a public
`revokeAuthorizationGrant`-style capability (name is a proposal, not an existing
API). A viable design needs a durable grant tombstone/version checked by both
rotation/issuance and active-token verification under a real cross-worker
transaction/locking contract. Resolve the grant from the token only after
client ownership checks; authorization-code lineage must stay intact through
rotation. Do not use `(clientId,userId)` as a substitute for a specific grant.

Review must cover migrations/backfill for existing grants, every supported
adapter's transactional semantics, rollback safety, retention of replay
evidence, non-disclosing idempotent revocation responses, no positive
introspection cache surviving revocation, unrelated-client/grant isolation,
and crash/restart behavior. Barrier-controlled upstream tests must exercise
both commit orderings of refresh versus revoke across independent connections.
An in-process mutex alone is insufficient for multiple workers.

No fork, private import, custom production token lifecycle or upstream issue
submission is part of this change. If maintainers cannot supply this contract,
prepare an isolated upstream patch and **request security/maintainer/owner
review before adopting it**. Do not merge AUTH-003 or switch production OAuth on
until that reviewed version passes all six gate jobs. JWT expiry waiting,
synthetic reuse, session-wide logout, client-wide disable/delete and direct
provider-table writes remain excluded as substitutes.
