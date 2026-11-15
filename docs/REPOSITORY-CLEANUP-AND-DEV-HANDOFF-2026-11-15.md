# Repository cleanup and development handoff

Snapshot: 2026-11-15. Repository: `thinhnq3009/obsidian-vaultbridge-mcp`.
Target: `develop` at `b47d56b74df318c7c2694ef2a122f79dd0457873`.

This is an execution plan, not a claim that remaining work is complete. No branch
deletion, issue closure, CodeQL dismissal, security PR merge or release publication
is authorized by this document.

## 1. Verified snapshot

- `develop`: `b47d56b74df318c7c2694ef2a122f79dd0457873`.
- `main` is protected and 30 commits behind develop. Do not update it directly;
  use a reviewed release PR after all release gates.
- `release/v0.1.0` is a historical release-preparation branch; retain it.
- Dependabot PRs #101–#105 were squash-merged individually. Security Analysis on
  the snapshot SHA completed successfully; this does not prove all alerts are closed.
- Open PRs: #82, #83, #84. Keep open until security acceptance below.
- Open issues: #5, #39, #47, #48, #49, #55, #56, #57, #60.
- 57 branches: 3 special/protected, 32 with zero commits ahead of develop,
  22 with unique commits ahead of develop.

## 2. Branch cleanup

### 2.1 Zero-ahead deletion candidates

All branches below compared as `ahead_by=0` against snapshot develop. Before
deleting, re-check the branch SHA, open PR head references, deployment/release
configuration and automation dependencies. Delete only the branch ref.

```text
ci/require-auth002-fixes-before-main-release
codex/develop-default
codex/fe-001-crystal-foundation
codex/fix-code-scanning-alerts
codex/fix-four-auth-issues
codex/fix-insecure-lockfile
codex/fix-open-issues
codex/issue-4-yaml-precision
codex/issue-5-release-evidence
codex/issue-5-release-hygiene
codex/issue-16-bounded-regex
codex/issue-23-brotli-audit
codex/merge-remaining-branches
codex/obs-001-regression-baseline
codex/obs-002-metadata-contract
codex/obs-003-agent-edit-timestamp
codex/obs-005-atomic-multi-edit
codex/obs-006-search-consistency
codex/release-registry-verification
codex/security-hardening-bundle
codex/security-vault-boundaries
dependabot/npm_and_yarn/chokidar-6.0.0
dependabot/npm_and_yarn/vitest/coverage-v8-5.0.5
docs/issue-pr-linking-conventions
feat/issue-45-oauth-adr-spike
feat/issue-46-local-owner-auth
feat/issue-47-mcp-oauth
feat/issue-47-oauth-runtime
feat/issue-48-oauth-phase-b
feat/issue-48-request-vault-authz
feat/issue-49-single-tunnel-oauth
feat/owner-env-bootstrap
```

### 2.2 Keep these 22 unique-commit branches for triage

Do not delete merely because they are behind/diverged. Inspect unique commits and
diffs; port missing work into focused PRs or record why obsolete before deletion.

| Branch | Ahead | Action |
| --- | ---: | --- |
| `chore/ci-release-only-platform-matrix` | 5 | Compare release workflow changes with current publish/verify workflows; port missing gates only. |
| `chore/develop-oauth-dev-experience` | 18 | Inspect local OAuth developer UX; split still-needed work into focused PRs. |
| `chore/issue-label-taxonomy` | 2 | Compare labels/sync workflow; preserve current taxonomy, port only missing changes. |
| `codex/fix-http-tunnel-diagnostics` | 1 | Inspect diagnostics; ensure no secret/tunnel URL leakage. |
| `codex/owner-react-login` | 1 | Compare with FE-002A; avoid duplicate work. |
| `dependabot/github_actions/actions/checkout-7` | 1 | Recreate/update against current develop; run workflow CI. |
| `dependabot/npm_and_yarn/better-auth-1.7.14` | 1 | Obsolete target likely; provider upgrade must satisfy #60 contract. |
| `dependabot/npm_and_yarn/eslint-10.13.0` | 1 | Recreate against current lockfile; lint + full CI. |
| `dependabot/npm_and_yarn/playwright/test-1.65.0` | 1 | Already merged in #103; old head commit is a squash artifact; delete after PR/reference check. |
| `dependabot/npm_and_yarn/typescript-eslint-8.72.1` | 1 | Recreate against current lockfile; type/lint/full CI. |
| `dependabot/npm_and_yarn/unist-util-visit-5.2.0` | 1 | Already merged in #101; old head commit is a squash artifact; delete after PR/reference check. |
| `dependabot/npm_and_yarn/vitejs/plugin-react-6.3.0` | 1 | Already merged in #105; old head commit is a squash artifact; delete after PR/reference check. |
| `docs/issue-39-oauth-delivery-acceptance` | 1 | Refresh stale acceptance snapshot and link current evidence. |
| `feat/fe-002a-real-owner-login` | 3 | Active FE-002A; rebase/port, inspect all 31 changed files, open focused PR. |
| `fix/issue-5-historical-release-smoke` | 1 | Keep until #5 artifact evidence reconciled; no publish/tag action. |
| `fix/issue-47-maintained-auth-provider` | 1 | Inspect provider alignment; cannot claim #60 fixed without lifecycle tests. |
| `fix/issue-48-tool-grant-revision` | 1 | Keep for revoke/regrant race; integrate after #60 risk decision. |
| `fix/issue-55-storage-directory-identity` | 2 | PR #82 source; retain until accepted or superseded. |
| `fix/issue-56-key-database-initialization` | 2 | PR #83 source; retain until accepted or superseded. |
| `test/issue-49-writable-native-oauth-e2e` | 1 | Retain #49 evidence; review test realism and secret/log hygiene. |
| `test/issue-57-loopback-fixture-transport` | 2 | PR #84 source; retain until CodeQL/review disposition. |
| `test/issue-60-provider-revocation-1-7-16` | 1 | Preserve known-failing lifecycle/concurrency probes; do not weaken assertions. |

**Squash-merge note:** Dependabot branches for #101–#105 may still compare as
one commit ahead because the old head commit is not an ancestor of develop after
squash merge. #101, #102, #103, #104 and #105 are merged. Once their PR is verified
merged and no open PR/deployment uses the branch, delete those stale refs; do not
reopen or re-merge them.

### 2.3 Never delete in this cleanup

- `main` (protected)
- `develop` (protected)
- `release/v0.1.0` (historical release branch)

## 3. Security PRs — mandatory acceptance

### #82 / issue #55 — storage directory identity / TOCTOU

1. Keep Draft until an independent reviewer inspects final diff.
2. Review identity captured before lock wait and revalidated after lock acquisition:
   device/inode, canonical path, ownership, mode, symlink/hard-link behavior.
3. Audit ancestor replacement, vault/app-data separation, lock cleanup on all
   exceptions, and Windows ACL behavior.
4. Document residual `node:sqlite` pathname boundary: descriptor checks cannot
   make pathname open atomic against an attacker swapping entries away and back.
   Do not claim same-user sandboxing or complete TOCTOU elimination.
5. Repeat focused race tests; run build, lint, full tests, production+dev npm audit,
   package smoke, supported Node 22/24 CI and CodeQL on final SHA.
6. Resolve threads only after the corresponding fix is verified. Close #55 only
   after independent review and merged fix.

### #83 / issue #56 — DB/session-key initialization race

1. Independently review exclusive empty-DB reservation before key generation.
2. Prove competing initializers cannot overwrite DB, key or sidecars.
3. Inject interruption/crash after reservation, key creation, SQLite init,
   migration, rollback and cleanup.
4. Verify descriptor/inode/path checks, no-follow behavior, descriptor closure
   and lock release even if rollback fails.
5. Existing DB with missing/invalid key must fail closed; never silently generate
   a replacement key.
6. Run repeated concurrent-start tests + full validation/CodeQL on final SHA;
   close #56 only after independent acceptance and merge.

### #84 / issue #57 — loopback credential transport / CodeQL

1. Retrieve exact CodeQL #20 trace and source-to-sink path.
2. Prove request destination is only the disposable listener's actual numeric
   loopback address and bound port; reject alternate host/address/port, redirects
   and proxy inheritance.
3. Ensure fixture-only credentials; invalid destinations must fail before request.
4. Test redirects, proxy env, hostname/DNS forms, alternate ports and IPv4/IPv6
   variants where applicable.
5. Record scanner disposition with exact rationale and final-SHA CodeQL evidence.
   Green workflow alone is not an alert dismissal.
6. Resolve review thread only after its concern is fixed; close #57 only after
   independent security review and merge.

## 4. OAuth and release work

### #60 — Better Auth grant-family revocation / refresh-revoke race (blocker)

- Preserve known-failing probes on provider 1.7.15/1.7.16. Do not weaken expected
  assertions to get green CI.
- Reproduce old/intermediate access-token survival after family revocation and
  concurrent refresh/revoke outcomes, including impact on unrelated grants.
- Inspect maintained upstream releases/issues for an atomic family-revocation
  contract; regression tests must prove behavior, not merely HTTP status.
- If upstream has no supported fix, keep OAuth opt-in/experimental and record an
  explicit owner decision to defer/change requirements. No casual provider fork
  or custom token ledger.
- Close only after contract passes on supported Node versions or owner accepts a
  documented changed requirement and residual risk.

### #47 — provider alignment

- Align production Better Auth packages only to a reviewed compatible version.
- Finish SDK-v2 migration, CIMD/session interoperability, authorization-code +
  PKCE S256, refresh/revoke, client assertion validation/replay, restart and
  multi-worker isolation tests.
- Do not mark complete while #60 remains unresolved without an explicit accepted
  limitation.

### #48 — request principal and scoped vault authorization

- Bind each active tool invocation to exactly one live grant revision.
- Test revoke/regrant in-flight, stale revision rejection, concurrent requests,
  restart and multi-worker behavior.
- Fail closed for traversal, symlink, root grant, cross-vault and unauthorized tools.
- Preserve STDIO/static-token compatibility; run combined auth tests + full CI/CodeQL.

### #49 — native OAuth client / single tunnel

- Complete native MCP create/read/replace/delete on disposable vault data.
- Test stale revisions, path denials, read-only token isolation, refresh and revoke
  using a real client process, not only mocked provider IO.
- Complete browser/remote HTTPS and eligible ChatGPT connector interoperability;
  separate simulated diagnostics from real-client evidence.
- Benchmark 1/2/3 agents with method, p50/p95/p99, throughput, errors and resources.
- Run Ubuntu/macOS/Windows × supported Node 22/24. Keep OAuth opt-in until review
  and owner release approval.

### #5 — historical v0.1.0 evidence

- Preserve historical npm artifact and registry tags.
- Reconcile immutable metadata, integrity, provenance and source commit; never infer
  exact source from a similar build.
- If exact source cannot be recovered, document the provenance gap.
- Verify package identity, both CLI aliases, supported Node versions and installed
  tarball smoke on Node 22/24.
- No publish, dist-tag change, Git tag or release without explicit approval and
  every gate in `RELEASING.md`.

### #39 — integrated OAuth acceptance

- Refresh `docs/AUTH-000-delivery-status.md` (currently a dated snapshot) with
  final SHA and links after child issues integrate.
- Integrate #55–57, #47, #48 and #49 on a reviewed integration branch; rerun
  combined tests because separate green PRs do not prove the combined tree.
- Resolve #60 or record explicit owner-approved limitation.
- Preserve v0.1.0 rollback and stopped-service SQLite/session-key backup procedure.
- Close #39 only after child acceptance and release evidence pass.

## 5. FE-002A — next development task

Branch `feat/fe-002a-real-owner-login` is 3 ahead / 6 behind and changes 31 files.
Do not merge blindly.

1. Rebase/cherry-pick its three unique commits onto current develop in a fresh
   working branch; inspect every conflict and preserve current unrelated changes.
2. Keep `MCP_OWNER_UI_MODE=legacy` as default; React mode is explicit opt-in.
3. Keep private owner UI on loopback 39146 and public MCP/OAuth listener separate.
4. Verify login, one-time recovery, forced password rotation, backend session
   confirmation, CSRF, Origin/Host/peer checks, CSP, no-store, password clearing
   and no credentials/session tokens in Web Storage/logs.
5. Preserve raw OAuth query exactly; only follow validated same-origin consent URL.
6. Keep /consent and /admin compatibility. Do not add consent/grant mutation or
   dashboard APIs outside FE-002A scope.
7. Test route/asset traversal, missing build, legacy/react modes; run full CI,
   CodeQL and manual browser acceptance on final SHA. Open focused PR and update docs.

## 6. Integration order / done criteria

1. Independently review and validate #82–84 on final SHAs.
2. Resolve #60 contract or obtain explicit owner decision.
3. Integrate #47, then #48; run combined auth/grant/revoke/restart tests.
4. Integrate #49 real-client, tunnel, benchmark and OS/Node evidence.
5. Reconcile #5 historical artifact evidence.
6. Integrate FE-002A separately.
7. Refresh #39 acceptance record and run combined release validation.
8. Only then create reviewed release PR from develop to main. Never direct-push or
   publish from develop.

Done means acceptance tests pass on final integrated SHA, CodeQL findings have
evidence-backed dispositions, substantive review threads are resolved for a reason,
docs link to evidence, and issue is closed with correct reason.

## 7. Tooling limitation in this sweep

The connected GitHub toolset available in this session supports listing/comparing
branches and repository content writes, but exposes no branch-delete operation.
Therefore no branch was deleted. Use an authorized GitHub admin connection or
authenticated local Git client to delete the 32 candidates after repeating checks.
Never force-update or delete protected branches.
