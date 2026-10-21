# obsidian-local-rest-mcp

Standalone MCP server for safely reading, writing, searching, and managing an Obsidian vault directly through the filesystem. Obsidian and the Local REST API plugin do not need to be installed or running.

Version 1.0 is standalone-first. The former Local REST integration remains available as a deprecated migration backend for this major version.

## Requirements

- Node.js 20.11 or newer
- A local directory to use as the vault

## Quick start

```bash
npx obsidian-local-rest-mcp
```

The server auto-detects a single open Obsidian vault from Obsidian's local registry. If detection is ambiguous, pass the vault explicitly:

```bash
npx obsidian-local-rest-mcp --vault "C:/Users/me/Documents/My Vault"
```

Environment equivalent override:

```bash
VAULT_PATH=C:/Users/me/Documents/My Vault
npx obsidian-local-rest-mcp
```

The default transport is STDIO. Obsidian, API keys, certificates, and REST endpoints are not required.

## Safety model

- All tool paths are vault-relative; absolute, UNC, drive-qualified, traversal, and symlink-escape paths are rejected.
- `READ_ONLY=true` disables every mutation.
- `READ_PATHS` and `WRITE_PATHS` restrict operations to comma-separated vault-relative prefixes.
- In filesystem mode, deleting, moving or renaming the vault root is denied, including `.` and symlink/junction aliases of the root.
- Filesystem search applies the same `READ_PATHS` policy before reading notes, indexing, returning results and saving its cache. Search excludes symlinks and junctions, including aliases within the vault.
- Writes use a same-directory temporary file, flush, and atomic rename.
- Cross-process locks serialize mutations for the same path.
- Reads return an opaque `sha256:...` revision. Updating an existing note or Canvas requires `expected_revision`; stale revisions return `CONFLICT` instead of overwriting newer data.
- Search indexes, locks, and temporary application state are stored outside the vault.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULT_PATH` | auto-detected | Absolute path to the vault; overrides registry detection |
| `BACKEND` | `filesystem` | `filesystem` or deprecated `local-rest` |
| `READ_ONLY` | `false` | Disable all mutations |
| `READ_PATHS` | all | Comma-separated readable prefixes |
| `WRITE_PATHS` | all | Comma-separated writable prefixes |
| `INDEX_MODE` | `auto` | `auto`, `scan`, or `indexed` |
| `WATCH_MODE` | `auto` | `auto`, `on`, or `off` |
| `CACHE_DIR` | OS cache directory | Search index and lock location |
| `MAX_FILE_SIZE_BYTES` | `10485760` | Maximum file size read or written |
| `MAX_TREE_ENTRIES` | `10000` | Traversal safety limit |
| `MAX_SEARCH_RESULTS` | `100` | Server-side search limit |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `COLORFUL_LOGS` | `false` | Enable ANSI-colored server logs |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind host |
| `MCP_HTTP_PORT` | `39145` | HTTP bind port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint |
| `MCP_ALLOWED_HOSTS` | unset | Optional HTTP Host allowlist |
| `MCP_AUTH_TOKEN` | unset | Required when binding outside loopback |

CLI arguments override `.env` and environment values:

```text
--vault --backend --read-only --read-path --write-path
--index-mode --watch-mode --cache-dir
--http --stdio --transport --host --port --path --auth-token --colorful
```

`--read-path` and `--write-path` may be repeated.

## MCP client examples

### Codex

```toml
[mcp_servers.obsidian_vault]
enabled = true
command = "npx"
args = ["-y", "obsidian-local-rest-mcp", "--vault", "C:/Users/me/Documents/My Vault"]
```

When Obsidian has exactly one open vault recorded locally, the `--vault` argument can be omitted.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": ["-y", "obsidian-local-rest-mcp", "--vault", "C:/Users/me/Documents/My Vault"]
    }
  }
}
```

When Obsidian has exactly one open vault recorded locally, the `--vault` argument can be omitted.

## Tools

Core tools retain their existing names:

- Notes: `obsidian_read_note`, `obsidian_read_note_section`, `obsidian_apply_note_edits`, `obsidian_write_note`, `obsidian_append_to_note`, `obsidian_patch_heading`, `obsidian_read_note_metadata`, `obsidian_patch_frontmatter`
- Filesystem: `obsidian_list_files`, `obsidian_create_folder`, `obsidian_tree`, `obsidian_stat_path`, `obsidian_move_path`, `obsidian_rename_path`, `obsidian_delete_path`
- Search: `obsidian_search`, `obsidian_search_content_advanced`, `obsidian_rebuild_search_index`
- Canvas: read/create/update/delete plus semantic node and edge tools
- Diagnostics: `obsidian_backend_status`, `obsidian_vault_health`

`obsidian_get_active_file` and `obsidian_open_file` are exposed only by a backend with an active Obsidian runtime integration. They are intentionally absent in standalone mode.

### Safe update example

First read the note:

```json
{ "path": "Projects/Plan.md" }
```

Then replace using the returned revision:

```json
{
  "path": "Projects/Plan.md",
  "content": "# Updated plan\n",
  "mode": "replace",
  "expected_revision": "sha256:..."
}
```

New paths use `mode: "create"` and do not need a revision.

### Atomic multi-edit of one note (OBS-005)

`obsidian_apply_note_edits` applies several frontmatter updates and heading-section
edits to **one existing Markdown file** in a single filesystem transaction.
Provide the revision returned by the most recent read:

```json
{
  "path": "Projects/Plan.md",
  "expected_revision": "sha256:...",
  "frontmatter_updates": [
    { "field": "status", "value": "review", "operation": "replace" },
    { "field": "tags", "value": "ready", "operation": "append" }
  ],
  "section_edits": [
    { "heading": "Progress", "content": "Completed.", "operation": "replace" },
    { "heading": "Review", "occurrence": 2, "content": "Check CI.", "operation": "append" }
  ]
}
```

Arrays are applied in order (frontmatter first, then sections); entries have
the same semantics as `obsidian_patch_frontmatter` and `obsidian_patch_heading`.
`operation` defaults to `replace`; frontmatter `create_if_missing` defaults
to true. At least one edit is required, with at most 50 entries per array.
The response includes `path`, `revision`, `frontmatter_edits`, `section_edits`,
and `changed`. No-op edits preserve existing bytes, timestamp and revision.

All changes are composed in memory under one per-path lock after the revision
check and committed with at most one atomic rename. Any stale revision, invalid
YAML, missing/ambiguous heading, protected `agents_edit_at` field, size limit
or permission failure aborts the entire note update. The server-owned timestamp
is applied once by the existing final write pipeline. This is **not** a
multi-file transaction. The deprecated Local REST adapter rejects this tool
with `UNSUPPORTED_CAPABILITY` rather than risking partial writes.

### Read a note section

`obsidian_read_note_section` accepts `{ path, heading, occurrence?, max_chars? }`:

```json
{ "path": "Projects/Plan.md", "heading": "Milestones", "max_chars": 4000 }
```

It returns `{ path, heading, level, content, truncated, start_line, end_line, revision }`.
Heading matching uses case-sensitive AST plain text with surrounding whitespace
trimmed, as in metadata/heading patches. Both ATX (`## Heading`) and setext
headings are supported. Duplicate text requires a 1-based `occurrence`, otherwise
the tool returns `AMBIGUOUS_HEADING`. Missing headings and occurrences beyond the
matching count return `HEADING_NOT_FOUND`; non-integer or non-positive occurrences
fail input validation. Code-fence and indented-code pseudo-headings are ignored.

`content` is the exact original **body**, excluding the selected heading (including
both lines of a setext heading) and its terminating newline. It includes nested
headings and ends before the entire line of the next heading of equal or lower
level, or at EOF. Leading/trailing whitespace, blank lines, Unicode and newline
style are preserved without normalization. A file-leading BOM is excluded from
parsing and is outside the returned body; a BOM within the body is preserved.
An empty section returns `content: ""` and `truncated: false`.

Line bounds are 1-based source lines for the **full, untruncated body**, expressed
as `[start_line, end_line)` (end-exclusive). `start_line` is the line following the
heading; `end_line` is the line after the last body line, counting a final line
without a newline. For an empty body both equal the line after the heading, even
when that line is beyond EOF. For `# A\nbody\n# B\n`, reading `A` returns
`content: "body\n"`, `start_line: 2`, `end_line: 3`.

`max_chars` bounds **body content** in UTF-16 code units (JavaScript string length):
default 20,000, minimum 1, hard maximum 100,000. Values outside this integer range
fail input validation. A truncation boundary retreats by one unit if necessary to
avoid splitting a Unicode surrogate pair; consequently a limit of 1 can return
an empty string for a body starting with an emoji. `truncated` is true exactly
when body content was omitted. Line bounds and revision do not change with the
limit; `revision` is the backend's revision of the whole note, or `null` when the
backend supplies none. The tool does not fabricate a section hash.

Both filesystem and deprecated Local REST backends use their existing `readNote`
path. Filesystem reads retain read ACL, path/symlink protection and whole-file size
limits, even for a tiny section request, and work in read-only mode. Local REST
retains its existing read behavior and upstream protections; revision comes from
its ETag or Last-Modified, when available. Section reads do not write notes or
update `agents_edit_at`.

## Automatic agent edit timestamp

Filesystem Markdown mutations automatically set the reserved frontmatter field
`agents_edit_at` to the server's ISO 8601 UTC time. This includes create, replace,
append, heading/frontmatter patch, bulk writes and direct `.md` writes (extension
matching is case-insensitive). The stamp is added inside the existing file lock,
after revision/transform validation, before the single atomic write. Returned
revisions hash the final persisted UTF-8 bytes. Final size limits include the stamp.

`AUTO_AGENT_EDIT_AT=false` (or `--auto-agent-edit-at=false`, or the programmatic
`autoAgentEditAt` config) disables automatic updates. Existing timestamp values
are preserved even if a replacement omits or changes them. Clients cannot patch
`agents_edit_at` or its children; supplied scalar timestamps on enabled writes
are overwritten by server time. Disabled creates cannot supply the reserved field.

An unchanged Markdown body and YAML properties (ignoring `agents_edit_at`) is a
no-op: no write, mtime change or timestamp update. YAML formatting/comment-only
replacement is also a no-op under this comparison. Stale revisions are still
rejected before no-op detection. Timestamp insertion preserves unrelated YAML
text/comments, BOM, newline style and body; it does not reserialize the document.
The existing frontmatter-patch serializer retains its existing formatting behavior.
Malformed/unclosed YAML, non-mapping frontmatter and anchors, tags, collections or
block scalars on the reserved field are rejected without writing. Repair such
frontmatter outside MCP first. Canvas/assets and move/delete operations do not
receive timestamps. Bulk writes retain sequential partial success; they are not
cross-file transactions. See [the write-path audit](docs/OBS-003-write-audit.md).

The deprecated Local REST adapter does **not** implement this feature: its HTTP
forwarding has no shared locked transaction or reliable revision precondition.
`AUTO_AGENT_EDIT_AT` has no effect there; the server does not perform an unsafe
read/patch/write workaround or claim filesystem atomicity for this adapter.

## Markdown and search behavior

- Headings are located through a Markdown AST and only the selected section is spliced into the original file.
- Duplicate heading text requires the 1-based `occurrence` field.
- Frontmatter is parsed as a YAML document; malformed YAML fails without writing.
- BOM and the existing newline style are preserved.
- `obsidian_read_note_metadata` returns frontmatter, tags and basic stat data without the note body. It also returns headings, link targets and the actual revision when provided by the backend; these fields remain optional for compatibility.
- Filesystem metadata includes standard link URLs and Obsidian wikilink targets (without aliases or heading anchors). Inline code and code fences are excluded; numeric-only body references such as `#123` and `#6120` are not tags. Supported frontmatter tag forms are preserved.
- `INDEX_MODE=auto` selects an in-memory scan snapshot below 1,000 Markdown files and MiniSearch at or above that threshold. Mode selection happens at startup or explicit rebuild, not on each write.
- The filesystem index is regenerated from authorized files at startup; previous cached note bodies are removed rather than trusted, including when switching to scan mode or narrowing `READ_PATHS`.
- Successful filesystem mutations reconcile affected Markdown files/subtrees before returning, in both modes, including `WATCH_MODE=off`. Content, tags, frontmatter and paths reflect the commit on the following search. No-op and failed writes skip refresh. Single-note edits do not walk or rebuild the vault. Directory operations inspect cached path prefixes and walk only the affected readable subtrees.
- Mutation refresh, watcher refresh, search and explicit rebuild share an ordered queue. Late watcher events reconcile the current path state rather than replaying historical content or blindly deleting IDs. Existing revision checks, locks, atomic writes and `agents_edit_at` still apply.
- `obsidian_search` retains mode-specific behavior: scan uses case-insensitive substrings over path/content; indexed uses MiniSearch fuzzy/prefix matching and relevance scores. An old query can still match new content fuzzily; use advanced search for exact qualification.
- `obsidian_search_content_advanced` uses literal substring qualification over path/content in both modes. `case_sensitive` controls the query and content regex; folder boundaries, tags (optional leading `#`) and frontmatter values are exact filters. Tags/values retain their case and Unicode representation. Filters run before pagination. Exact results have score 1 and path ordering for ties; cursors are offsets for a stable dataset, not snapshots across mutations.
- External filesystem edits are eventually consistent through watch mode, or require `obsidian_rebuild_search_index` with watch off. Watch ingestion excludes symlinks/junctions and rechecks canonical paths and file identity around reads. These checks reduce replacement races but are not an OS sandbox against a process concurrently changing the filesystem. The strict guarantee applies to one filesystem backend instance; other processes and the deprecated Local REST backend own their search consistency.
- Indexed mutations invalidate the previous disk cache; a fresh snapshot is saved on close/rebuild (also when pruning unauthorized cached paths). Startup always regenerates it. Cache invalidation or refresh failure after commit returns `INDEX_ERROR` explicitly saying the filesystem mutation committed. Search then fails closed until a successful rebuild. Read the current path/revision before retrying an append, move or other mutation; an error does not roll back committed filesystem data. Startup index failures may still fall back to scan mode. Cached entries that become inaccessible or resolve through a link are removed before search pagination and cache writes.

## HTTP mode

```bash
npx obsidian-local-rest-mcp --vault "C:/Vault" --http
```

Binding to a non-loopback host requires authentication:

```bash
npx obsidian-local-rest-mcp --vault "C:/Vault" --http --host 0.0.0.0 --auth-token "replace-with-a-secret"
```

Clients must send `Authorization: Bearer <token>`.

## Local REST migration backend

```bash
npx obsidian-local-rest-mcp \
  --backend local-rest \
  --api-key "your-key" \
  --base-url "https://127.0.0.1:27124"
```

This backend exists for migration only and is planned for removal after the 1.x line. See [MIGRATION.md](./MIGRATION.md).

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm pack --dry-run
```
