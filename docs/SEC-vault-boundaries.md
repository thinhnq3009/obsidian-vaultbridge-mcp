# Filesystem vault boundaries — SEC-01, SEC-02 and SEC-04

Tracks issues [#12](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/12),
[#13](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/13) and
[#15](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/15).
Delivery: [PR #21](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/21),
targeting `main`; the PR description and delivery commit contain closing keywords
for all three issues. Issue closure takes effect when the changes reach `main`.
Baseline: `main` at `5a6c006f3762a11b77f5f73c2425a93f5cdd17de`.
Verification used Linux, Node 24.20.0 and disposable synthetic vaults only.

## Reproductions before the fix

- `deletePath(alias, {recursive:true})` resolved successfully and removed the
  temporary vault for each of `""`, `.`, `./`, `.\` and `././`.
- Moving the vault into its own child failed with OS `EINVAL`, rather than an
  explicit backend denial. No successful root move is claimed.
- Direct read of `Comments.md` with `READ_PATHS=Public` returned `ACCESS_DENIED`,
  while searching `Body stays` returned that note and its body snippet. Both
  scan and indexed search returned `Private/Note.md` before an authorized result
  when paginating a shared marker.
- A bounded probe using the baseline search service waited for watcher `ready`,
  created `vault/Linked -> outside`, then wrote `outside/Secret.md`. Search
  returned `Linked/Secret.md` with the synthetic external marker. This confirms
  the post-start watcher escape on Linux, rather than merely inferring it from
  source. The probe and its temporary files were removed after execution.

The initial red regressions were run with:

```sh
npx vitest run test/securityBoundaries.test.ts test/regressionSafety.test.ts
```

## Resulting behavior

`VaultAccessPolicy` supplies common path normalization, canonical containment,
read/write prefix boundaries and read-only enforcement. Destructive filesystem
operations explicitly reject canonical root paths before locking or mutation;
rename reaches the same guard through `movePath`.

Search traverses only read scopes and their ancestors. It checks authorization
before opening note bodies, excludes all symlink/junction aliases, uses
`O_NOFOLLOW` for the final file on POSIX, and checks descriptor identity, size and
canonical paths around reading. Watcher symlink following is disabled and
normal watcher add/change/rename/unlink behavior remains covered. Shutdown drains
in-flight watcher operations and cache writes.

Old cached note bodies are never loaded: startup removes the previous cache
and rebuilds from authorized files. Scan mode also removes a previous persisted
index. Search prunes entries that have become inaccessible or resolve through
links before pagination; persistence rechecks authorization before serializing.
This removes stale unrestricted content when a process restarts with narrower
`READ_PATHS`. No change to query ranking or regex syntax is intended.

## Verification and limits

- `npm run build`: passed.
- `npm run lint`: passed.
- `npm test`: 15 suites, 274 tests passed with V8 coverage.
- `npm pack --dry-run` and `git diff --check`: passed.
- Additional `npx tsc --noEmit -p tsconfig.json` reports three existing test-only
  errors (`test/filesystem.test.ts:31`, `test/http.test.ts:29` and `:77`). The same
  errors were reproduced from an unmodified archive of baseline `main` using the
  identical installed dependencies. The configured production build passes.

Regression coverage includes root aliases and MCP delete/move/rename calls,
scan/indexed search, prefix boundaries, individual-file scopes, filtering before
pagination, scope changes and cache purging, post-start external file/directory
links, in-vault links into private scopes, ordinary watcher events, and a
controlled parent-directory replacement between authorization and file open.

These are filesystem policy checks, not an OS sandbox against an adversarial
local process performing arbitrary concurrent filesystem swaps. Cache files
still contain plaintext; permission/retention hardening remains issue #19.
The Local REST adapter is outside this change (issue #17).

The CI matrix remains Ubuntu/macOS/Windows on Node 20/22. Local results cover
Linux/Node 24; other platforms require CI. Windows file-symlink coverage is
explicitly skipped if the OS denies symlink creation (`EPERM`); junction tests
still run.
