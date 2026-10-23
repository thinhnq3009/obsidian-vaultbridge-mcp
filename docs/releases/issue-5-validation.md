# Issue #5 — release preparation handoff

Status: IMPLEMENTED_AWAITING_REVIEW. No push, PR, merge, tag change or publication.

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
