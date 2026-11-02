# AUTH-004 Phase A — request-scoped vault authorization

Issue #48, branch `feat/issue-48-request-vault-authz`, target `develop`.
This is an **OAuth-independent foundation**, not a production OAuth release.
AUTH-003 still needs a verified identity contract. PR #59's diagnostic merge
does not supply that contract. Better Auth issue #60 remains explicitly deferred;
no provider refresh/family-revocation probe has been fixed or suppressed here.

## Trust boundary and modes

`createRequestBackend` takes a shared backend and a trusted server-selected mode.
`token`, `none` and `stdio` return the original global-policy backend, without an
invented OAuth principal. This does not implement a new HTTP mode resolver,
anonymous-network opt-out, or any AUTH-SEC-001 traffic-budget changes.
`src/http.ts`, configuration and owner login/consent routes are unchanged.

OAuth context is an immutable object containing `mode`, `principalId`, `clientId`,
`grantId`, `vaultId`, `resource`, `scopes` and `requestId`. Scopes are copied and
frozen. Structural/decoded/header objects do **not** pass the in-process trust
registry, even if their fields are valid. The only issuer in Phase A is
`createTestAuthContext`; it rejects outside `NODE_ENV=test`. This is a test
harness, **not token verification**. No public route or configuration setting
calls it. Never run a production deployment with this test helper as an identity
source. Missing context, identity, resource, vault, scope or grant fails closed.

Phase B must introduce the real trusted issuer only after provider verification
of token activity, issuer, resource/audience, expiry and scopes. It must derive
the actual configured vault ID/resource mapping on the server, never from a
caller-selected vault/header or an owner browser cookie. It must pass the
request-scoped facade (not the original backend) to `createMcpServer`.

## Versioned local grants

`SqliteGrantStore` owns **only** `vaultbridge_authz_migration` (version 1) and
`vaultbridge_vault_grant`. It neither migrates nor queries Better Auth tables or
the independent owner migration version. Production storage must be opened via
`openAuthStorage` so it retains outside-vault, owner-only, lock and WAL controls.
Normal MCP/owner startup does not create these tables in Phase A. The store is an
internal owner-side API, not an MCP tool or an admin/consent HTTP endpoint.

A grant explicitly binds one principal, client, vault and resource and includes:

- `version: 1` and a unique `grantId`;
- `principalPermissions: [{ path, actions }]`;
- `clientPermissions: [{ path, actions, tools }]`;
- `consentScopes` intersected with request token scopes;
- storage-managed monotonically increasing `revision` and `revoked` state.

Paths are explicit vault-relative non-root paths/subtrees, not globs. Empty/root,
wildcard, traversal, backslash/drive/ADS and protected metadata grants are rejected.
`Notes` means `Notes` and descendants, never `NotesExtra`. An individual file
can be granted instead. Actions are exact `VaultBackend` path-method names; tools
are exact registered `obsidian_*` names, not wildcard patterns. Empty
permissions/consent and unknown schema versions are denied. No owner or client
gets automatic all-vault access.

Effective access is:

```text
global lexical/canonical/read-only VaultAccessPolicy
  ∩ bound principal action/path permission
  ∩ current client consent AND verified-context scope
  ∩ exact tool/action/path client permission
```

Read operations require `vault:read`; mutations require `vault:write`.
Compound tools need each backend action they perform under that exact tool name:
for example Canvas edit needs `readNote` + `writeFile`; tree needs `statPath` +
`listFiles`; Canvas create without overwrite needs `statPath` + `writeFile`.
Therefore compound read/write tools also need both scopes. A list/tree root must
be explicitly within a grant (`Notes`, not the implicit vault root).
Authorization grants access to the complete allowed note; it is not redaction of
links, filenames or text already written inside that note.

`put` validates the entire schema and bumps the revision, including re-consent;
`revoke` disables the grant and bumps the revision. Decisions read current SQLite
state, including when reusing an already-created facade. Re-consent is a trusted
owner operation; a client cannot re-enable its own revoked grant.

## Operation enforcement and tool coverage

The request facade stores one immutable principal binding. A private
`AsyncLocalStorage` binds the process-owned registered tool name for each tool
callback, including concurrent calls; no shared backend/config/policy is mutated.
Tool admission also denies revoked grants for pure no-ops, such as same-name
rename. Every backend method is explicit (and the negative-test table is checked
against `keyof VaultBackend`).
Scoped same-name file rename still requires move rights on that path and a
current revision; folder no-op overwrite is conservatively denied. The legacy
same-name shortcut remains unchanged.

Each content operation gets a short-lived filesystem view sharing only the
server's infrastructure/search service, with a fresh `RequestAccessPolicy`.
Checks apply before IO, after awaited reads, under mutation locks and immediately
before atomic rename/delete/move. Both move endpoints and protected descendants
of recursive mutations are checked. Scoped OAuth rejects all symlink/junction
components, even in-vault aliases. Original traversal, protected paths, read-only,
revision conflict, file-size, atomic staging and synchronization protections stay
in force.

Bulk writes preflight **all** destinations before their first write and still
authorize every individual commit. They are not a multi-file transaction:
revision/IO failures or revocation during the sequence can leave earlier
authorized files committed. Read current revisions before retrying.

Scoped OAuth deliberately denies shared `initialize`, `close`, `status`,
`health`, `rebuildSearchIndex`, active-file and open-file access. Do not close the
request facade as application teardown; the owning application closes the shared
backend. Local REST is rejected at facade construction, before network calls,
because canonical-path guarantees cannot be proven. Legacy Local REST behavior
is unchanged.

Failures from scoped backend operations have path/content/credential-free
messages and no raw revision/error details. Scoped tool logs omit caller
headers/session identifiers and error bodies; optional audit events contain only
the fixed action and boolean outcome. Legacy logging is unchanged.

## Search and cursor isolation

The shared index remains **server-private**, under the server's global policy;
it is not exposed to a request or pruned according to one client's permissions.
Scoped searches construct an ephemeral authorized projection **before** scoring,
regex workers, counts, pagination or snippets. Indexed ranking uses only that
projection, not global term statistics. No per-client bodies or projections are
persisted. Final checks reject revoked/changed grants and recheck path eligibility
after asynchronous evaluation. This preserves concurrent clients without
contaminating each other's results or deleting each other's cache entries.

Scoped cursor payloads contain only offset and a hashed binding. An HMAC with a
process-local random key authenticates that binding to principal/client,
vault/resource, current grant document/revision, context scopes, exact tool/action
and query (including page size). `requestId` is intentionally excluded to allow
the next HTTP request of the same consent to paginate. Cross-client/tool/query,
modified, legacy, revoked and re-consented cursors are rejected. Restart changes
the key and invalidates prior scoped cursors. Cursors are offsets, not immutable
content snapshots: normal content changes may shift pages. Global legacy cursor
behavior is unchanged.

Scoped filesystem views fail closed if the canonical cache root and vault
overlap in either direction. Otherwise a global plaintext index configured under
an allowed subtree could be read as an ordinary file and disclose denied notes.
Use a separate outside-vault cache directory, including when parent directories
are aliases. This restriction applies to the scoped seam; legacy cache
configuration is unchanged. A red/green regression reproduces the unsafe
`Notes/Cache/.../search-index.json` read before the guard and denies it afterward.

## Verification, limitations and rollback

`test/requestAuthorization.test.ts` uses disposable vaults, fake **trusted**
contexts and independent SQLite storage. It covers every backend entry point,
all registered MCP tools on revoked grants, client A read-only `Notes` vs client B
`Secret`, parallel operations/search, scopes/tool/action/path intersection,
revocation during read/commit/search, both move endpoints, bulk preflight,
Canvas revisions, traversal/aliases/protected descendants, read-only policy,
cursor replay/tampering and persistence/re-consent/schema failures.

Run from supported Node 22.23.4 or 24.22.1:

```sh
npm ci
npm run lint
npm run build
npm test -- --maxWorkers=2
npm run smoke:package
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
git diff --check
```

Exact results and commit/PR identifiers are recorded in issue #48 and the
Obsidian task note. CI's current job conditions only run the full OS matrix for
`main` / `develop`→`main`, **not this feature→develop PR**; local Linux checks are
not evidence of macOS/Windows verification. Do not broaden unrelated workflow
conditions or claim skipped checks passed.

An additional `npx tsc --noEmit -p tsconfig.json` check reports nine existing
test-only diagnostics in `applyNoteEdits`, `benchmarks/searchConcurrency`,
`filesystem`, `readNoteSection` and `searchConsistency` tests. The diagnostics
were reproduced byte-for-byte from a clean `origin/develop@3354dbc` archive with
the same installed dependencies; Phase A adds no new diagnostic. This extra
whole-project check is **not green**; the configured production build is green.

Remaining Phase B work: verified provider→request lifetime binding, live token
and session invalidation, owner-managed grant/consent UI, HTTP E2E and release
approval. Upstream #60 family-wide revocation remains unsolved. Search projection
work is proportional to index size; this is not a throughput benchmark.
Filesystem rechecks are defense in depth, not an OS sandbox against a malicious
local process continuously swapping paths/hardlinks; existing OS/TOCTOU and
release/security issues remain separate gates.

Rollback: stop processes before restoring an application-data backup; keep
`auth.sqlite`, WAL state and its matching `session.key` together as described in
the owner-auth guide. Revert the Phase A feature commit to remove the unused seam;
legacy MCP runtime is unchanged. Authorization tables have a separate migration
namespace and can remain unused in an older binary. Never drop Better Auth/owner
tables or roll back a live database with mismatched keys. No merge, auto-merge,
release, publish or alteration of release PR #58 is part of Phase A.
