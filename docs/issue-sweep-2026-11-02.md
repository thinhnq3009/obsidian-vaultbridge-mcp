# Open-issue sweep — November 2, 2026

Repository: `thinhnq3009/obsidian-vaultbridge-mcp` (the local Git remote still
uses the former repository name). Starting revision: `e973ce9` on `develop`.
Work branch: `codex/fix-open-issues`.

This is an implementation/triage snapshot, **not** a claim that every open
issue is fixed, reviewed, merged, or approved for release. No GitHub issue or
review thread was closed and no security alert was dismissed by this sweep.

## Implemented locally

| Issue | Change | Regression coverage |
| --- | --- | --- |
| #64 | Rejected budget requests preserve the refilled fractional balance instead of deducting a token. | Half-second sustained rejection/refill, global/client/attempt keys, burst cap, independent keys and expired-map cleanup. |
| #78 | Every filesystem mutation acquires the same canonical-vault lock before its legacy path lock; path authorization is checked again after acquisition. | Move versus destination create, source/destination replacement in both schedules, competing moves across backend instances, directory/descendant and in-vault alias conflicts. |
| #79 | Bounded descriptor reads hash raw bytes before UTF-8 decoding; no-op text operations retain the revision of the unchanged bytes. | Invalid UTF-8 collisions, stale binary delete/move/overwrite rejection, unchanged valid UTF-8/BOM/CRLF revisions and byte-preserving no-ops. |

Vault-wide serialization intentionally favors integrity over parallel mutation
throughput. Readers remain concurrent. Processes must share the canonical vault
and cache directory; older server versions, external writers and different cache
directories are not fully coordinated. This is not an OS sandbox or a solution
to every external filesystem race.

## Remaining issues — not completed by this sweep

| Issue | Required follow-up |
| --- | --- |
| #55 | Remediate/review owner-storage pathname check/use races and verify final-SHA CodeQL evidence. |
| #56 | Remediate/review session-key and SQLite initialization races, including missing-key fail-closed behavior and supported OS permissions. |
| #57 | Review the exact file-to-HTTP flow and final-SHA scan evidence; any false-positive disposition requires reviewer approval. |
| #60 | Satisfy the maintained provider's grant-family revocation/concurrency contract. Preserve the explicit OAuth opt-in and truthful failing diagnostics; do not fork/patch the provider or relax the requirement without approval. |
| #46 | Reconcile implemented owner persistence/UI with the complete acceptance list and unresolved storage security follow-ups. |
| #47 | Reconcile implemented experimental OAuth with lifecycle acceptance; #60 is not solved by local vault-grant denial. |
| #48 | Reconcile implemented request-scoped authorization with full acceptance and token/grant revocation limitations. |
| #49 | Complete real-client/browser/HTTPS evidence, multi-agent benchmark, six-cell OS/Node CI, security review and explicit release approval. Local unit tests are not a substitute. |
| #39 | Parent delivery/release acceptance depends on the AUTH issues above; do not close because source modules exist. |
| #5 | Historical alpha artifact provenance and external npm.io recognition/index follow-ups remain; the published v0.1.0 evidence does not retroactively attest alpha.0. |

GitHub alert API reads on November 2 showed alerts **7, 8 and 9 dismissed** on
October 27 with reason `used in tests` and comment
`Created issue. Will be fix later`. These historical dispositions are **not**
evidence of remediation; production storage findings #55/#56 still need work.

## Execution limitations

- Subagent launch failed twice because the inherited `gpt-6.1-sol` identifier
  was not accepted by the agent runtime. No child agent was actually launched.
- The required ChatGPT review workflow is unavailable locally (`c2c` executable
  absent). Automated validation is not an independent security review.
- GitNexus repository discovery returned an internal error. Changes were based
  on source inspection and executable regression tests, not graph assurances.
- No merge, publication, dependency upgrade or deployment was performed.

## Local validation

Linux, Node 24.22.1:

- `npm run build` — passed (server and owner UI).
- `npm run lint` — passed.
- `npm test -- --maxWorkers=2` — 42 files passed; 767 tests passed,
  one skipped. This does not run or satisfy the separate known-failing
  provider revocation diagnostic.
- `npm run smoke:package` — passed for both executable names using a newly
  packed tarball and disposable MCP round trips.
- `git diff --check` — passed.

On both Node 22.23.4 and Node 24.22.1,
`npx vitest run test/requestBudgets.test.ts test/binaryRevisions.test.ts test/mutationConcurrency.test.ts test/lockSecurity.test.ts --maxWorkers=2`
passed all 25 tests. Windows/macOS CI, final-SHA CodeQL and independent review
have not been run for these changes.
