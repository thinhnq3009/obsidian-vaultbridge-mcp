# Issue #60 — maintained provider recheck

On 2026-11-04, the isolated SDK-v2 spike pins Better Auth, MCP, CIMD and
OAuth provider to public version 1.7.15. The production dependency set is
unchanged by this branch. The spike smoke passes; both unchanged security
probes exit 1 on Linux Node 22.23.4 and 24.22.1.

- Lifecycle: original/intermediate opaque access tokens still reach the tool
  after refresh-family revocation (200 instead of 401).
- Concurrency: refresh-first produces 500, concurrent revoke produces 400,
  and unrelated same-client grants are invalidated in both launch orders.
- Full sanitized probe summaries, exact versions and commands are in
  [the JSON evidence](issue-60-better-auth-1.7.15.json). Each run used a
  disposable database, vault and deterministic client metadata.

The [upstream release](https://github.com/better-auth/better-auth/releases/tag/v1.7.15)
contains CIMD transport hardening, but does not satisfy this grant-family
contract. This is a dependency recheck, not a new CVE determination.

Issue #60 remains blocked on a maintained, reviewed durable family identifier
and atomic refresh/revoke contract, followed by restart/crash/multi-worker
and all supported OS checks. No provider fork or custom token ledger is
introduced. Existing assertions, known-fail workflow and the default-off
production OAuth guard remain intact. Passing routine CI is not a revocation
pass. No public OAuth/release approval is implied.

Validation note: root build and lint pass. An initial two-worker coverage run
reported four existing single-tunnel tests exceeding their 5-second budgets
(794 passed, one skipped). Their isolated rerun passed all 13 tests without
changing assertions/timeouts. A serial coverage rerun is recorded in the PR.
The spike dependency change does not modify the production dependency graph.
Spike dependency audit passes the high-severity gate but reports four moderate
findings through the development-only MCP codemod/minimatch chain, with no fix
reported by npm at observation; this is not a zero-advisory claim.
