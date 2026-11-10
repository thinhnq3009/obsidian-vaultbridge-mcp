# Issue #60 — latest maintained provider recheck

The registry advanced to 1.7.16 during this investigation. The isolated SDK-v2
spike now pins all four Better Auth packages to 1.7.16. Production dependencies
are unchanged by this branch. The spike smoke passes, but both unchanged
security probes still exit 1 on Linux Node 22.23.4 and 24.22.1.

[Sanitized exact-version evidence](issue-60-better-auth-1.7.16.json) confirms
the same two lifecycle and four concurrency failures as
[the 1.7.15 recheck](issue-60-better-auth-1.7.15.md): pre-rotation access survives
revocation, concurrent refresh/revoke yields 500/400, and unrelated grants
are invalidated. Disposable databases/vaults and fixture CIMD were used.

[Upstream 1.7.16 release notes](https://github.com/better-auth/better-auth/releases/tag/v1.7.16)
include session/security corrections; they do not establish this OAuth
grant-family contract. No maintained atomic family contract was demonstrated
by these probes. Keep #60 open, assertions and known-fail workflow intact, and
OAuth default-off. Crash/restart/multi-worker and macOS/Windows acceptance
remain outstanding. No custom provider fork, publication or security approval.

Root validation: build/lint pass. Full serial coverage passes all 798 tests
across 44 files, with one existing skip (217.34s), using unchanged assertions
and timeout settings. The earlier two-worker timeout and isolated rerun are
recorded in the 1.7.15 note. Spike smoke also passes on 1.7.16; the separate
security probes remain deliberately failing. These results are distinct.
