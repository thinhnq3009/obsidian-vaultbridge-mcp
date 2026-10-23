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

`obsidian_get_active_file` and `obsidian_open_file` remain listed for compatibility, but return errors in filesystem mode because there is no running Obsidian UI. Use them only with the deprecated Local REST backend.

## Temporary compatibility mode

Set `BACKEND=local-rest` and retain the old API settings to migrate incrementally. Local REST compatibility is deprecated; its removal schedule is undecided. It does not enforce filesystem safety guarantees (READ_ONLY/path scope/revision policy is still incomplete). Use only disposable, non-sensitive test data. Production/stable use remains blocked; see [RELEASING.md](./RELEASING.md).
