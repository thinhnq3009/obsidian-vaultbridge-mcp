# AUTH follow-up: four bounded corrections (2026-11-02)

Base: `141cd17` (`develop`, after PR #80). This is a follow-up to delivery
issues #46, #47, #48 and #49, **not completion of their full acceptance lists**.
No auth-mode defaults, OAuth experimental guard, package version or release
gates change.

## #46 — login-budget capacity accounting

`LoginBudget.reserve` previously denied every reservation at 1024 rows,
including reservations that only increment existing buckets. At 1023 rows it
could instead insert two new keys and exceed the cap.

Count the missing account/peer keys before admission: existing buckets retain
their configured failure/backoff controls, new identities cannot evict active
ones, and a reservation cannot exceed 1024 rows. The synthetic full-table
regressions test this defensive capacity invariant; they do not demonstrate a
remote exploit of the loopback-only listener or bypass its peer-wide limit.
Persistent SQLite budgets, expiry and password hashing are unchanged.

## #47 — HTTP bearer scheme interoperability

Accept case-insensitive ASCII `Bearer` and one or more ASCII spaces between
scheme and token. Preserve opaque token bytes, length and alphabet checks.
Tabs, newline separators, Basic authentication, and malformed schemes remain
invalid. All existing provider checks (active token, issuer, audience, expiry,
owner and scopes) still apply; there is no anonymous fallback.

The unit tests check the exact token sent to the verifier. Live disposable
OAuth/MCP tests exercise lowercase and uppercase schemes using the production
provider and grant store. Only remote CIMD metadata fetching is substituted.

## #48 — tool-admission revalidation

`runWithTool` previously checked only the context and current local grant.
Its optional live-provider verifier ran only if the callback invoked a backend
operation. A callback returning without one could complete without that check.

Revalidate the admission capability before executing the callback and before
returning success. Sanitize admission verifier failures to `ACCESS_DENIED`;
preserve callback errors unchanged. Exact action/path checks and operation-level
revalidation remain in place. Tests cover provider rejection before execution,
grant revocation during a no-op, successful checks on both sides and unchanged
callback errors. These extra checks add provider-validation work per tool call;
no throughput benchmark improvement is claimed.

This hardens the facade contract, including no-op callbacks. It is not evidence
that a particular existing MCP tool previously permitted unauthorized content
access. It does not fix upstream provider grant-family revocation (#60).

## #49 — meaningful E2E write-denial evidence

The native E2E flow attempted default `create` against an existing note and
accepted any `isError`. A conflict, validation error, or tool failure could
therefore masquerade as read-only authorization enforcement.

The shared local/tunnel probe now reads the note revision, attempts an explicit
revision-valid replacement, requires an `ACCESS_DENIED:` text error, and
verifies unchanged content **and revision**. Unit tests reject unrelated
`ALREADY_EXISTS`, `CONFLICT`, invalid-input and generic tool errors, even when
the latter mention `ACCESS_DENIED`. Live scoped OAuth tests run the same probe.

These checks do not constitute a real ChatGPT/cloud deployment test, a public
HTTPS interoperability certification, or a complete AUTH-005 release gate.

## Validation and review boundaries

Regression commands:

```sh
npx vitest run test/fourAuthIssues.test.ts test/requestAuthorization.test.ts test/oauthAuthorization.test.ts --maxWorkers=2
npm run build
npm run lint
npm test -- --maxWorkers=2
npm run smoke:package
```

Before the fixes, the first two regression files reported 11 failures and 111
passes. That baseline run used the extracted native E2E check with its original
behavior; follow-up tests additionally tighten error identity, revision
preservation and live OAuth coverage.

Use disposable vaults only. Final validation results belong in the PR.
Windows/macOS CI and final-head CodeQL require separate verification.
The requested child agent could not start because the agent service rejected
the inherited model identifier; no delegated implementation ran. GitNexus
discovery returned an internal error. The prescribed ChatGPT review could not
start because `c2c` is absent from this machine. Automated checks are not
independent security approval. Keep the PR draft pending that review and do not
merge, publish, dismiss scanning alerts, or close #46–49 based on these bounded
changes alone. Existing #55–57 and #60 gates remain open.
