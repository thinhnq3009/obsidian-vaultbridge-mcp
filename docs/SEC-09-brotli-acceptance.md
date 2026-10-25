# SEC-09 / issue #23 — Brotli remediation acceptance

Assessment date: 2026-10-25 (Asia/Ho_Chi_Minh). Source baseline:
`develop@8a4c28093f343d405658d3ac9dc5b06ea18486be`.

The runtime and ingress fixes are already merged through the security bundle.
This follow-up records acceptance evidence and adds regression checks for CLI
and exported HTTP startup ordering and package/lock/runtime policy agreement.
It changes no production handlers or vault formats.

## Runtime and deployment inventory

The owner answered **“Chưa triển khai ở đâu”** (“not deployed anywhere”) in the
2026-10-24 issue #5 chat (`01a16ea4-4f33-7992-ba66-1ae898998a0b`). The same
declaration is retained in `docs/releases/issue-5-current-artifact.json` under
`deployment_inventory`. No existing deployment requires an operational upgrade.
This is an owner declaration, not a scan of unknown hosts or npm consumers.

| Surface | Observed runtime / provenance | Disposition |
| --- | --- | --- |
| Local development and synthetic CLI/STDIO/HTTP tests | Linux x64; `/home/thinhnq/.nvm/versions/node/v22.23.4/bin/node` and `/home/thinhnq/.nvm/versions/node/v24.22.1/bin/node`; existing NVM-managed installs | Supported patch floors, measured via `process.version` and `process.execPath` |
| CI | Ubuntu/macOS/Windows; actions/setup-node v7.1.0 pinned by commit; exact 22.23.4 and 24.22.1 | Every test job asserts the exact version, then checks the compiled runtime guard |
| Self-hosted / Docker / public HTTP | Owner reports no deployments; no Docker/deployment manifest supplied | No rollout/restart claimed; future deployment checklist remains mandatory |
| Published npm alpha.0 | No Node binary is bundled; consumer chooses runtime. Registry still advertises `>=20.11.0` | Consumer exposure UNVERIFIED; this old artifact has not been patched or republished |
| Prepared alpha.1 | No Node binary is bundled; engines and executable startup require `^22.23.4 || ^24.22.1` | Installed-tarball smoke runs both executable aliases on supported runtimes; publication remains #5 |

Observed local executable SHA-256 (identity only; supplier checksums were not
independently reverified):

- Node 22.23.4: `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`
- Node 24.22.1: `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`

Supported majors are deliberately restricted to 22 and 24. Node 20, odd majors,
unpatched 22/24, prereleases and untested 26 are rejected, even though the
[official Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
also supplies a fix for Node 26. A blanket `>=22.23.4` would be insufficient.

## Decoder reachability

Historical source at `3c296b83f842831d680c386231d7350f09b3e405`:

```text
JSON request + Content-Encoding: br
  -> SDK 1.29.0 createMcpExpressApp
  -> express.json / body-parser 2.2.2
  -> node:zlib.createBrotliDecompress
  -> Host validation -> route Bearer check
```

This historical path is **CONFIRMED** source reachability before authentication;
it establishes neither a deployed vulnerable runtime nor successful RCE.

Current lock: SDK 1.32.2, Express 5.3.0, body-parser 2.4.0. `src/http.ts` owns
the app instead of using the SDK factory:

```text
assertSupportedNode -> validate deployment -> initialize backend
request -> Host -> Origin -> Bearer -> Content-Encoding -> budgets
        -> express.json({ limit: 102400, inflate: false }) -> MCP route
```

| Path | Classification | Evidence / limits |
| --- | --- | --- |
| STDIO inbound | NOT_REACHABLE for HTTP Brotli | No HTTP listener or decoder path in the application STDIO/tool handlers |
| Loopback or network HTTP encoded bodies | NOT_REACHABLE through current request parser | Benign br JSON returns 401 without auth, 403 for hostile Host, 415 when authorized; spy observes zero Brotli decoder calls |
| Other encoded request bodies | NOT_REACHABLE through current parser | All non-identity encodings rejected before parser; `inflate:false` also rejects compressed input. This includes gzip/deflate and encoding lists |
| Local REST outbound responses | NOT_REACHABLE through built-in client | `src/obsidian/client.ts` uses `http.request`/`https.request`, concatenates chunks and converts to UTF-8; benign br response test returns encoded bytes without inflation |
| Application fetch/Undici/zlib | NOT_REACHABLE in audited application path | No calls/imports in `src`; SDK client/OAuth fetch helpers are not configured in the server. Arbitrary custom client transports are outside this claim |
| Unknown consumer/proxy/deployment | UNVERIFIED | No public endpoints probed; a proxy that decompresses/relabels bodies has its own runtime and policy |

Tests use synthetic notes and benign compressed JSON on ephemeral loopback
listeners only. No RCE payload, memory-corruption probe or real vault is used.

## Reproducible validation

Run from the checkout with the selected patched Node binary first in PATH:

```sh
node -p 'JSON.stringify({version:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch})'
npm ci
npm run build
npm run lint
npm test -- --maxWorkers=2
npm pack --dry-run
npm run smoke:package
npm audit --omit=dev --audit-level=high
```

Run coverage sequentially for the two versions because Vitest locks the report
directory. New CLI tests simulate unsupported version metadata in a child
process and pass deliberately invalid config: runtime refusal must happen first,
stdout must remain empty, and the child must exit with status 1. HTTP tests
similarly require refusal before the injected backend factory is called.
These are startup contract tests, not evidence of running old decoder code.

Baseline CI on the exact source SHA above passed all six OS/runtime jobs and
dependency audits in [run 40200994295](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/actions/runs/40200994295).
PR checks for this follow-up must also pass on its exact head before merge.

Local results on Linux x64, 2026-10-25:

- Clean `npm ci`, full V8 suite: **504/504 tests in 23 suites** on each of
  Node 22.23.4 and 24.22.1. Build, lint and package dry-run passed. The final
  HTTP encoding assertions also passed separately on Node 24.
- Installed-tarball smoke passed on each supported runtime through both
  `obsidian-vaultbridge-mcp` and `obsidian-local-rest-mcp` executable aliases;
  synthetic MCP create/read/replace/stale-revision checks passed.
- Full and production `npm audit --audit-level=high` reported zero advisories.
- Actual Node 24.20.0 running the compiled CLI with an invalid configuration
  option exited 1 with the unsupported-runtime message before config parsing.
  This invocation did not start a transport, open a vault or decode input.
- One initial overlapping coverage invocation was refused by Vitest's report
  lock before tests started; both complete runs above were then run sequentially.

The prepared tarball integrity after the release-document update is
`sha512-NbbR+iROfzOdEVTOU1G0hLWCzXamCLYWHUPBn706m4aalGPZONAHeC2WuU9Jv8t1CDS2+htI5nI+MIOgkQGKwg==`.
It supersedes the earlier candidate checksum for this checkout only; it is not
a published artifact or a modification of historical release evidence.

Review limitation: `codex-with-chatgpt` was consulted as required, but its session
reported `projectReady:false` with no bound Project/chat. No independent ChatGPT
review is claimed; local source tracing and executable checks provide this record.

## Mitigation, rollback and release boundary

For any future launcher, verify its actual Node binary matches the supported
range and restart processes after upgrading. Keep STDIO as the default. HTTP
must retain Host/Origin/auth checks before parsing, reject compressed bodies,
limit requests to 100 KiB and use the documented trusted TLS proxy/firewall
requirements. An ingress filter cannot replace the patched runtime, including
for future outbound response decoders.

If a regression occurs, stop HTTP and use STDIO on a patched runtime while
preparing a fix. Never roll back to an unpatched runtime as a mitigation.

Repository remediation and the declared zero-deployment inventory satisfy the
source/operational scope of #23 after review and green CI. Existing npm consumers
remain unverified: **alpha.0 is unchanged**. #5 retains owner-approved publication,
provenance, registry-artifact verification and user migration; this acceptance
does not authorize a release or resolve unrelated CodeQL alerts. Future public
exposure on an unpatched runtime must reopen the security assessment.
