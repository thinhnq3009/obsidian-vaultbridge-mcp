# Obsidian VaultBridge MCP

Standalone MCP server for reading, writing, searching, and managing an Obsidian vault directly through the filesystem. Obsidian and the Local REST API plugin do not need to be installed or running.

> **v0.1.0:** local filesystem MCP integration for Codex, Cursor and Claude Desktop. Requires patched Node 22 or 24 (see below). OAuth, embedded SQLite and a login UI are planned for v0.2.0. Review the [cache permissions](#search-cache-privacy) and [HTTP deployment requirements](#http-deployment-requirements) before connecting a vault.

[![CI](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/workflows/ci.yml)

The filesystem backend is standalone-first. The former Local REST integration remains a deprecated migration adapter. The npm package is now `obsidian-vaultbridge-mcp`; see [migration and executable compatibility](./MIGRATION.md).

## Requirements

- Patched Node.js 22.23.4+ within 22.x, or 24.22.1+ within 24.x (other major lines are unsupported)
- A local directory to use as the vault

## Quick start

```bash
npx obsidian-vaultbridge-mcp@0.1.0
```

The server auto-detects a single open Obsidian vault from Obsidian's local registry. If detection is ambiguous, pass the vault explicitly:

```bash
npx obsidian-vaultbridge-mcp@0.1.0 --vault "C:/Users/me/Documents/My Vault"
```

Environment equivalent override:

```bash
VAULT_PATH=C:/Users/me/Documents/My Vault
npx obsidian-vaultbridge-mcp@0.1.0
```

Release availability and provenance are recorded on [npm](https://www.npmjs.com/package/obsidian-vaultbridge-mcp) and [GitHub Releases](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/releases). Use the explicit version above for reproducible client configuration.

The default transport is STDIO. Obsidian, API keys, certificates, and REST endpoints are not required.

## Filesystem safety model

Filesystem mode provides canonical path checks and revision preconditions. The deprecated Local REST adapter now enforces read-only and lexical path scopes, and fails closed for unsupported search, active-file reads and atomic/revision guarantees; see [migration notes](./MIGRATION.md).

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
| `MCP_ALLOWED_HOSTS` | loopback names | Required Host allowlist for network HTTP |
| `MCP_HTTP_TLS_PROXY` | `false` | Acknowledge operator-managed TLS proxy for network HTTP |
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
args = ["-y", "obsidian-vaultbridge-mcp@0.1.0", "--vault", "C:/Users/me/Documents/My Vault"]
```

When Obsidian has exactly one open vault recorded locally, the `--vault` argument can be omitted.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": ["-y", "obsidian-vaultbridge-mcp@0.1.0", "--vault", "C:/Users/me/Documents/My Vault"]
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

`obsidian_get_active_file` and `obsidian_open_file` are listed for compatibility but return errors in filesystem mode. They work only with an active Obsidian Local REST runtime. Their presence in the tool list does not imply standalone support.

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
cross-file transactions. See [the write-path audit](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/blob/develop/docs/OBS-003-write-audit.md).

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
- Mutation refresh, watcher refresh, search and explicit rebuild share an ordered queue. Up to 50 queries waiting together share one full authorization pass over the snapshot, followed by serialized result projections. Regex queries recheck authorization after the worker finishes, including timeout and failure paths. A batch closes before authorization begins and at every mutation/rebuild boundary; there is no authorization TTL or reuse for later arrivals. Late watcher events reconcile the current path state rather than replaying historical content or blindly deleting IDs. Existing revision checks, locks, atomic writes and `agents_edit_at` still apply.
- `obsidian_search` retains mode-specific behavior: scan uses case-insensitive substrings over path/content; indexed uses MiniSearch fuzzy/prefix matching and relevance scores. An old query can still match new content fuzzily; use advanced search for exact qualification.
- `obsidian_search_content_advanced` uses literal substring qualification over path/content in both modes. `case_sensitive` controls the query and content regex; folder boundaries, tags (optional leading `#`) and frontmatter values are exact filters. Tags/values retain their case and Unicode representation. Filters run before pagination. Exact results have score 1 and path ordering for ties; cursors are offsets for a stable dataset, not snapshots across mutations.
- Filesystem regex search runs compilation and matching in a disposable worker with a 1,000 ms deadline (including worker startup), a 64 MiB old-generation heap limit, and at most 10,000 candidate notes / 16 MiB of UTF-8 content per query. Folder, tag, frontmatter and literal-query filters narrow candidates before these input limits. Invalid syntax, unsupported patterns, exceeded limits and worker failures return `INVALID_QUERY` without partial results. Timeouts stop the worker before releasing the search queue; other searches and Markdown mutations wait behind that queue while unrelated server operations remain responsive. Successful patterns retain JavaScript Unicode (`u`/`iu`) matching, including lookahead; the existing 256-character limit and heuristic syntax restrictions remain. The syntax filter alone is not a ReDoS guarantee. These limits apply to the filesystem backend, not the deprecated Local REST adapter.
- External filesystem edits are eventually consistent through watch mode, or require `obsidian_rebuild_search_index` with watch off. Watch ingestion excludes symlinks/junctions and rechecks canonical paths and file identity around reads. These checks reduce replacement races but are not an OS sandbox against a process concurrently changing the filesystem. The strict guarantee applies to one filesystem backend instance; other processes and the deprecated Local REST backend own their search consistency.
- Ordinary non-Markdown writes and file watcher events skip search synchronization/cache invalidation. Moves involving either a Markdown source or destination, and directory moves/deletes, still reconcile. Cyclic or otherwise non-indexable symlink paths are excluded safely; ELOOP path errors do not disable healthy search, while unexpected storage/index failures still fail closed.
- Indexed Markdown mutations invalidate the previous disk cache; a fresh snapshot is saved on close/rebuild (also when pruning unauthorized cached paths). Startup always regenerates it. Cache invalidation or refresh failure after commit returns `INDEX_ERROR` explicitly saying the filesystem mutation committed. Search then fails closed until a successful rebuild. Read the current path/revision before retrying an append, move or other mutation; an error does not roll back committed filesystem data. Startup index failures may still fall back to scan mode. Cached entries that become inaccessible or resolve through a link are removed before search pagination and cache writes.

## HTTP mode

```bash
npx obsidian-vaultbridge-mcp@0.1.0 --vault "C:/Vault" --http
```

Binding to a non-loopback host requires authentication, an explicit Host allowlist and a trusted TLS proxy:

```bash
MCP_HTTP_TLS_PROXY=true MCP_ALLOWED_HOSTS=mcp.example.com \
  npx obsidian-vaultbridge-mcp@0.1.0 --vault "C:/Vault" --http --host 0.0.0.0 --auth-token "replace-with-a-secret"
```

Clients must send `Authorization: Bearer <token>`.

## Local REST migration backend

```bash
npx obsidian-vaultbridge-mcp@0.1.0 \
  --backend local-rest \
  --api-key "your-key" \
  --base-url "https://127.0.0.1:27124"
```

This backend exists for migration only; its removal schedule has not been agreed. It is unsuitable for enforcing access restrictions. See [MIGRATION.md](./MIGRATION.md).

## Contributing

Please follow the [Conventional Commit, pull request and issue-linking guidelines](./CONTRIBUTING.md). Use the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) to distinguish partial work (`Refs`) from an issue-completing PR (`Closes`). Release issues stay open until all publication and verification acceptance criteria are met.

## Tests and development

The [test suite](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/tree/develop/test) uses Vitest with V8 coverage. It exercises filesystem/revision safety, Markdown/YAML, search scopes and freshness, Canvas, MCP STDIO/HTTP, and known compatibility-adapter limitations. Tests use temporary synthetic vaults. Passing characterization tests for a known limitation do not mean that limitation is fixed.

[CI](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/workflows/ci.yml) runs on Ubuntu, macOS and Windows with Node 22.23.4/24.22.1. It builds, tests, lints, audits production dependencies, checks the pack manifest and installs an actual tarball into a separate consumer for an `npx` MCP smoke test of both executable names. Tests stay in GitHub and are not shipped in the npm tarball.

```bash
npm ci
npm run build
npm test
npm run lint
npm pack --dry-run
npm run smoke:package
npm audit --omit=dev --audit-level=high
```

See [RELEASING.md](./RELEASING.md) for source/artifact evidence, remaining gates and manual prerelease steps. npm.io is a third-party index; its test indicator and score are not a substitute for the linked test/CI evidence.

### Protected vault paths

Every backend denies path segments `.obsidian`, `.git`, `.env` and `.env.*`,
plus internal `.obsidian-vault-mcp-*` temporary paths. Matching is case-insensitive
on all platforms and covers Windows trailing-dot/space and alternate-stream
aliases. Listings hide denied entries; filesystem authorization also checks
canonical symlink targets. Recursive deletion/moves reject an entire directory
if it contains a denied descendant. Use Obsidian or an administrator tool for
control-file maintenance; there is no MCP override.

### Search cache privacy

`CACHE_DIR/<vault-hash>/search-index.json` contains plaintext note bodies. Startup
rebuilds it from the current read scope and discards the previous snapshot.
POSIX cache roots/vault directories are repaired to `0700`; new index files use
`0600` with exclusive temporary-file creation and cleanup on failure. Cache
symlinks and foreign-owned directories are rejected. Use a dedicated cache
location owned by the service account on a local filesystem. Windows relies on
an owner-only inherited NTFS ACL: set it on `CACHE_DIR` before starting (POSIX
mode bits do not secure NTFS). Avoid shared/network filesystems with permissive
ACLs. Stop the process and delete `CACHE_DIR` to remove retained snapshots;
normal shutdown retains the authorized index for inspection.

### HTTP deployment requirements

Loopback HTTP is intended for trusted local clients. For network binding use a
TLS-terminating reverse proxy, firewall the backend so only that proxy can reach
it, set `MCP_HTTP_TLS_PROXY=true`, configure `MCP_ALLOWED_HOSTS` (hostnames without
ports, bracket IPv6), and require `MCP_AUTH_TOKEN`. The proxy must preserve Host,
Authorization and Origin. This flag acknowledges operator-managed TLS; the
backend still speaks plaintext HTTP. Forwarded headers are never trusted.
Native clients may omit Origin; browser requests must have an exact same-origin
value using HTTP locally and HTTPS behind the proxy. Host, Origin and token
checks run before the body parser. All compressed bodies (br, gzip, deflate)
are rejected with 415; send uncompressed JSON. JSON bodies are limited to 100 KiB.
The server limits headers to 16 KiB, requests to 120/minute across the instance,
active responses to 32, connections to 128 and requests/socket to 100. Header,
body and keep-alive timeouts are 10/30/5 seconds; SSE response streams have no
fixed duration. Use separate instances for clients needing larger shared budgets.

## Request-scoped authorization foundation (AUTH-004 Phase A, unreleased)

The internal Phase A authorization seam supports immutable test-trusted contexts,
explicit principal/client/vault grants, backend-operation guards and isolated
search projections/cursors. **It does not enable production OAuth**, change the
HTTP authentication modes, or make an owner login cookie an MCP credential.
See [Phase A contracts, security limits and rollback](docs/AUTH-004-phase-a.md).
Verified OAuth request binding and grant/consent UI await AUTH-003/Phase B;
upstream Better Auth family-revocation issue #60 remains unresolved.

## Local owner login (AUTH-002, unreleased)

Owner identity is an **opt-in, separate loopback service**, not yet an MCP OAuth
provider. It does not change `/mcp`, static Bearer authentication, vault permissions,
or STDIO. Do not expose this UI through a proxy or treat its cookie as an MCP token.
The HTTP mode resolver, OAuth default/explicit anonymous-mode warnings, consent,
PKCE, and token-to-tool integration remain AUTH-003 and later work.

```bash
# From source, using a disposable vault for development:
npm run build
node dist/index.js owner-auth --vault /absolute/path/to/test-vault
# Installed CLI (after an approved future release):
obsidian-vaultbridge-mcp owner-auth --vault /absolute/path/to/vault
```

Open the exact `http://127.0.0.1:39146/login` address printed on stderr. The first
owner is created automatically in the private SQLite auth directory when `owner-auth`
or explicit OAuth starts. Set `MCP_OWNER_USERNAME` and `MCP_OWNER_PASSWORD` in an
untracked `.env` before first start. Username is a 3–64 character lowercase
identifier beginning with a letter and containing only letters, digits, `.`, `_`
or `-`; dots must separate nonempty parts (no trailing or consecutive dots).
The resulting owner address must also pass email validation; the username itself
is not an email. Existing email-based owners continue to sign in using
their email. A custom password
must be 12–128 characters and contain at least three of lowercase, uppercase, digits,
and symbols. If omitted, the defaults are **`obsidian-admin` / `admin39145`**.
This publicly known password is unsafe: the owner must change it in the local
`/admin` UI before OAuth grants, consent, tokens, or MCP vault access can work.
The default password is a one-time bootstrap exception, not a valid new password.
Changes to the ENV after creation never reset the existing owner or credentials.
No first-run registration or public signup/reset endpoint exists. The owner-only
change-password form requires the current password, a live session, exact loopback
Host/Origin and a CSRF header. Success revokes all owner sessions and local grants,
requires fresh login and explicit regranting; it **does not** fix upstream refresh
family revocation (#60). A forgotten password requires offline `--recover-owner`
with a protected ten-minute recovery token; the owner login identifier is unchanged.

Normal STDIO/token/none MCP startup does not create an account/database. In particular anonymous
local usage does not require setup. `MCP_AUTH_MODE=none` rejects the explicit
`owner-auth` command before opening storage; omit that command for anonymous use.
No new network-anonymous or OAuth mode is enabled by this change.

Configuration precedence for the owner command: **CLI > ENV > working-directory
`.env` > defaults** (restart to apply):

| Setting | CLI | Default / bounds |
| --- | --- | --- |
| `MCP_OWNER_PORT` | `--owner-port` | 39146; 1–65535, always 127.0.0.1 |
| `MCP_OWNER_USERNAME` | — | `obsidian-admin`, first owner creation only |
| `MCP_OWNER_PASSWORD` | — | `admin39145` (unsafe; mandatory rotation), first owner creation only |
| `MCP_AUTH_LOGIN_MAX_FAILURES` | `--auth-login-max-failures` | 5; 1–20 |
| `MCP_AUTH_LOGIN_WINDOW_SECONDS` | `--auth-login-window-seconds` | 900; 1–86400 |

Login failure limits are separate from MCP throughput: normalized email + actual
TCP peer, peer-wide budget four times the configured failures, and progressive
1–60 second backoff. Reservations count in-flight attempts, persist over restart,
and expire at the fixed window boundary. Successful login clears its pair budget
and removes its peer reservation; other failed attempts remain. No account-wide
lockout allows a remote attacker to target the owner's email. The Better Auth
persistent limiter is explicitly enabled even in development/test, including its
sensitive sign-in rule (3 attempts/10 seconds), so a raised custom limit does not
remove that additional protection. The owner listener also has a separate cheap
120-request/minute ceiling, 8 KiB JSON limit and 16-connection ceiling. It never
uses MCP's tool budget or trusts forwarding/client-IP headers.

Storage and backup/recovery/rollback instructions: [MIGRATION.md](MIGRATION.md#owner-auth-storage-auth-002).
# Experimental OAuth development

AUTH-003 now has an explicit-opt-in Better Auth runtime. It remains
**default-off pending #60 risk review**; this is not public deployment/release
approval. See [runtime configuration, verified identity contract, limits and
rollback](docs/AUTH-003-runtime.md). Existing STDIO/static-token/legacy loopback
modes remain available. No automatic OAuth migration is performed.
See [AUTH-004 Phase B](docs/AUTH-004-phase-b.md) for owner-only consent/grants,
request-scoped enforcement and live OAuth-to-MCP test boundaries.
