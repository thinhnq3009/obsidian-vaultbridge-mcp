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
