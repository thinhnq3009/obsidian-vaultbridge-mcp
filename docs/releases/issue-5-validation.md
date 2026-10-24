# Issue #5 — release preparation handoff

Status: IMPLEMENTED_AWAITING_REVIEW. Delivery is on [PR #25](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/25), which remains open. No merge, tag change or publication.

The initial preparation evidence below describes commit `9afa64c`; the CI repair follow-up supersedes its pending-CI and local-only statements. Current implementation head `d296d59a38903b0a80eef70f110e5b5f78b86e7c` has all six CI jobs green, including installed-tarball smoke.

- Verified target: `thinhnq3009/obsidian-vaultbridge-mcp` (public GitHub repository
  ID 1217891264, default branch main). The checkout/remote still uses the historical
  path; GitHub resolves it to the renamed repository. Shared remote configuration
  was not changed.
- Branch: `codex/issue-5-release-hygiene`.
- Base: `3c296b83f842831d680c386231d7350f09b3e405` (same as origin/main at fetch).
- Candidate: `obsidian-vaultbridge-mcp@0.1.0-alpha.1`, default publish tag `alpha`.
- Registry verified 2026-10-24: alpha/latest both `0.1.0-alpha.0`, no gitHead or
  source attestation. Historical source evidence is in [RELEASING.md](../../RELEASING.md).

## Change scope

Package/lockfile names, executable aliases, source URLs, README client examples
and MCP handshake now agree. Builds remove stale dist content before compilation.
The packed package retains its test script; tests remain in the repository.
CI adds a production audit and actual installed-tarball npx smoke test to every
OS/Node job. prepublishOnly runs the same smoke and audit in addition to lint/tests.
There is no publish workflow.

SDK minimum 1.32.0 resolves to 1.32.2; Vitest and coverage minimum 4.1.12 and tsx
minimum 4.23.15 resolve tooling advisories. Other dependency updates stay within
existing parent ranges. Baseline audit: 18 total affected packages, including 8
production (1 critical). Final full and production audits report zero advisories
at this observation; future advisories can change that result.

One release-check issue was found: README claimed runtime-only tools were absent
in filesystem mode, while the actual inventory has 33 tools including two that
return unsupported errors. Documentation now matches the existing behavior;
no tool names or capabilities were changed.

## Verification details

Synthetic temporary vaults only; no application tests used the connected vault.
The separate Obsidian task update is documentation, not a test mutation.

- Linux Node 24.22.1: initial full suite passed all 416 tests across 18 suites.
- With final dependency versions, the first parallel full Node 20.20.2 run passed
  414/416; two 1,000-note search fixture tests exceeded the default five seconds.
  Running those tests in isolation with coverage passed all three selected cases
  in 3.43 seconds. Their fixture/rebuild budget is now 20 seconds; all existing
  filesystem-call counts and search assertions remain unchanged. This is not a
  relaxation of an edit-latency SLO (the tests assert operation counts).
- Final Node 20/22 results and reproducible candidate artifact identity are recorded
  in `issue-5-artifact.json` after verification.
- Full-project optional `npx tsc --noEmit -p tsconfig.json` reports nine existing
  test-only diagnostics. An archive of unmodified base main, using identical final
  dependencies, reports the exact same nine diagnostics after normalizing paths.
  They are in applyNoteEdits (2), searchConcurrency (1), filesystem (1),
  readNoteSection (3) and searchConsistency (2). No script/source diagnostics were
  added. Production `npm run build` is the configured compilation gate and passes.

The smoke checks the real tarball installed with production dependencies into a
fresh consumer, its own production audit, packaging allowlist, README/declaration
entrypoints, shebang/bin permissions, MCP package identity, list-tools and
create/read/replace/stale-conflict behavior through both npx executable names.
Neither real vault discovery nor inherited vault policy settings are used.

## Review and publication gates

Remaining: owner review, six-job remote CI on the final commit, intentional alpha
publication with source/provenance evidence, smoke of the published version/tag
and a subsequent npm.io index check. No PR URL exists for this local-only delivery.
Do not close #5 as fully accepted until its external release checks are recorded.
Exact alpha.0 publisher revision is historically unavailable; 137/138 dist files
match rebuilt 1edecc0 and the remaining diff is only server name/version.

K03/K04/#4 fixes have regression coverage. K06 (#17) and #14/#16/#18/#19/#20/#23
remain explicit production/stable release gates; this task does not repair those
issues or claim a production-safe release. See RELEASING.md for owner steps and
npm.io test-indicator investigation. No health-score change is promised.

To discard this change after review, revert the issue #5 commit and reinstall the
previous lockfile; no vault migration is involved. This would restore the old
package identity and dependency advisories. Do not use a source rollback as a
reason to republish the vulnerable historical artifact.


## PR #25 CI repair — 2026-10-24

Source of truth: [failed PR run 40046769357](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40046769357), head `9afa64c712b330594652f21382460cc0137b8653`. Its six jobs failed: Ubuntu Node 20/22 at production audit; macOS/Windows at tests, before lint/pack/audit/smoke. The [clean main run 40003243448](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40003243448) independently has green Ubuntu jobs and failed macOS/Windows tests. No gates are suppressed.

### Root causes and changes

1. **Dependency advisory:** the old lock pins Zod 4.3.6. Production audit reproduces GHSA-mrhx-c7xc-m3w5 (high, affected <4.6.6). Only Zod changes in package.json/lockfile: ^4.6.7, resolved 4.6.7. SDK 1.32.2 accepts `^3.25 || ^4.0` and shares this single deduplicated installation. Full and production audits pass without force, exclusions or audit suppression.
2. **Test path representation:** temp roots can use macOS /var vs /private/var or Windows short vs long names. Exact target spies missed authorized canonical opens, so failure injection and the parent-swap attack never ran, I/O counts were zero, and watcher signals were missed. Both fixture roots are now canonicalized once before spies/mutations. No authorization code, scope or operation-count assertion changes. The injected read-failure test also asserts exactly one failure injection.
3. **Watcher liveness:** capture/commit waits now have bounded, labeled deadlines; release runs in finally even if capture fails, and the pending write is drained before cleanup. The deliberate old-read/commit ordering is preserved.
4. **Windows handles:** native directory watchers can hold handles across directory rename/atomic replacement. Windows now uses Chokidar stat polling, avoiding native watch handles. Other platforms retain native watching; synchronous mutation reconciliation, symlink rejection and authorization remain unchanged. This costs polling work on Windows; no mutation retry or swallowed EPERM is introduced. Two added denial tests verify one rename attempt, unchanged bytes/revision/search, and temporary-file cleanup. Real Windows matrix results remain the validation gate for the platform fix.

### Local evidence

Linux disposable vaults only. Audit before fix: `npm audit --omit=dev --audit-level=high` fails with one high Zod advisory. A synthetic symlink temp root reproduces six of the exact CI failures:

```sh
TMPDIR=/tmp/vaultbridge-ci25/alias-tmp npx vitest run test/searchConsistency.test.ts test/securityBoundaries.test.ts -t 'reports a committed write if refresh|performance smoke|authorizes individual-file|rejects a parent replaced'
# before: 6 failed; after fixture/signal fixes: all selected cases pass
TMPDIR=/tmp/vaultbridge-ci25/alias-tmp npx vitest run test/searchConsistency.test.ts test/securityBoundaries.test.ts
# after: 89 passed (including the two added denial cases)
```

Node 20.20.2: `npm run build`, `npm test` (18 suites, **418 passed**, V8 coverage) and `npm run smoke:package` pass. Node 22.23.4 with npm 10.9.9: `npm run smoke:package` passes. Both installed executable names complete MCP initialize/list/create/read/replace/stale-conflict checks. Lint, dry-run/pack, full and production audit results and the replacement candidate identity are recorded in issue-5-artifact.json. Optional full-project typecheck limitations from the initial preparation remain outside the configured production build.

Remote repaired matrix is pending push/verification at this checkpoint. Node 20/22 CI and engines are unchanged; #23 still governs patched runtime support before release. No merge/publish/retag or #5 completion.


### Windows descriptor follow-up

Repair commit `3cc3abe81a88f0af571702ca8cb99a021cc633b3`, [run 40048673030](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40048673030): Ubuntu/macOS Node 20/22 passed every gate including smoke. Windows Node 20/22 each passed 416/418 tests; the only failures were the deliberately paused old-watcher-read cases, with ACCESS_DENIED at atomic replacement. The earlier directory rename, path matching and injection failures were gone.

The old search read kept its descriptor open while awaiting the final authorization/publication check. A deterministic two-mode Linux regression (`npx vitest run test/searchConsistency.test.ts -t 'closes the index read handle'`) failed **2/2 before the fix**: the final check observed an open handle. Search now captures the bytes and descriptor identity, closes in finally, then validates current path identity/size/policy before publishing. No file handle is retained across the deliberate final-check pause, so Windows replacement can commit. Checks before opening and after reading, symlink rejection, ordered reconciliation and fail-closed error behavior are retained. Permission failures are neither retried nor swallowed.

After the fix, the aliased-temp-root focused suite passes **91/91**, including the original race/attack tests and both new descriptor-lifetime cases. Lint and production build pass. Updated full-suite, smoke, audit, artifact and remote results are recorded below/in issue-5-artifact.json as they complete. All earlier snapshot results are historical, not proof of the current head.


Descriptor follow-up local validation: Node 22.23.4 full V8 suite **420/420 passed** across 18 suites (89.60s). Node 20.20.2 installed-tarball smoke passes for both aliases on the updated candidate. Lint/build, clean pack/dry-run integrity match, and full/production audits pass. Updated two-mode descriptor regression was rerun after the lint-only binding correction and passes. Repaired remote matrix pending this follow-up push.


## Verified remote repair result

Implementation commits: `3cc3abe81a88f0af571702ca8cb99a021cc633b3` (Zod/canonical fixtures/bounded signals/Windows polling) and `d296d59a38903b0a80eef70f110e5b5f78b86e7c` (descriptor lifetime and regression). [PR run 40049159198](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198) **completed successfully on d296d59**. Job logs were read to verify actual test counts and both smoke executable results, rather than inferring smoke success from a green test step.

| Remote job | Actual Node | Tests | Build/lint/pack/audit | Installed tarball npx smoke |
| --- | --- | --- | --- | --- |
| [test (ubuntu-latest, 22)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737667821) | 22.23.3 | 420/420 | passed | both aliases passed |
| [test (macos-latest, 22)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737667838) | 22.23.4 | 420/420 | passed | both aliases passed |
| [test (windows-latest, 20)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737667844) | 20.20.2 | 420/420 | passed | both aliases passed |
| [test (windows-latest, 22)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737667953) | 22.23.4 | 420/420 | passed | both aliases passed |
| [test (ubuntu-latest, 20)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737668002) | 20.20.2 | 420/420 | passed | both aliases passed |
| [test (macos-latest, 20)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40049159198/job/120737668016) | 20.20.2 | 420/420 | passed | both aliases passed |

Every job passed these unchanged CI gates: `npm ci`, `npm run build`, `npm test`, `npm run lint`, `npm pack --dry-run`, `npm audit --omit=dev --audit-level=high`, and `npm run smoke:package`. The smoke installs its actual tarball plus production dependencies into a separate disposable consumer/vault, audits that consumer, and performs both executable MCP round trips. Local full audit also reports zero advisories; CI's explicit gate is the production audit. No audit bypass, test skip, timeout blanket, OS exclusion or runtime-support change was added.

The Linux/macOS tarball integrity matches the locally repeated clean pack: `sha512-JoD4J4rJOsm7Q+OdpDWz2MOj/L9DFNlvVtBTfj8BF1fIjD6cKpgD7h6mo7O+89EapYs20bED5Z5vx/hn06cI3g==`. Both Windows jobs independently packed and smoke-tested `sha512-mAaOcAtU3oM8vTD425fxuUo7oG+Xgq46pXR7uLk6SRQnUVmFIptLJ4e9Gry7XzTnzk6vyM+1UCsPbN2bGjiFdg==`. Per-platform checksums and job URLs are preserved in issue-5-artifact.json. The final documentation-only handoff commit preserves the verified application/package contents.

Remaining gates: human review of PR #25 and the release/safety work described in RELEASING.md, including #23's patched-runtime decision. PR #25 and issue #5 stay open. This repair does not merge, publish npm, change alpha/latest, or mark the release accepted. Candidate remains 0.1.0-alpha.1 with the legacy executable alias.
