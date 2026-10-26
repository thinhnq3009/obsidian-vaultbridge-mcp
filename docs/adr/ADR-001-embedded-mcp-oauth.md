# ADR-001 — Embedded MCP OAuth, SQLite and SDK v2

- Status: **ACCEPTED architecture / IMPLEMENTATION SPIKE IN PROGRESS** (2026-10-25)
- Issue: [AUTH-001 #45](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/45), parent [#39](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/39)
- Source baseline: `develop@98b33c8b84f8d7c475a11ed1916fbb88c4c7376b`
- Target: `v0.2.0-alpha.0`; first public `v0.1.0` release [#38](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/38) stays isolated
- This ADR is NOT evidence of a working OAuth implementation or passing CI.

## Library selection — final owner decision (2026-10-25)

**APPROVED AND LOCKED: Better Auth** is the primary authentication and OAuth authorization-server framework for VaultBridge v0.2.0. Do not reopen a Better Auth vs. custom OAuth implementation comparison in AUTH-001. Do not substitute a home-grown authorization/token/PKCE layer without a separate documented technical blocker and owner approval.

- OAuth/MCP: `better-auth` + `@better-auth/mcp` + `@better-auth/cimd`, plus its maintained JWT support according to compatible upstream packages. Confirm exact plugin APIs and package versions by installation/tests before applying implementation code.
- Application-owned features: loopback-only first-run setup, small login/consent/admin UI, SQLite file placement/migrations, vault-to-user/client grants, per-request authorization bridge. SQLite driver remains under compatibility test; `node:sqlite` preferred only if supported runtime tests pass.
- Security: never duplicate library OAuth endpoints with manually coded flows, never weaken `MCP_AUTH_TOKEN` compatibility/STDIO or existing filesystem protections.
- AUTH-001 moves from **library selection** to **Better Auth integration and interoperability feasibility**. If version, license, security or Node compatibility blocks adoption, record reproducible evidence and escalate before changing framework; do not silently switch libraries.

## Decision

Build the OAuth authorization server **inside the local MCP application process** using maintained components rather than manually implementing OAuth or cryptography:

| Component | Decision | Owner |
|---|---|---|
| OAuth, authorization codes, PKCE, token & consent | `better-auth` and `@better-auth/mcp` | Upstream library |
| Client metadata | `@better-auth/cimd` with `metadataProfile: "mcp-2026-07-28"` | Upstream library |
| Signing / JWT keys | Better Auth `jwt()` plugin | Upstream library |
| MCP stateless HTTP and STDIO | `@modelcontextprotocol/server` v2; optional official Express / Node adapters | Official MCP SDK |
| Local persistence | SQLite under per-user OS app-data, outside vault; test `node:sqlite` on required Node matrix before choosing driver | VaultBridge |
| Login, consent, owner bootstrap, UI | Minimal first-party pages | VaultBridge |
| Per-principal/client/tool/path ACL | First-party policy bridge, intersecting global VaultAccessPolicy | VaultBridge |

The existing repository uses `@modelcontextprotocol/sdk ^1.32.2` and a stateless `StreamableHTTPServerTransport` per request. Merely changing imports to SDK v2 **does not enable** the 2026-07-28 protocol: use `createMcpHandler(..., { legacy: "reject" })` for the new HTTP path and `serveStdio` where appropriate, and explicitly validate any old-client compatibility requirements. Preserve the current `src/http.ts` Host/Origin/request-budget/content-encoding controls around handlers. Migration should follow the upstream codemod only in an isolated branch, then repair custom tool registration wrappers and tests manually.

**Do not register `oauthProvider()` alongside `mcp()`**; MCP plugin is already the OAuth provider. The JWT plugin is mandatory. Prefer CIMD; Dynamic Client Registration is *disabled* by default. When old client compatibility requires DCR, enable it only as an explicit operator-controlled mode after negative tests, without weakening redirect validation.

## Interface / modes

| Mode | Transport | Identity / setup | Default exposure |
|---|---|---|---|
| `stdio` | Existing stdio, unchanged | Local process trust, no OAuth | local only |
| `http-static` | Current HTTP + `MCP_AUTH_TOKEN` | Static Bearer for compatibility | loopback; network requires existing allowlist + TLS proxy controls |
| `http-oauth` | SDK v2 stateless HTTP POST + protected-resource challenge | OAuth Authorization Code + PKCE S256, Better Auth users/clients/grants | loopback by default, explicit HTTPS proxy/tunnel remote |

The OAuth mode MUST fail closed if issuer/resource URL, TLS, first-run owner setup or signing keys are invalid. Never silently fall back to static token or unauthenticated MCP. Avoid public `/setup` or `/admin` routes. Serve metadata under spec-mandated well-known URLs and the provider under `/oauth2/*`; route shape is verified by plugin integration tests rather than hand-coded equivalents.

## Owner revision — explicit OAuth/none/token modes and configurable budgets (2026-10-26)

**Approved requirements / planned work, not yet implemented by AUTH-001 spike:** OAuth is the HTTP default for new v0.2.x installations, but operators MAY explicitly disable authentication. Do not treat no-auth as a CodeQL false-positive exception, and do not confuse brute-force controls with MCP agent throughput.

### Authentication-mode contract

- `MCP_AUTH_MODE=oauth|token|none`; new HTTP install default is `oauth`. `stdio` remains independent, local and unchanged.
- `oauth`: Better Auth Authorization Code/PKCE with principal/client/scope-bound MCP authorization; no silent downgrade to static-token or anonymous on setup failure, invalid bearer or expired tokens. On first run, guide loopback-only owner setup and fail closed until initialized.
- `token`: explicitly retain legacy `MCP_AUTH_TOKEN` constant-time Bearer verification for backwards compatibility. A pre-existing install with `MCP_AUTH_TOKEN` set and no explicit mode may resolve to `token` during migration with a clear warning; new installations must choose their mode explicitly. Do not accept token and OAuth simultaneously without a separate reviewed design.
- `none`: explicit opt-out; fully unauthenticated MCP within the existing global filesystem, read-only and path constraints. Print an unmissable warning at every startup (also persistent UI warning when admin UI exists); disable OAuth login/consent endpoints in this mode. Never silently select `none`.
- Loopback-only for `none` by default. Allow non-loopback anonymous access only with an additional explicit `MCP_ALLOW_UNAUTHENTICATED_NETWORK=true` acknowledgement AND the established TLS-termination, trusted-host/Origin and deployment allowlist safeguards; always warn of possible complete vault exposure. Absent these gates, reject startup. No public `/setup`/`/admin` in any mode.
- Refactor `src/config.ts::validateHttpDeployment` so non-loopback does not unconditionally demand `MCP_AUTH_TOKEN` when mode is `oauth`. Evaluate the active mode instead and fail closed on inconsistent combinations. Keep `MCP_HTTP_HOST`, `MCP_ALLOWED_HOSTS`, `MCP_HTTP_TLS_PROXY` validation.
- Configuration precedence is already CLI flags > process ENV > `.env` > defaults; extend existing Zod schema and CLI mapping. Include e.g. `--auth-mode oauth|token|none`, `--mcp-rpm`, `--mcp-burst`, `--mcp-max-concurrent`, `--login-max-failures`. Environment/CLI changes take effect on next restart; avoid unreviewed hot config mutation.

### Distinct rate-limit layers (tunable starting budgets, not performance guarantees)

| Layer | Suggested starting policy | Key / purpose |
|---|---|---|
| Invalid/missing auth to protected MCP | `MCP_UNAUTHENTICATED_ATTEMPT_RPM=60` per IP | Cheap pre-verification throttle; 401 + OAuth challenge remains when under budget |
| Password login | `MCP_AUTH_LOGIN_MAX_FAILURES=5`, `MCP_AUTH_LOGIN_WINDOW_SECONDS=900`, plus IP-based controls/backoff | Protect against brute-force; never use the generous MCP RPM limit here |
| OAuth token/authorize/revoke | Reuse Better Auth's built-in per-route policies with rateLimit explicitly enabled even in dev/test, tune only when needed | Avoid duplicate custom OAuth logic; check plugin-specific limits |
| Aggregate MCP tool traffic | `MCP_RATE_LIMIT_RPM=1200`, `MCP_RATE_LIMIT_BURST=120` | Token-bucket (or equivalent) global protection, sized initially for ~2–3 agents |
| Per authenticated client | `MCP_AUTHENTICATED_CLIENT_RPM=600` | Fairness per verified OAuth client/principal, not spoofable request header |
| MCP in-flight | `MCP_MAX_CONCURRENT=32` | Protect server work/memory, independent of RPM; release once on completion/disconnect |

- Approximate sizing: 3 agents x 300 average RPM = 900 RPM; ~30% headroom is ~1,170 RPM, hence 1,200 initial global RPM pending measured latency/CPU/429 benchmarks. Current `src/http.ts` hardcodes 120 RPM for ALL requests and 32 in-flight; migrate the fixed 120 limit to config rather than retaining it alongside new quotas.
- In `none` mode, don't confuse an untrusted `client_id` header with a verified identity: enforce global and trustworthy source-IP budgets. Multiple agents from one local host must be allowed to share the 1,200 RPM aggregate budget. Never partition access via a user-supplied, unverified value.
- Protected mode should count failed/absent credentials against a *separate* conservative budget; successful verified agent tool calls use their own larger bucket.
- Always preserve a finite protective ceiling; config overrides must be validated (positive integers, safe upper bounds); log meaningful warnings for unusually high values. `429` should include `Retry-After`, and health/metadata routing should not be inadvertently broken. Keep burst/concurrency distinct from request rate.
- Trust source IP only from the actual TCP peer or explicitly configured, validated reverse proxies; do not trust user-supplied forwarding headers. In a single local process an in-memory limiter is adequate; document that distributed/multi-instance deployments need shared enforcement or an upstream gateway.
- All modes retain host/origin checks, request byte/time budgets, max file size, path and symlink controls, read-only and revision-safe writes. `stdio` behavior remains unchanged.

### Implementation / verification gates

1. **AUTH-001 / PR #50**: protect spike `/mcp` before `requireMcpAuth` with a bounded limiter; explicitly enable Better Auth rate limiting. Keep the 401 `WWW-Authenticate` discovery challenge in normal conditions; verify 429 under flooding. This is an isolated spike, not yet the production mode migration.
2. **AUTH-002 (#46)**: strict password-guessing protections and first-run owner setup; warn on anonymous mode rather than creating login UI dependencies for users who chose `none`.
3. **AUTH-003 (#47)**: implement mode resolver, config and CLI mapping, configurable HTTP traffic budgets and OAuth route policies; validate mode/exposure combination and backward compatibility with static token.
4. **AUTH-004 (#48)**: enforce principal/client-scoped authorization only for OAuth; anonymous operation must continue to honor global vault policy without manufacturing an identity.
5. **AUTH-005 (#49)**: test 2–3 simulated MCP agents at sustained/peak traffic, mixed anonymous/valid/invalid auth requests, trusted proxies, 401/429 behavior, disabled OAuth endpoint paths, and every supported OS/Node matrix before release.

## Resource and principal safety boundary

1. Token verification binds issuer, audience / resource (canonical `https://host/mcp`), expiry and scope. Scope approval and refresh/revocation are durable.
2. Build immutable per-request context `{ principalId, clientId, grantId, vaultId, scopes }`.
3. Effective authorization: `global policy ∩ user vault grants ∩ consented client scopes ∩ tool/action/path permissions`; fail closed.
4. Search/list/index results and cache must use the same scope. Keep filesystem symlink/path/revision and read-only defenses.
5. No mutable singleton principal on `ApplicationContext` or `VaultBackend`. Binding a shared backend to one request's identity would leak privileges across concurrent requests.
6. SQLite/JWT keys must not be in Obsidian vault, tool responses, git or packaged tarball.

## Threat model / gate

- Network setup takeover before admin is enrolled; explicitly loopback-only one-time bootstrap, not unauthenticated signup on remote address.
- OAuth redirect/client metadata SSRF, account mix-up, forged token and callback, PKCE downgrade, code replay, refresh rotation reuse; prefer maintained defaults and test against malicious inputs.
- Tunnel/proxy changes `Host`, `Origin`, scheme or client URL: validate a single canonical HTTPS issuer/resource and deployment allowlist.
- Cross-client vault leakage and concurrent request policy races.
- Browser CSRF, session fixation, cookie settings and password brute-force.
- Old MCP static-token mode no longer secure merely because OAuth is added: keep hardening and migration docs.

## Spike execution and criteria

1. Run `node scripts/spikes/oauth-sqlite-preflight.mjs` locally and in CI on **supported Node 22.23.4 and 24.22.1** on Ubuntu/macOS/Windows. It uses a disposable temporary SQLite DB and leaves no user data. It proves only that the runtime can use SQLite WAL and perform atomic one-time code consumption; **it is not an OAuth implementation**.
2. Pin compatible Better Auth / MCP v2 dependencies in an isolated branch. Run package lockfile audit, build and dependency license check; no version assumption without installing.
3. Run an end-to-end disposable-server flow: discovery → browser owner login → consent → code + PKCE → resource-bound access token → MCP tool → refresh → revoke. Verify 401 challenge and wrong audience/scope/redirect/PKCE fail.
4. Repeat over a generic MCP OAuth client, remote HTTPS proxy where applicable, and ChatGPT only if the account client capability allows.
5. Run existing STDIO, static Bearer, filesystem security regressions on six Node/OS CI configurations before implementation PR merge.

## Implementation delivery

- **AUTH-001** [#45](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/45): ADR, runtime feasibility, SDK migration plan.
- **AUTH-002** [#46](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/46): SQLite persistent accounts and local owner UI.
- **AUTH-003** [#47](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/47): MCP OAuth provider and token lifecycle.
- **AUTH-004** [#48](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/48): Request-scoped authorization.
- **AUTH-005** [#49](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/49): Generic client E2E, HTTPS guide and controlled release.

**Rollback:** These features remain behind an explicit mode until reviewed. Release 0.1.x can use original code/lockfile unmodified; operator can keep stdio/static mode if OAuth beta is unsuitable.

## Upstream docs (verified 2026-10-25)

- [Better Auth MCP](https://better-auth.com/docs/plugins/mcp) — `mcp()`, `cimd()`, token challenge and metadata
- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider) — grants, redirect/PKCE and CIMD/DCR
- [Better Auth SQLite](https://better-auth.com/docs/adapters/sqlite) — `node:sqlite` / better-sqlite3
- [Better Auth 1.7 upgrade](https://better-auth.com/docs/guides/1-7-upgrade-guide) — MCP plugin and SDK v2
- [Official MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [SDK migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2) — codemod/manual changes/protocol cutover

## AUTH-001 implementation spike — verified 2026-10-26

The isolated executable proof lives in `scripts/spikes/better-auth-sdk-v2/`; it has its own exact-version `package.json` and lockfile and is not imported by the production application. It starts an ephemeral Express listener bound to `127.0.0.1`, creates a temporary built-in `node:sqlite` database in WAL mode under the OS temp directory, runs Better Auth's supported `auth.$context.runMigrations()` operation, and removes the database at exit. Public sign-up is disabled. No root production dependency or lockfile, static-token path, STDIO path, or release workflow was changed.

Latest package registry versions and compatibility metadata were rechecked on 2026-10-26. Exact spike dependency versions:

| Package | Exact version | Compatibility evidence |
|---|---:|---|
| `better-auth` | `1.7.13` | ESM; optional framework/adapter peer dependencies; minimum Node not declared |
| `@better-auth/mcp` | `1.7.13` | peers `better-auth ^1.7.13`, `@better-auth/core ^1.7.13`, `better-call 1.4.4`; resolves OAuth provider `^1.7.13` |
| `@better-auth/cimd` | `1.7.13` | same Better Auth/core peers and OAuth provider `^1.7.13`; separate `./node` export |
| `@better-auth/oauth-provider` | `1.7.13` | transitively installed by MCP/CIMD; not separately registered as a plugin |
| `@modelcontextprotocol/server` | `2.4.0` | Node `>=20`; ESM and CJS exports |
| `@modelcontextprotocol/express` | `2.0.2` | Node `>=20`; Express `^4.18 || ^5`, SDK server `^2.3` peers |
| `@modelcontextprotocol/node` | `2.1.2` | Node `>=20`; SDK server `^2.4` peer |
| `@modelcontextprotocol/codemod` | `2.4.0` | Node `>=20`; published official migration tool |
| `better-sqlite3` (alternative) | `13.0.3` | Node `>=22`; attempted, but Windows Node 22 CI could not build its native addon because node-gyp could not detect the runner's VS 18 installation |
| `node:sqlite` | Node built-in | No extra package or native addon; works on both repository Node floors, but prints ExperimentalWarning on Node `22.23.4` |
| `express` | `5.3.0` | Express 5-compatible SDK adapter peer |

The committed isolated lockfile resolves and installs successfully on Node `22.23.4` and `24.22.1`. Both smoke runs use bundled SQLite `3.53.4`: Better Auth serves the RFC 9728 protected-resource document at `/.well-known/oauth-protected-resource/mcp` and RFC 8414 authorization-server metadata at the URL discovered from that document; metadata advertises CIMD support. The SDK v2 `createMcpHandler(..., { legacy: "reject" })` composes with Better Auth's `requireMcpAuth`; missing Bearer credentials are rejected with 401 and a `WWW-Authenticate` resource-metadata challenge. A disposable database is initialized with Better Auth plugin migrations, including JWT and OAuth tables.

The package registry reports SDK v2 packages require Node `>=20`; both repository engine floors satisfy that declared range. The POC passed on **Linux Node `22.23.4` and `24.22.1`** using the built-in `node:sqlite`, including WAL, Better Auth schema migrations, metadata and challenge checks. Node `22.23.4` emits its runtime ExperimentalWarning for `node:sqlite`; Node `24.22.1` does not. This is not itself a failing runtime test, but it is a stability concern for adopting this adapter at the current minimum Node 22 floor.

The original matrix attempt using `better-sqlite3@13.0.3` passed on Linux and macOS but **failed on Windows Node 22.23.4 during `npm ci`**: `node-gyp` could not detect the Windows runner's Visual Studio 18 installation and could not build the addon. This is a reproducible runner/native-build blocker, not proof the library cannot work on Windows with a supported compiler setup. For the minimal cross-platform spike, the committed harness now uses `node:sqlite` to avoid that native build dependency; the rerun matrix must verify Windows. Production SQLite adapter remains a follow-up decision: either stabilize `node:sqlite` across the supported floor or repair/prove a native addon build across platforms. Better Auth's manifest declares no minimum Node version.

**Not implemented or claimed:** browser login/consent pages, safe one-time owner bootstrap, successful Authorization Code + PKCE exchange, token-to-tool success, refresh/revocation, malicious redirect/scope/client tests, wrong issuer/audience, or CIMD SSRF negative cases. These are blocked on AUTH-002 account/bootstrap/UI and additional AUTH-003 provider test work. `fetchClientMetadataResource` is Better Auth's published Node transport, which promises DNS resolve-once checks/pinning and no redirect following; application-level metadata URL policy still needs explicit tests before remote use. This partial smoke test is not ChatGPT interoperability evidence.

**SDK v1 → v2 findings:** do not change production handlers by import substitution. v2 uses `@modelcontextprotocol/server` and its per-request `createMcpHandler` model; v2 docs prescribe `legacy: "reject"` for a strict 2026-07-28 route. The existing `McpServer` tool registration wrappers, callback extra arguments, HTTP transport lifecycle/error handling, STDIO adapter, and legacy client/protocol expectations still require targeted migration and regression tests. The official `@modelcontextprotocol/codemod@2.4.0` CLI was inspected and run with `v1-to-v2 --dry-run` against this source tree: it proposed 33 changes across 14 files, warned on four manual migration issues in `src/server.ts` (removed `zod-compat` types, `RequestHandlerExtra`/`ServerContext` changes and context-property remapping), and proposed package dependency changes. Dry-run did not write files. This is evidence the codemod is useful as a reviewed assistant but **not safe to apply wholesale without manual repair and the regression matrix**. Existing Host/Origin, request-size, throttle, `MCP_AUTH_TOKEN`, vault path, read-only and atomic revision defenses remain in the unchanged production v1 path.

**Security/audit:** `npm audit --audit-level=high` for the isolated spike dependency tree reported zero vulnerabilities on 2026-10-26. This is a point-in-time registry audit, not an independent code audit or guarantee of absence. CIMD is untrusted remote metadata: enforce strict URL policy and the library's DNS pinning/redirect guarantees. The local spike uses a throwaway secret and does not expose registration, setup, or a public listener.

### Scope boundary for follow-up

- AUTH-002: owner-only local bootstrap, account persistence lifecycle, login/consent UI, and non-public test-user setup.
- AUTH-003: real Better Auth authorization-code + PKCE, CIMD client resolution, resource/audience verification, refresh rotation/revoke, and protocol-negative tests using a separate disposable DB.
- AUTH-004: immutable request-scoped principal/client/vault context and authorization intersection; no shared mutable identity on the backend.
- SDK migration PR: separately migrate production HTTP/STDIO with the official codemod only as a reviewed aid; preserve v1/static mode until explicit compatibility and security tests pass.
- AUTH-005: generic OAuth MCP client E2E, matrix CI, release docs; test ChatGPT only if an actual supported connection succeeds.
