# Embedded OAuth delivery and acceptance — issue #39

Snapshot: 2026-11-04. Base for the independent follow-up branches:
`develop@79d9c56c0e39f6dae54528f5e8ad85881ba5bfc8`.

The source has experimental Better Auth OAuth, local owner persistence/UI,
request-scoped vault grants and generic-client integration tests. The published
npm release remains 0.1.0. Source modules and passing routine CI do not establish
that v0.2.0 or every child issue has met its acceptance criteria.

## Separate follow-up PRs

| Issue | Reviewable change | PR | Remaining acceptance |
| --- | --- | --- | --- |
| #55 | Recheck directory identity/permissions after awaiting its storage lock. | [#82](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/82) | SQLite pathname trust boundary and supported-platform/independent security review. |
| #56 | Reserve a new DB exclusively before generating its session key; preserve competing data. | [#83](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/83) | Crash/restore and pathname-boundary review; no claim of a same-user sandbox. |
| #57 | Pin fixture credential POSTs to their literal loopback socket; reject redirects. | [#84](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/84) | Exact scanner evidence and reviewed disposition/conversation resolution. |
| #60 | Recheck unchanged security probes on maintained provider 1.7.15/1.7.16, with sanitized versioned evidence. | [#85](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/85) | Provider contract remains failing; no maintained atomic family fix demonstrated. |
| #47 | Align production Better Auth packages at 1.7.16, including maintained CIMD/session fixes. | [#86](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/86) | #60 lifecycle contract, production SDK-v2 migration and complete interop/security acceptance. |
| #48 | Bind each active tool to one live local-grant revision across revoke/regrant. | [#87](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/87) | Review full delivery and #60 residual risk; future invocations may use new local grants. |
| #49 | Real native OAuth MCP create/read/replace/delete, stale-revision/path denials and read-only token isolation. | [#88](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/88) | Browser/remote HTTPS/eligible ChatGPT, 1/2/3-agent benchmark, release OS/Node matrix, security and owner release decision. |
| #5 | Verify immutable npm 0.1.0 against its historical artifact contract, with strict source/integrity checks. | [#89](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/pull/89) | Alpha.0 exact-source evidence remains unavailable; npm.io indexing is external. |

These PRs each target develop from the same base. They are not an integrated
release, and their individual results are not a combined-branch test result.
Rebase shared storage/documentation edits and rerun the combined security,
authorization and package suites during reviewed integration.

## Validation evidence and limits

Linux Node 24.22.1 build/lint/full coverage and packaged CLI smoke pass for the
code follow-ups. Focused storage and published-artifact checks also ran on
Node 22.23.4. Actual published 0.1.0 passes both CLI names on Node 22/24;
current packages still require the new UI/artwork contract. See each PR for
exact commands, counts and final-head CI/CodeQL links.

Local native OAuth smoke passes the stronger writable flow. It does not use
a real ChatGPT connector or browser session. Production-provider tests replace
external CIMD IO with fixtures; scripts label their real metadata diagnostics
and native-client operation separately. No throughput benchmark, Windows/macOS
run, real remote HTTPS interoperability or public OAuth approval is claimed.

The #60 lifecycle and concurrency probes exit 1 on both Linux Node versions
with provider 1.7.15 and 1.7.16. Original/intermediate access survives family
revocation; concurrent refresh/revoke returns 500/400 and affects unrelated
grants. Keep these assertions and the known-fail manual workflow truthful.
Routine green CI is not a grant-family revocation pass. An initial two-worker
root coverage attempt had four single-tunnel timeouts; its unchanged isolated
suite and full serial rerun passed. This history is recorded in PR #85.

The required codex-with-chatgpt review is blocked at integrated-browser login.
Automated tests and source-level triage are not independent security approval.
All follow-ups remain Draft with Refs relationships. No issue closure, alert
dismissal, review-thread resolution, merge, version bump, publication or registry
tag change was performed by this sweep.

## Conditions before accepting #39

- Complete reviewed integration of the child work, including the intended
  supported MCP protocol/SDK contract without weakening STDIO/static-token
  compatibility or filesystem protections.
- Establish the maintained #60 grant-family/concurrency contract and validate
  restart/crash/multi-worker isolation, or obtain a documented owner decision
  on a changed requirement. No provider fork/custom token ledger is included.
- Review #55–57 on the final integrated SHA and record any scanner disposition
  and exact conversation evidence; successful analysis alone is insufficient.
- Finish AUTH-005 browser/remote-client/benchmark/OS evidence and the security
  review, then obtain the explicit owner merge/release decision.
- Keep OAuth opt-in/experimental until those deployment/release gates pass.
  Preserve the separate published v0.1.0 rollback path and matching SQLite/session-key backups taken while the service is stopped.
