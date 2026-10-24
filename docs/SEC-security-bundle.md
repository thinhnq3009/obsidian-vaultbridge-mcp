# Security remediation bundle

Tracks [#14](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/14),
[#17](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/17),
[#18](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/18),
[#19](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/19),
[#20](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/20) and
[#23](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/23).
Baseline after synchronization: `1c1253af7b461de08932bced4d1bb71fb4129e0d`.
PR #24 / issue #16 and release PR #25 were merged during implementation; their
latest regex authorization and platform fixes are preserved in the bundle.

## Reproductions and corrections

- Protected paths: new fixture tests initially returned `.obsidian`, `.git`,
  `.env` and aliased control content. Shared lexical/canonical policy now denies
  them; listings, watcher/index persistence and recursive moves/deletes agree.
- Local REST: 16 fixture tests initially failed: read-only mutations forwarded,
  status was writable, scopes/listing were unfiltered and guarantees ignored.
  The adapter now checks policy before forwarding. Unsupported remote search,
  active-file reads and atomic/revision promises fail closed. Legacy authorized
  reads and simple writes without those promises remain available. Remote symlink
  canonicalization is a plugin boundary; choose filesystem mode for that contract.
- Cache: a preexisting `0777` cache and linked vault-cache directory were accepted
  before the fix. Owned POSIX roots/vault directories now use `0700`, temporary
  snapshots use `0600` + `wx`, and rename-failure cleanup is tested. Index startup
  purges old bodies and rebuilds within current scopes. A controlled `umask(0)`
  verifies resulting modes. Windows must use an owner-only inherited NTFS ACL;
  chmod is not claimed to implement it. Inspect `icacls <CACHE_DIR>` and remove
  broad user/group access before deployment. Existing shared caches need explicit
  operator migration. See README for retention and cleanup.
- HTTP: malformed JSON demonstrated parse-before-policy behavior. Host and
  Origin checks, token validation and encoding rejection now run before the
  explicit JSON parser; `inflate:false` is a second guard. Tests spy on the real
  Brotli decoder and observe zero calls for benign compressed unauthorized,
  hostile-Host and authorized requests (401/403/415 respectively). Normal
  authenticated MCP HTTP and STDIO still have integration coverage.

## CVE-2026-111497 source and runtime assessment

The [official Node.js advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
identifies the Brotli decoder problem and patched release lines. Supported policy
is `^22.23.4 || ^24.22.1`; Node 20/odd majors and untested Node 26 are rejected.
A CLI startup assertion enforces this beyond advisory npm engines; the exported
HTTP startup also checks it before opening a backend. CI pins both patch floors
and asserts the exact binary version. Node 24.20.0 was safely invoked against the
compiled CLI and exited with the runtime-policy error before opening a vault.

Original path at `3c296b8`: `createMcpExpressApp` (SDK 1.29.0) installs
`express.json` before Host validation; body-parser 2.2.2 can call
`zlib.createBrotliDecompress` before the route Bearer check. This is **CONFIRMED
source-level reachability**, not evidence of RCE in a deployed service. Current
SDK is 1.32.2, Express 5.3.0; this server builds its own app with policy before
`express.json({limit:102400, inflate:false})` rather than relying on factory order.

| Surface | Decode reachability in this source | Runtime/deployment evidence |
| --- | --- | --- |
| CLI / STDIO | NOT_REACHABLE for network Brotli ingress: no HTTP listener; tool bodies have no zlib path | Verified Linux x64, Node v24.22.1 at `/home/thinhnq/.nvm/versions/node/v24.22.1/bin/node`; existing NVM-managed install, supplier checksum not independently reverified |
| Loopback HTTP | NOT_REACHABLE via encoded request bodies after this gate; benign integration probe observes zero decoder calls | Local ephemeral test listener uses the same patched binary; no real vault |
| Network HTTP | Same source gate; requires token, allowed Hosts and TLS-proxy acknowledgment | UNVERIFIED deployment; no external service, firewall, proxy or deployed binary was inspected |
| Local REST outbound | NOT_REACHABLE via the implemented `http.request` / `https.request` client: response chunks are concatenated and converted to UTF-8 without decompression | Real synthetic loopback response with `Content-Encoding: br` is returned as encoded bytes, not inflated |
| Other outbound / SDK client features | No application `fetch`, Undici or zlib call was found; SDK OAuth/client fetch helpers are not configured by this server | Future features or caller-supplied client transports require a new audit; no claim about arbitrary SDK usage |
| CI | Exact Node 22.23.4 / 24.22.1 matrix, runtime assertion and benign tests | PR check URLs provide actual OS/version results |
| Containers / published alpha.0 / existing launchers | UNVERIFIED: no container manifest exists in this repo, and deployed launchers were not supplied | Registry alpha.0 is unchanged; it does not receive this patch until an approved release and operator runtime upgrade |

Never treat ingress rejection or an npm engine field as a substitute for patched
Node binaries. This work sends no exploit payload and makes no production RCE
claim. Maintainers must inventory/restart actual deployments; that operational
part of #23 remains open after source remediation.

## Dependency, CI and release policy

The initial local lockfile audit reported 19 findings (including high/critical).
The updated lockfile audits clean locally for production and development. Audit
results are time-dependent; CI blocks high/critical findings and treats registry
outages as verification failures. CodeQL security-extended analysis and weekly
Dependabot updates are committed, Actions use immutable verified commit SHAs,
workflow permissions are read-only except the CodeQL upload job, and no publishing
credential is used. GitHub secret scanning and push protection were enabled when
inspected. Dependabot alert inventory is unavailable to the current token; see
RELEASING.md for that permission limitation.

Package identity, alpha version, dual executable aliases and historical artifact
provenance come from merged PR #25. This bundle retains them, raises vulnerable
dependency floors and runs the actual packed-tarball smoke check. No registry tag,
publish, deployment, auto-merge or source data-format migration is performed.

## Validation

Use `npm ci`, `npm run build`, `npm run lint`, `npm test -- --maxWorkers=2`,
`npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=high`,
`npm pack --dry-run` and `npm run smoke:package`. Full-suite and exact PR CI
results are recorded in [PR #27](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/27).
Local clean-lock verification on Node v24.22.1 passed 488 tests across 22 files,
build/lint, packed-tarball smoke for both executables and both audit commands
with zero findings. CI and CodeQL links in the PR refer to the reviewed head. All tests use
disposable synthetic vaults; regex adversarial probes have child-process kill
deadlines, benign Brotli input only is used for transport checks.

Rollback and release approval: follow RELEASING.md. Stop network HTTP and use
STDIO on a patched runtime while reviewing any regression. Do not restore an
unpatched runtime or vulnerable dependency lock as a mitigation.
