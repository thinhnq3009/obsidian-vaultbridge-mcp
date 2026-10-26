# Migrating to Obsidian VaultBridge MCP

The standalone architecture changes the default from Obsidian Local REST API to direct filesystem access. The current package line remains `0.1.0-alpha.*`; the previous source declaration of `1.0.0` was not an approved stable VaultBridge release.

## Package and executable names

- Install `obsidian-vaultbridge-mcp@alpha` explicitly, or pin a reviewed prerelease version.
- Update MCP client package arguments from `obsidian-local-rest-mcp` to `obsidian-vaultbridge-mcp@alpha`. `npx obsidian-local-rest-mcp` still resolves the separate legacy npm package; adding an alias here cannot redirect that registry name.
- This package installs both `obsidian-vaultbridge-mcp` and the deprecated `obsidian-local-rest-mcp` executable alias to the same entrypoint. Existing direct executable configurations can keep working after installing the new package. No alias removal is scheduled in this prerelease line.
- For an explicit legacy executable invocation from the new package: `npx --package=obsidian-vaultbridge-mcp@alpha obsidian-local-rest-mcp --vault /path/to/test-vault`.
- A global install may conflict with an already installed old executable. Remove the legacy global package before installing the new one; do not use `--force` to silently overwrite it.
- Repository, homepage and issue links now target [obsidian-vaultbridge-mcp](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp). This task does not rename or republish the old npm package.
- The MCP server handshake now reports the package name/version. Tool names remain unchanged.

## Configuration mapping

| Legacy Local REST setup | Standalone filesystem setup |
| --- | --- |
| `OBSIDIAN_API_KEY` | Remove; set `VAULT_PATH` |
| `OBSIDIAN_BASE_URL` | Remove in filesystem mode |
| `OBSIDIAN_VERIFY_SSL` | Remove in filesystem mode |
| Obsidian and Local REST plugin running | Not required |
| No write scope | Optionally set `READ_ONLY`, `READ_PATHS`, `WRITE_PATHS` |

Minimal standalone configuration:

```text
VAULT_PATH=C:/Users/me/Documents/My Vault
```

## Mutation contract changes

- `obsidian_write_note` creates by default. Replacing an existing file requires `mode: "replace"` and `expected_revision`.
- Append, heading/frontmatter patches, Canvas updates, and file deletion require the revision returned by the latest read/stat call.
- A stale or missing revision returns `CONFLICT`.
- Folder moves and deletes use native filesystem operations and are no longer limited to Markdown-only trees.

## Runtime-only tools

`obsidian_get_active_file` and `obsidian_open_file` remain listed for compatibility, but return errors in filesystem mode because there is no running Obsidian UI. Only `obsidian_open_file` remains supported by the deprecated Local REST backend; active-file reads cannot be authorized before fetching their body.

## Temporary compatibility mode

Set `BACKEND=local-rest` and retain the old API settings to migrate incrementally. Local REST compatibility is deprecated; its removal schedule is undecided. It enforces READ_ONLY and lexical path scopes; canonical symlink and revision guarantees require the filesystem backend. Use only disposable, non-sensitive test data. Production/stable use remains blocked; see [RELEASING.md](./RELEASING.md).

Local REST now enforces `READ_ONLY`, read/write scopes and protected paths before
forwarding. Search and active-file reads return `UNSUPPORTED_CAPABILITY` because
the adapter cannot authorize them before remote note processing. Atomic moves,
recursive/folder deletion, create/replace modes, revision-checked writes and
occurrence-specific patches are also unsupported instead of silently ignoring
guarantees. Direct authorized reads, metadata, listing, open-file and legacy
writes without those options remain available. Remote filesystem canonicalization
is controlled by the Obsidian plugin; use the filesystem backend for canonical
symlink containment and the complete safety contract.

## Owner auth storage (AUTH-002)

This is an unreleased local identity foundation for AUTH-003, not a migration of
MCP clients to OAuth. Existing HTTP/STDIO behavior is unchanged. Better Auth
`1.7.13` owns user/account/session/verification/rateLimit tables and password
hashing; no custom crypto or OAuth implementation is introduced. The runtime is
still Node `^22.23.4 || ^24.22.1`. `node:sqlite` avoids native-addon builds; on Node
22 it is experimental (warning on stderr). Test the full OS/Node CI matrix before
release. The isolated AUTH-001 spike is unchanged.

### Location and permissions

`auth.sqlite`, its WAL/SHM sidecars, `session.key`, and transient `setup-token` live
in a **per-user application-data directory**, never in the configured vault:

- Windows: `%APPDATA%/ObsidianVaultBridge` (absolute APPDATA required).
- macOS: `~/Library/Application Support/ObsidianVaultBridge`.
- Linux: `$XDG_DATA_HOME/obsidian-vaultbridge-mcp`, or
  `~/.local/share/obsidian-vaultbridge-mcp` (absolute XDG_DATA_HOME required).

`--vault`/`VAULT_PATH` supplies the containment check. Real paths are compared
before creating anything; storage inside that vault, an ancestor of that vault,
or another recognizable `.obsidian` ancestor is rejected. Do not relocate storage
into any other unregistered vault or sync it. The service cannot discover every
vault on a machine. Authentication data is sensitive, including session tokens in
SQLite. It is not encrypted at rest; use OS disk encryption and protected backups.

New POSIX directories/files use 0700/0600. Existing broad permissions, foreign
ownership, symlinks and hardlinked credential/DB files fail startup rather than
being trusted. On Windows the directory and existing credential/DB files receive
an owner-only protected DACL through Windows PowerShell/.NET; new files inherit
it. Failure to set the DACL fails startup. Use local NTFS app data, not a network
share. Administrators/root or processes running as the same OS user remain trusted;
this service is not a sandbox against a compromised local account. Only one owner
service/recovery process may open the store at a time (proper-lockfile heartbeat).

### Schema lifecycle and backup

SQLite enables WAL, foreign keys, FULL synchronous writes and a 5-second busy
timeout. Provider migrations run through Better Auth's `runMigrations()` under the
exclusive process lock. Custom tables have separate forward-only migration records
in `vaultbridge_migration` (current version 1); provider tables are not hand-edited.
A newer custom schema is refused before provider migration. Owner enrollment and
recovery update the library-managed user/account records and the singleton owner
marker in one SQLite transaction, using Better Auth's password hasher/adapters.
Only loopback requests with a valid ten-minute token may enroll; token reuse and
parallel enrollment fail. Startup refuses orphan/unclaimed users instead of adopting
an arbitrary account. A missing key alongside an existing database fails closed.

**Before upgrading:** stop the owner process with SIGINT/SIGTERM and wait for exit.
Clean shutdown drains requests, checkpoints `wal_checkpoint(TRUNCATE)`, closes the
DB, removes any setup token and releases the lock. With no process holding the
store, copy the entire private app-data directory into a restricted backup
(exclude any transient setup token/lock directory). Keep **database and session key
from the same snapshot**. Never copy just an open WAL database: committed data may
still be in its sidecars. For live backups use a separately reviewed SQLite backup
procedure; none is provided by this PR. Securely delete obsolete backups.

**Rollback:** stop all owner services; move the failed upgrade store aside; restore
the entire pre-upgrade directory and its permissions, then run the previous pinned
binary. Do not decrement the migration version, delete columns, or restore a key
from a different snapshot. Provider migrations are library-managed and not assumed
to be reversible. Restoring a snapshot can resurrect old sessions; after rollback,
use local owner recovery to replace the password and revoke every session.

### First run, crash recovery, and sessions

`node dist/index.js owner-auth --vault /absolute/path` generates a 256-bit setup
token in the 0600 `setup-token` file (not logs). Read it locally and enter it into
the setup form, never a URL. A clean stop removes the file; a crash can leave a
**now unusable** token file and lock. Stop/verify the old process is gone, wait at
least the lock stale timeout, and remove only `setup-token` before restarting.
Do not delete `auth.sqlite` to recover a password. A stale file is never silently
overwritten. Tokens expire after ten minutes and are held as hashes in memory.

Forgotten password: stop the owner service, then run `owner-auth --recover-owner`
with the same vault/data location. Read the new protected token file and choose a
new password in `/login`. This changes only the existing owner's password, revokes
all sessions, and consumes the token atomically with respect to other requests.
No unauthenticated remote reset/signup/admin endpoint is mounted on the MCP listener.
If `session.key` is lost, restore the matching backup; generating an unrelated key
is not a supported recovery method.

Sessions are provider-generated opaque tokens in HttpOnly, SameSite=Strict cookies,
with an 8-hour lifetime and no client-side session cache. HTTPS origins use Secure
cookies. The shipped listener supports **only literal loopback HTTP**, so its cookies
have an explicit Secure exception; no network bind, TLS proxy or forwarded host is
accepted. Future remote HTTPS/OAuth deployment requires AUTH-003 and its separate
security tests. State changes require exact Origin + a custom non-simple CSRF header
+ JSON; strict Host/TCP-peer checks, fetch metadata, no CORS, no-store, CSP, frame
blocking and no URL redirects add defense in depth. Login JSON does not expose the
session token. Unknown accounts and wrong passwords share an error response.

### Limits / remaining gates

- AUTH-003: HTTP mode resolver/default OAuth, explicit none warnings/network gates,
  consent/PKCE/discovery/token integration and redirect validation for that flow.
- AUTH-004/005: request-scoped authorization and full client/token-to-tool/E2E/load
  tests. An owner cookie alone never authenticates `/mcp` in AUTH-002.
- Local same-user compromise, lack of at-rest DB encryption and single-process
  limits remain. Do not proxy the local owner port or use it on shared untrusted
  multi-user hosts. Backoff may delay legitimate local attempts from the same peer.
- Windows/macOS behavior must be confirmed by this PR's actual matrix; Linux
  verification alone is not cross-platform proof.
