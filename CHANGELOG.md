# Changelog

## 0.1.0-alpha.1 (unreleased)

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
