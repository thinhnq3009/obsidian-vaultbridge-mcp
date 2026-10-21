# OBS-003 write pipeline audit

Base: `07fce3a4a331d5b20f56373582535e3960f77696` (main after merged PR #2).

| Entry point | Filesystem path | Timestamp behavior |
| --- | --- | --- |
| Note create/replace | `writeNote` → `writeFile` | Final preparation under path lock |
| Direct file writes | `writeFile` | Same preparation, only `.md` (case-insensitive) |
| Append | `appendToNote` → `updateTextFile` | Transform/revision validation, final preparation |
| Heading patch | `patchHeading` → `updateTextFile` | Same; invalid/ambiguous selection never writes |
| Frontmatter patch | `patchFrontmatter` → `updateTextFile` | Same; reserved field/children denied |
| Bulk | Tool's sequential `writeNote` calls | Per-file transactions; successes before an error remain, later files are not attempted |
| Canvas tools | `canvasCommon` → `writeFile` | No timestamp for `.canvas` |
| Move/rename/delete/folder | `movePath`, `deletePath`, `createFolder` | No Markdown content rewrite, no timestamp |
| Cache/locks/health probes | Direct fs calls, outside note content | No timestamp |

Both content-write funnels validate the final UTF-8 size immediately before the
single `atomicWrite`. Final persisted bytes supply the revision hash. Replacement
and transformed writes still require current revision before no-op detection.
No-op compares exact body and BOM plus parsed YAML properties after excluding the
reserved field. Integers are parsed as `bigint`; decimal floats are read from
their exact YAML scalar source. Both normalize to a distinct internal numeric
type containing a decimal coefficient and exponent. This avoids using rounded
JavaScript numbers for equality and preserves numeric no-ops such as
`9007199254740993` versus `9007199254740993.0`, including nested values and aliases.
Fractions, overflow and underflow exponents also retain exact identity without
expanding the exponent into a large string or integer. Negative zero retains
its sign; explicit infinities and NaN retain their existing comparison behavior.
Formatting/comment-only replacements are no-ops. Missing frontmatter
and an empty mapping are equivalent. No-op keeps the original bytes, mtime and
revision, including notes that have never had a timestamp.

Parser-level duplicate checks are deferred because they compare rounded values.
After numeric normalization, every mapping is checked for equivalent keys,
including aliases and nested mappings. Collisions fail with `INVALID_MARKDOWN`
before no-op comparison or persistence. Comparison uses `Map` rather than object
properties, so distinct numeric, string and collection keys cannot shadow one
another through string coercion. Scalar normalization visits the AST before
alias resolution so cyclic aliases remain supported. Reserved-field validation
and timestamp edits still operate on the original source offsets.
This canonical model is private to no-op detection; metadata responses and the
frontmatter-patch serializer retain their existing JavaScript value model.

PR #6 regressions cover #4, #8 and #9: adjacent unsafe integers, large
integer/float no-ops in both directions, real float changes, numeric-key
collisions and aliases, distinct numeric/string keys, BOM/CRLF/comments,
original timestamp/revision/mtime preservation, and single atomic writes.

Timestamp surgery uses YAML node offsets rather than serializing unrelated fields;
block/flow mappings, quoted keys, BOM, CRLF and comments survive. Malformed/unclosed
frontmatter and unsupported managed-field representations (anchors, tags, aliases,
collections, block scalars) fail closed. Existing frontmatter-patch serialization
may still normalize unrelated spacing as documented in baseline B02. Comments-only
edits should be made outside MCP. The clock is trusted server time, not a
monotonic counter; identical clock values across two real edits are possible.

`AUTO_AGENT_EDIT_AT=false` freezes the existing managed value, restoring it on
replacement if omitted or changed; no stamp is added to unstamped notes. The
reserved field remains protected. The feature flag does not undo already
persisted timestamps. It also does not disable revision/no-op/final-size safety.
Older programmatic config objects that omit the option default to enabled.

## Local REST adapter inspected separately

`src/backend/localRest.ts` forwards create/replace/direct writes, append, heading
and frontmatter patch to `src/obsidian/client.ts` HTTP methods. It has no common
locked transaction, drops revision/mode options on note mutations and cannot
ensure a stamp and content are persisted together. Its file move is a separate
read/write/delete sequence. OBS-003 adds no timestamp support or workaround here;
the flag has no effect. The boundary test proves an enabled flag still forwards
original content once, without an extra read/frontmatter patch. K06's existing
mocked safety characterizations remain unchanged. No live REST test was run.

## Regression baseline and scope

Historical suites explicitly set `autoAgentEditAt: false` through `makeConfig`;
their byte/revision/security assertions are retained. Config tests separately prove
the production default true; OBS-003 uses the enabled path in disposable vaults
with a controlled ISO clock (real lockfile clock/timers remain untouched).

The mandated final-size guard also prevents the oversized transformed writes
previously characterized by K05. Its characterization was deliberately changed to
assert rejection and exact original bytes, including with the flag disabled.
This is a direct consequence of the required final persistence check, not a
separate size-limit refactor. K03/K04/K06 are unchanged. Failure cleanup now covers
write/sync/close/rename errors so a failed timestamped write cannot leave a temp
file; tests inject write, sync and rename failures and verify successful retry.

Rollback automatic stamping with `AUTO_AGENT_EDIT_AT=false` and restart. No bulk
vault migration is performed or needed. To undo the implementation itself, revert
the OBS-003 commit after review; this also restores prior write/no-op/size behavior.
No claims about hostile external writers, differing lock cache directories,
symlink replacement races, power loss or live REST safety are added by this task.
