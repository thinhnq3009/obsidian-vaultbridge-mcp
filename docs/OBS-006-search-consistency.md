# OBS-006 implementation evidence

Status: **IMPLEMENTED_AWAITING_REVIEW**. Tested on 2026-10-21 with Node v24.20.0,
using disposable synthetic vaults only. No push, PR, merge or publication.

## Source and baseline

- Repository: https://github.com/thinhnq3009/obsidian-vaultbridge-mcp
- Updated local `main` with `git fetch origin`, `git switch main`, and
  `git pull --ff-only origin main` before creating the task branch.
- Base: `d03d9fb0b6da6ece075e601b045af84c63a500fe`.
- Branch: `codex/obs-006-search-consistency`. The implementation commit is
  recorded in the Obsidian task Handoff and the branch's Git history.
- Base contains OBS-002 metadata, OBS-003 timestamps, OBS-004/005 tools, and
  the search/root security hardening. OBS-004/005 are tested where present;
  they introduce no new dependency for search synchronization.
- Metadata discrepancy: this checkout still declares `obsidian-local-rest-mcp`
  version `1.0.0` and legacy URLs in `package.json`. Direct `npm view
  obsidian-vaultbridge-mcp version dist-tags repository gitHead --json` returned
  `0.1.0-alpha.0` for both alpha/latest, a legacy repository URL, and no gitHead.
  The released package cannot be mapped to this source SHA from that evidence.
  The owner-specified VaultBridge remote is the development target; package
  migration/release metadata is outside OBS-006.
- GitNexus `list_repos` returned Internal error. Source tracing and actual local
  tests supply the evidence here; no GitNexus index freshness is claimed.

## Root cause and change

`VaultSearchService` stores a documents Map and MiniSearch index. Scan mode also
reads that snapshot. `writeFile`, `updateTextFile`, `movePath`, and `deletePath`
previously committed filesystem changes without updating it. Watcher refreshes
were asynchronous; `unlink` blindly discarded a path and concurrent refreshes
could publish an earlier read after a newer update. `upsert` also swallowed
unexpected refresh/persistence errors.

Committed mutations now await targeted reconciliation inside the existing lock.
Content writes refresh one path; moves reconcile both endpoints, and directory
operations remove cached descendants and walk only affected readable subtrees.
Canonical paths handle writes through permitted in-vault directory aliases;
alias entries themselves remain excluded from search. No-op writes skip both
atomic writes and synchronization; precommit failures never synchronize.

Search, mutation reconciliation, watcher reconciliation and rebuild share a queue.
Delayed add/change/unlink/unlinkDir events reconcile present filesystem state.
The incidental full scan on an empty search snapshot was removed: startup,
watcher events and explicit rebuild own external-change discovery.

Disk cache bodies were already discarded at startup. On mutation the old snapshot
is invalidated once; fresh snapshots are written on close/rebuild or authorization
pruning. Ordinary note edits no longer persist/prune the entire index. Existing
revision checks, locks, atomic writes, timestamp preparation and access policy
remain in use.

If invalidation/refresh fails after commit, the mutation throws `INDEX_ERROR` with
`details.committed=true`; its tool-visible message explicitly states that the
filesystem committed and instructs reading current state/revision before retry.
Status becomes degraded and searches fail closed until a successful rebuild.
Subsequent commits also report the unrecovered index failure rather than claiming
success. A failed rebuild/persist keeps queries blocked. No filesystem rollback
is attempted after commit.

## Query contract

| Entry point | Scan | Indexed |
| --- | --- | --- |
| Simple `obsidian_search` | Existing case-insensitive path/content substring | Existing MiniSearch fuzzy 0.2, prefix, relevance scoring |
| Advanced `query` | Literal path/content substring | Same literal qualification; bypass fuzzy candidates |
| `case_sensitive` | Query substring and content regex honor case | Same; previously ignored for indexed query text |
| folder/tag/frontmatter | Exact qualification before pagination | Same |
| Ordering/cursor | Path ordering for exact-score ties; offset cursor | Same for advanced; fuzzy relevance for simple |

The internal `SearchQuery.match="exact"` flag is selected by the advanced tool;
no tool input/output schema changed. Advanced indexed qualification/ranking is an
intentional documented correction: typo matches now require simple fuzzy search.
An old query may legitimately match new text fuzzily; exact tests distinguish
that from a stale document. Tags strip one optional leading `#`, retain case and
Unicode code points, and frontmatter retains existing JSON equality semantics.
Cursors assume an unchanged result set between pages.

## Regression and verification evidence

Before implementation, `npx vitest run test/searchConsistency.test.ts` ran eight
freshness/move regressions on the base: **8 failed**, for scan/indexed × watch
on/off. Create returned `[]` instead of `Notes/Việt.md`; overwrite-move returned
`[]` instead of the new destination containing the source. A separate baseline
run of exact/case tests with the original filesystem/search sources restored
reported **2 failed, 2 passed**: indexed mode ignored case-sensitive text
qualification. Fixed sources were restored immediately after that probe.

Final results:

| Command | Actual result |
| --- | --- |
| `npx vitest run test/searchConsistency.test.ts` | 38 passed |
| `npm run lint` | Exit 0 |
| `npm test` | Exit 0; 18 files, 388 tests passed with V8 coverage |
| `npm run build` | Exit 0 |
| `git diff --check` | Exit 0 |

The final focused run followed a lint-only correction to an injected persistence
failure predicate in the test. Production sources were unchanged after the full
suite. V8 search.ts coverage: see the generated local coverage report; total
project statement coverage was 80.33%, line coverage 81.65% (no minimum configured).

Coverage includes create/replace/append/heading/frontmatter/atomic edits, timestamps,
file overwrite/rename/move, nested directory moves and recursive deletion, content
and metadata removal, both modes/watch settings, delayed events and an explicitly
paused old watcher read, concurrent revision conflicts, no-op and failed atomic
writes, read-only/size failures, read/write scope transitions, canonical aliases,
external symlink rejection, reserved folders, uppercase Markdown extensions,
Unicode/case/regex, combined filters, stable pagination, MCP response contracts,
refresh/cache/rebuild failures, empty snapshots and auto-mode threshold behavior.
Existing safety, Local REST, STDIO and HTTP suites also passed.

## Performance smoke

The test spies on actual filesystem calls during a single-note replace after
startup. It asserts one index body read, one atomic temporary-file open, and zero
`readdir` calls. Thus neither unrelated note bodies nor directories are scanned
by the write. Measurements include lock acquisition, timestamping, fsync/rename
and reconciliation; they exclude the later search/close.

| Auto-mode synthetic vault | Effective mode | Refreshed documents | Directory reads | Edit latency, final full-suite sample |
| --- | --- | --- | --- | --- |
| 10 notes | scan | 1 | 0 | 10.92 ms |
| 1,000 notes | indexed | 1 | 0 | 26.10 ms |

These are smoke samples, not latency guarantees. Directory reconciliation checks
cached path prefixes (O(cached documents)) and walks affected readable subtrees.
Queries still perform the existing authorization-pruning pass; the single-note
write proof does not assert constant-time searches or directory moves.

## Changed files

- `src/backend/filesystem.ts`: postcommit reconciliation and committed-error reporting.
- `src/backend/search.ts`: ordered targeted reconciliation, cache lifecycle, exact qualification.
- `src/backend/types.ts`: internal exact qualification selector.
- `src/tools/searchContentAdvanced.ts`: selects exact qualification.
- `test/searchConsistency.test.ts`: new regression/contract/performance coverage.
- `test/regressionSafety.test.ts`: replaces K04 stale-behavior characterization with the fixed expectation.
- `README.md`: consistency, semantics, cache and failure contracts.
- `docs/OBS-006-search-consistency.md`: this evidence.

## Risks, limits and rollback

- The ordered queue trades parallel refresh throughput for consistency; large
  explicit rebuilds/subtree moves can delay queries and mutation acknowledgements.
- Guarantee applies to successful mutations in one filesystem backend instance.
  External editors are eventual through the watcher (manual rebuild with watch
  off). Multiple processes and Local REST have independent consistency semantics.
- Scope/path checks are preserved, not an OS sandbox against hostile filesystem
  replacement races. Tests ran on Linux; Windows junction behavior was not run.
- A postcommit failure requires inspecting current filesystem state and rebuilding
  before retry; blindly retrying append/move can duplicate work or conflict.
- Advanced indexed literal qualification deliberately changes its old implicit
  fuzzy results/ranking; schemas and simple fuzzy behavior remain compatible.
- To roll back code after integration, revert the OBS-006 implementation commit
  and rebuild/restart. This restores the prior search staleness; it does not undo
  any note mutations. Search cache can be regenerated by restart/rebuild; never
  restore stale note contents to repair an index. No vault migration is needed.


## Review follow-up — 2026-10-22

Reviewed starting head: `f7e2def0e94c799530e20e55703a2218abf781ec`;
base/main remains `d03d9fb0b6da6ece075e601b045af84c63a500fe`. This is an
additional local commit on the same branch, with its SHA recorded in the Obsidian
review and task Handoff. Earlier implementation evidence above is retained.
The original implementation was subsequently pushed with owner authorization;
this follow-up has not been pushed and no PR has been created.

| Finding | Result | Change / evidence |
| --- | --- | --- |
| F1 | FIXED | `src/backend/search.ts:193` avoids expanding final-component symlink targets while preserving canonical target reconciliation for parent-directory aliases, including unreadable/excluded aliases. `:198`, `:226`, `:333`, `:472` classify only ENOENT/ENOTDIR/ELOOP as unavailable paths; valid-path EIO still poisons the index and requires rebuild. Real cyclic/broken/outside symlinks with deterministic watcher-handler delivery, injected realpath/lstat ELOOP, ineligible-link EACCES and valid-path EIO tested in both modes. |
| F2 | FIXED, measured limited optimization | `src/backend/search.ts:114` batches at most 50 already-waiting queries into one freshly authorized snapshot. A batch seals before authorization starts; projections are synchronous; `:91` rebuild and `:180` synchronization seal batches at queue barriers. No authorization TTL, scope bypass or policy change. Tests check fresh next-burst authorization, watcher/rebuild ordering, rejected link replacements and invalid-query isolation. |
| F3 | FIXED | `src/backend/filesystem.ts:281` skips ordinary non-Markdown synchronization; `src/backend/search.ts:373` filters non-Markdown file watcher events. Moves with either Markdown endpoint and subtree operations still synchronize. Regression asserts zero synchronization/cache invalidation for canvas/txt/bin create/replace/append and validates .MD ↔ .txt transitions and subtree deletion. |
| F4 | BLOCKED | No authorized follow-up PR. GitHub PR search empty; reviewed head has zero Actions runs, check-runs or statuses. Actions are enabled; this is not a CI PASS. New local head has NOT_RUN CI. No merge, tag or publish. |

The full final follow-up regression subset was rerun against the reviewed
filesystem/search sources: **12 failed, 12 passed** (24 selected); restored
fixed files then ran **66/66 focused tests PASS** (87 with security boundaries). Full suite: **18 files,
416 tests PASS**, V8 statement coverage 80.77%, lines 81.99%. Lint, build and
`git diff --check` passed. The full suite used the same production sources;
a baseline-source repro was restored byte-for-byte before the focused rerun.
Four additional scope regressions preserve writes through unreadable/excluded
parent-directory aliases into authorized canonical targets. Canonical target
expansion therefore cannot be gated solely by the alias read scope. Complete
lint/build/test and the 72-case benchmark used the final production sources. Only evidence additions followed these checks.

ChatGPT review workflow was attempted per repository guidance. No workspace-bound
ChatGPT session/connector exists, so delegation was unavailable; this limitation
was reported before direct source/test verification. No independent ChatGPT
review is claimed.

### Concurrent benchmark method

Runner: `test/benchmarks/searchConcurrency.ts` (not an automatic Vitest test).
Raw evidence: [reviewed](benchmarks/OBS-006-reviewed.jsonl),
[follow-up](benchmarks/OBS-006-followup.jsonl),
[repeat](benchmarks/OBS-006-repeat.jsonl). Each JSONL begins with environment/config
metadata and contains every request-count, duration, QPS, p50/p95/p99, auxiliary
latency and authorization counter for its cells.

Commands (use Node/npm on PATH):

```bash
node --import tsx test/benchmarks/searchConcurrency.ts --label=reviewed-f7e2def --scenarios=queries
node --import tsx test/benchmarks/searchConcurrency.ts --label=followup-final --scenarios=queries,write,watcher,rebuild
node --import tsx test/benchmarks/searchConcurrency.ts --label=followup-repeat-final --sizes=10000 --concurrency=50 --rounds=3 --scenarios=queries
```

The first run loaded the unmodified reviewed production sources at process
startup, before fixes were applied. To reproduce that baseline separately, copy
the runner into an isolated checkout at the reviewed SHA with its dependencies;
do not change main or reset the current work. There were 18 baseline cells
(378 requests), 72 after cells (1,512 requests) and 2 repeated cells (300 requests).
No requested size/mode/concurrency/after-scenario cell was omitted. Before-work
comparisons are query-only; no pre-fix write/watcher/rebuild latency claim is made.

Environment: Node v24.20.0, Linux 7.0.0-38-generic, x64, 8 available CPUs.
Both scan/indexed, watch on; 1k/5k/10k synthetic Markdown notes, up to one additional
watcher control note. Warm snapshot, fresh filesystem authorization, exact query
matching all fixture notes, tag/frontmatter qualification, path sort and limit 20.
No coverage instrumentation. Counts are max(3, concurrency) per cell; the repeat
uses 3 waves (150 requests/mode). Percentiles are empirical nearest rank; with
small samples p95/p99 equal the max and are not statistically reliable SLO tails.
This is a reproducible host-load smoke, not a controlled capacity/SLO guarantee.

QPS uses query requests divided by their wall-clock completion duration. Auxiliary
work starts before dispatch: an MCP replace, external watcher update (polled until
visible) or a queued rebuild. `Aux ms` measures its own completion; raw `allWorkMs`
includes both sides. Thus rebuild-blocked query latency is included, while a write
or watcher completion may outlast the query wave. Watcher polling searches are
excluded from reported request counts/QPS but included in authorization counters;
400 ms debounce settling outside timed cells separates after-run measurements.
Startup, cache flush and teardown are excluded. Before/after include ordinary
shared-host variability; the largest query-only case was repeated after checks.

The measured bottleneck was repeated full-map filesystem authorization, not note
body indexing: before, 50 simultaneous queries rechecked every cached path 50
times. The limited batching optimization still checks every path and does not
reuse authorization for a new batch. Single-client latency remains O(vault size);
large rebuilds still block queries for seconds. All result projections in a batch
use the same checked snapshot without an asynchronous gap between responses.

### Before/after simultaneous-query comparison

| Notes | Mode | C | Before QPS | After QPS | Before p95 ms | After p95 ms | Auth checks before → after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | scan | 50 | 32.83 | 723.35 | 1462.66 | 69.07 | 50000 → 1001 |
| 1000 | indexed | 50 | 33.11 | 739.22 | 1452.05 | 67.58 | 50000 → 1001 |
| 5000 | scan | 50 | 6.63 | 147.52 | 7238.21 | 338.9 | 250000 → 5001 |
| 5000 | indexed | 50 | 6.32 | 148.01 | 7594.9 | 337.77 | 250000 → 5001 |
| 10000 | scan | 50 | 3.11 | 76.71 | 15458.93 | 651.75 | 500000 → 10001 |
| 10000 | indexed | 50 | 3.18 | 69.15 | 15087.83 | 723.03 | 500000 → 10001 |

### Complete after matrix

All rows below use watch on. `queries` means no auxiliary work.

| Notes | Mode | C | Concurrent work | Requests | Duration ms | QPS | p50 ms | p95 ms | p99 ms | Aux ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | scan | 1 | queries | 3 | 94 | 31.91 | 31.23 | 32.87 | 32.87 | 0.08 |
| 1000 | scan | 1 | write | 3 | 134.12 | 22.37 | 34.22 | 67.11 | 67.11 | 69.26 |
| 1000 | scan | 1 | watcher | 3 | 129.94 | 23.09 | 35.21 | 60.62 | 60.62 | 324.38 |
| 1000 | scan | 1 | rebuild | 3 | 562.28 | 5.34 | 36.51 | 494.88 | 494.88 | 457.62 |
| 1000 | scan | 10 | queries | 10 | 45.48 | 219.9 | 45.42 | 45.43 | 45.43 | 0.06 |
| 1000 | scan | 10 | write | 10 | 81.26 | 123.06 | 81.13 | 81.14 | 81.14 | 83.17 |
| 1000 | scan | 10 | watcher | 10 | 65.66 | 152.3 | 65.52 | 65.54 | 65.54 | 317 |
| 1000 | scan | 10 | rebuild | 10 | 498.95 | 20.04 | 498.9 | 498.9 | 498.9 | 458.94 |
| 1000 | scan | 50 | queries | 50 | 69.12 | 723.35 | 69.06 | 69.07 | 69.08 | 0.07 |
| 1000 | scan | 50 | write | 50 | 94.1 | 531.36 | 93.93 | 93.93 | 93.94 | 96.11 |
| 1000 | scan | 50 | watcher | 50 | 91.84 | 544.45 | 91.65 | 91.66 | 91.68 | 292.62 |
| 1000 | scan | 50 | rebuild | 50 | 503.34 | 99.34 | 503.22 | 503.23 | 503.24 | 434.31 |
| 1000 | indexed | 1 | queries | 3 | 93.21 | 32.19 | 29.7 | 34.53 | 34.53 | 0.04 |
| 1000 | indexed | 1 | write | 3 | 132.41 | 22.66 | 31.08 | 71.38 | 71.38 | 72.65 |
| 1000 | indexed | 1 | watcher | 3 | 122.43 | 24.5 | 32.93 | 57.23 | 57.23 | 375.31 |
| 1000 | indexed | 1 | rebuild | 3 | 562.69 | 5.33 | 29.81 | 503.65 | 503.65 | 474.62 |
| 1000 | indexed | 10 | queries | 10 | 39.73 | 251.71 | 39.68 | 39.69 | 39.69 | 0.08 |
| 1000 | indexed | 10 | write | 10 | 64.88 | 154.13 | 64.73 | 64.74 | 64.74 | 66.23 |
| 1000 | indexed | 10 | watcher | 10 | 62.36 | 160.37 | 62.24 | 62.25 | 62.25 | 307.81 |
| 1000 | indexed | 10 | rebuild | 10 | 468.21 | 21.36 | 468.16 | 468.17 | 468.17 | 432.33 |
| 1000 | indexed | 50 | queries | 50 | 67.64 | 739.22 | 67.58 | 67.58 | 67.6 | 0.07 |
| 1000 | indexed | 50 | write | 50 | 111.1 | 450.04 | 110.77 | 110.98 | 110.99 | 112.67 |
| 1000 | indexed | 50 | watcher | 50 | 96.24 | 519.52 | 96.1 | 96.11 | 96.12 | 288.29 |
| 1000 | indexed | 50 | rebuild | 50 | 525.45 | 95.16 | 525.4 | 525.4 | 525.41 | 459.54 |
| 5000 | scan | 1 | queries | 3 | 426.47 | 7.03 | 143.23 | 144.86 | 144.86 | 0.03 |
| 5000 | scan | 1 | write | 3 | 593.47 | 5.06 | 164.22 | 276.69 | 276.69 | 278.36 |
| 5000 | scan | 1 | watcher | 3 | 605.58 | 4.95 | 164.65 | 281.73 | 281.73 | 757.73 |
| 5000 | scan | 1 | rebuild | 3 | 2473.12 | 1.21 | 157.35 | 2168.53 | 2168.53 | 2015.8 |
| 5000 | scan | 10 | queries | 10 | 188.47 | 53.06 | 188.44 | 188.45 | 188.45 | 0.04 |
| 5000 | scan | 10 | write | 10 | 342.76 | 29.18 | 340.57 | 342.66 | 342.66 | 344.15 |
| 5000 | scan | 10 | watcher | 10 | 347.58 | 28.77 | 347.39 | 347.39 | 347.39 | 683.05 |
| 5000 | scan | 10 | rebuild | 10 | 2343.78 | 4.27 | 2343.7 | 2343.72 | 2343.72 | 2150.16 |
| 5000 | scan | 50 | queries | 50 | 338.94 | 147.52 | 338.9 | 338.9 | 338.91 | 0.06 |
| 5000 | scan | 50 | write | 50 | 465.86 | 107.33 | 465.75 | 465.76 | 465.77 | 467.45 |
| 5000 | scan | 50 | watcher | 50 | 452.15 | 110.58 | 451.97 | 451.98 | 451.99 | 803.08 |
| 5000 | scan | 50 | rebuild | 50 | 2566.41 | 19.48 | 2566.35 | 2566.35 | 2566.35 | 2241.1 |
| 5000 | indexed | 1 | queries | 3 | 468.65 | 6.4 | 152.35 | 169.17 | 169.17 | 0.09 |
| 5000 | indexed | 1 | write | 3 | 594.4 | 5.05 | 156.3 | 282.84 | 282.84 | 285.14 |
| 5000 | indexed | 1 | watcher | 3 | 723.87 | 4.14 | 277.45 | 289.68 | 289.68 | 723.86 |
| 5000 | indexed | 1 | rebuild | 3 | 2628.97 | 1.14 | 149.37 | 2330.55 | 2330.55 | 2184.47 |
| 5000 | indexed | 10 | queries | 10 | 188.61 | 53.02 | 188.57 | 188.59 | 188.59 | 0.05 |
| 5000 | indexed | 10 | write | 10 | 313.28 | 31.92 | 313.16 | 313.18 | 313.18 | 315.42 |
| 5000 | indexed | 10 | watcher | 10 | 306.66 | 32.61 | 306.55 | 306.56 | 306.56 | 626.02 |
| 5000 | indexed | 10 | rebuild | 10 | 2351.38 | 4.25 | 2351.29 | 2351.29 | 2351.29 | 2172.02 |
| 5000 | indexed | 50 | queries | 50 | 337.81 | 148.01 | 337.77 | 337.77 | 337.78 | 0.05 |
| 5000 | indexed | 50 | write | 50 | 454.95 | 109.9 | 454.85 | 454.86 | 454.87 | 456.4 |
| 5000 | indexed | 50 | watcher | 50 | 460.9 | 108.48 | 460.65 | 460.67 | 460.7 | 785.04 |
| 5000 | indexed | 50 | rebuild | 50 | 2562.96 | 19.51 | 2562.9 | 2562.91 | 2562.92 | 2218.36 |
| 10000 | scan | 1 | queries | 3 | 870.53 | 3.45 | 290.48 | 291.39 | 291.39 | 0.03 |
| 10000 | scan | 1 | write | 3 | 1170.01 | 2.56 | 309.52 | 552.33 | 552.33 | 556.35 |
| 10000 | scan | 1 | watcher | 3 | 1430.45 | 2.1 | 546.88 | 584.02 | 584.02 | 1430.45 |
| 10000 | scan | 1 | rebuild | 3 | 5197.52 | 0.58 | 444.23 | 4469.73 | 4469.73 | 4139.89 |
| 10000 | scan | 10 | queries | 10 | 368.61 | 27.13 | 368.58 | 368.59 | 368.59 | 0.05 |
| 10000 | scan | 10 | write | 10 | 609.77 | 16.4 | 609.66 | 609.67 | 609.67 | 612.54 |
| 10000 | scan | 10 | watcher | 10 | 642.14 | 15.57 | 642.01 | 642.02 | 642.02 | 1294.87 |
| 10000 | scan | 10 | rebuild | 10 | 4432.35 | 2.26 | 4432.31 | 4432.32 | 4432.32 | 4051.51 |
| 10000 | scan | 50 | queries | 50 | 651.79 | 76.71 | 651.74 | 651.75 | 651.76 | 0.06 |
| 10000 | scan | 50 | write | 50 | 931.08 | 53.7 | 930.96 | 930.97 | 930.98 | 932.23 |
| 10000 | scan | 50 | watcher | 50 | 904.48 | 55.28 | 904.34 | 904.35 | 904.37 | 1522.6 |
| 10000 | scan | 50 | rebuild | 50 | 4924.31 | 10.15 | 4924.26 | 4924.26 | 4924.27 | 4203.77 |
| 10000 | indexed | 1 | queries | 3 | 908.17 | 3.3 | 300.62 | 308.33 | 308.33 | 0.04 |
| 10000 | indexed | 1 | write | 3 | 1160.49 | 2.59 | 304.01 | 553.18 | 553.18 | 554.6 |
| 10000 | indexed | 1 | watcher | 3 | 1424.36 | 2.11 | 535.81 | 588.11 | 588.11 | 1424.36 |
| 10000 | indexed | 1 | rebuild | 3 | 5308.76 | 0.57 | 299.67 | 4714.5 | 4714.5 | 4420.02 |
| 10000 | indexed | 10 | queries | 10 | 378.65 | 26.41 | 378.62 | 378.63 | 378.63 | 0.04 |
| 10000 | indexed | 10 | write | 10 | 645.45 | 15.49 | 645.35 | 645.36 | 645.36 | 646.97 |
| 10000 | indexed | 10 | watcher | 10 | 656.15 | 15.24 | 656.03 | 656.05 | 656.05 | 1297.21 |
| 10000 | indexed | 10 | rebuild | 10 | 4831.53 | 2.07 | 4831.46 | 4831.47 | 4831.47 | 4455.47 |
| 10000 | indexed | 50 | queries | 50 | 723.07 | 69.15 | 723.02 | 723.03 | 723.04 | 0.06 |
| 10000 | indexed | 50 | write | 50 | 1019.28 | 49.05 | 1019.1 | 1019.11 | 1019.13 | 1020.49 |
| 10000 | indexed | 50 | watcher | 50 | 983.08 | 50.86 | 982.92 | 982.94 | 982.95 | 1640.45 |
| 10000 | indexed | 50 | rebuild | 50 | 5200.41 | 9.61 | 5200.35 | 5200.36 | 5200.37 | 4523.93 |

Largest query-only repeat (150 requests per mode): scan 65.8 QPS, p50/p95/p99 761.28/765.06/765.07 ms; indexed 64.44 QPS, p50/p95/p99 777.88/787.72/787.72 ms; both used 30,000 authorization checks across three 50-query bursts. This corroborates the improvement without claiming tail SLOs.

### Remaining gate and rollback

Recommendation: **REQUEST_CHANGES / hold merge for F4**. Owner authorization for
follow-up push/PR, passing CI on that exact head (configured Linux/macOS/Windows ×
Node 20/22), feedback review and mergeability checks remain outstanding. Read-only
GitHub inspection found Actions enabled but no runs/checks/statuses on reviewed
head; do not infer CI success from local checks or pipeline configuration.

Rollback only this follow-up commit to return to `f7e2def` behavior; rebuild and
restart. This reintroduces F1/F3 and serialized-query cost; it changes no vault
data. Do not revert the original implementation merely to undo these follow-up
changes. Existing one-process, external-watcher, cursor and hostile filesystem
race limits still apply; Windows symlink behavior awaits CI.
