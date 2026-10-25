# Changelog

## 0.1.0 (unreleased — public release candidate)

- First installable public release candidate: npm CLI and MCP STDIO integration for Codex, Cursor and Claude Desktop, with a local filesystem backend that does not require an Obsidian process or Local REST plugin.
- Notes, frontmatter/metadata, search, Canvas, path policies, read-only mode, safe atomic writes and revision-conflict checks are included; unsupported active-file/open-file operations in standalone mode remain documented.
- Requires patched Node.js 22.23.4+ (22.x) or 24.22.1+ (24.x); full multi-platform CI, packed-tarball smoke and dependency audits are release gates.
- Package publication is intended for npm `latest` only after all release/security acceptance criteria in #38 are satisfied; repository changes alone do not publish or certify this version.
- Embedded OAuth, local SQLite identity and login/consent UI are deferred to v0.2.0 (#39); existing HTTP Bearer auth is not advertised as OAuth.

### Historical, unpublished alpha.1 preparation
## 0.1.0-alpha.1 (prepared, not published)

- Align package, repository links, client examples and MCP handshake with `obsidian-vaultbridge-mcp`; retain the old executable as an explicit compatibility alias.
- Keep the release on the alpha line and default publication to the `alpha` tag. The previous source `1.0.0` declaration did not establish a stable VaultBridge release.
- Expose real test/CI evidence, clean stale build output before packing, and smoke-test the installed tarball through npx on patched Node 22/24 in CI.
- Refresh dependency resolutions, raise the SDK/Vitest/tsx minimum versions, and require a production audit before publication.
- Require Node 22.23.4+ (22.x) or 24.22.1+ (24.x), with a startup runtime check; retire Node 20 support.
- Record alpha.0 artifact/source evidence and outstanding release safety gates in RELEASING.md.
- Include the metadata, lossless YAML comparison, agent timestamps, section reads, atomic multi-edit, vault/search boundary and search consistency fixes merged since the alpha.0 source baseline. These changes do not establish production safety; known limitations remain documented.

## 0.1.0-alpha.0 (published)

- First VaultBridge preview under the new npm name, based on the older standalone implementation. Exact publisher source/provenance is unavailable; see RELEASING.md.

## Historical standalone work (previously labeled 1.0.0 in source)

- Added standalone filesystem backend; Obsidian and Local REST are no longer prerequisites.
- Added atomic writes, cross-process locks, path/symlink containment, read-only mode, path scopes, and revision conflicts.
- Added Markdown AST metadata/heading handling and YAML document frontmatter updates.
- Added incremental MiniSearch indexing, watcher updates, health/status, index rebuild, and folder creation tools.
- Made active-file and open-file tools conditional on runtime backend capabilities.
- Kept the Local REST backend as a deprecated 1.x migration adapter.
- Added Windows, macOS, and Linux CI plus standalone integration tests.
