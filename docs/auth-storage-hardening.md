# Owner storage hardening and CodeQL follow-up

Tracking: #55 (alert 7), #56 (alert 8), #57 (alert 9). This is partial
remediation and source-level triage, not approval to close the issues, dismiss
alerts, or enable OAuth publicly.

## Storage (#55 / #56)

`openAuthStorage` is called by `createOwnerAuth`; its returned secret and
SQLite connection feed the identity provider. Initialization continues to
require private app data outside the vault, owner-only POSIX permissions or
Windows DACLs, and an exclusive directory lock.

Changes:

- Optional-file inspection uses `lstat` and treats only `ENOENT` as absence.
  Dangling links cannot masquerade as missing keys, databases or sidecars.
- Existing key and database files are opened with no-follow/non-blocking flags
  where supported. File type, link count, ownership and mode are checked on
  the open descriptor. Device/inode identity must agree with the pathname.
- Session key reads use that descriptor, not a later pathname open. Reads
  stop at 65 bytes; only an unchanged 64-byte base64url key is accepted.
  Path replacement during the read fails closed.
- Creation remains exclusive (`wx`); a competing file is never overwritten.
  Existing databases with a missing key still fail closed without generating
  a replacement key.
- The SQLite pathname is compared with its pinned descriptor before PRAGMAs
  and after initialization. Initialization failure closes the connection and
  descriptor and releases the directory lock, even if cleanup throws.

Regression coverage: `test/authStorageRaces.test.ts` exercises malformed and
oversized keys, restart persistence, exclusive creation, missing-key recovery
failure, pathname replacement before open and after key open, and dangling
symlinks. Existing owner-auth coverage retains WAL, migrations, hard-link and
permission rejection, locking and recovery checks.

### Remaining trust boundary

`node:sqlite` accepts a **pathname**, not an already-validated descriptor.
Identity comparisons detect ordinary persistent swaps but cannot make its
open atomic against a malicious writer that swaps entries away and back.
The same limitation applies to directory/ancestor changes, SQLite sidecars,
and Windows ACL pathname operations. No claim is made that a same-user
attacker with write access to private app data is sandboxed.

Do not close #55 or #56 until the exact scanner paths and supported-platform
behavior have been reviewed on the final SHA. Eliminating all pathname races
would require an explicitly reviewed change to the storage/trust model; do
not suppress CodeQL merely because a test suite passes.

## Test credential flow (#57)

Historical source inspected:
`c02b0bd0b7a29f5be561c7e9dd22f562606dca59:test/ownerAuth.test.ts`.
Its `enroll()` read `setup-token` from a disposable `mkdtemp` fixture and
passed it to `post("/setup", ...)`. The listener in `src/auth/http.ts` binds
the numeric address `127.0.0.1` and derives `origin` from that bound port.
No real vault or user setup token is used by this fixture. The current
bootstrap no longer uses that historical enrollment flow, but recovery still
sends a disposable file token, so changing line numbers is not remediation.

The test POST helper now explicitly rejects any URL outside its exact numeric
loopback origin, including alternate ports, and disables following redirects.
A regression verifies invalid targets are rejected before `fetch` is called.
Successful recovery and session invalidation coverage is retained.

This supports a bounded local-fixture interpretation, **not** a scanner
disposition. Alert 7 and alert 8 API reads returned HTTP 404 on November 2,
2026 with the current CLI credentials; the exact traces and live dispositions
could not be verified. No alert was dismissed and no review thread resolved.
Final-SHA CodeQL and reviewer approval remain required for #57.
