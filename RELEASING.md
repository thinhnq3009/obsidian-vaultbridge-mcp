# Reviewed alpha releases only

The published `obsidian-vaultbridge-mcp@0.1.0-alpha.0` belongs to `thinhnq`
(email matches the repository owner); npm `alpha` and `latest` both pointed to
that version when checked on 2026-10-24. Registry metadata has the old GitHub URL
and no `gitHead`: the exact historical source revision is unverified. This source
prepares `0.1.0-alpha.1`, preserves the old CLI as an alias and reports identity
from package.json. It does not publish, move dist-tags, or claim a stable release.

Before a maintainer explicitly approves publication:

1. Use Node 22.23.4+ (22.x) or 24.22.1+ (24.x). Record `process.version`,
   `process.execPath`, platform and the runtime supplier in each deployed CLI,
   STDIO, HTTP and container/service launcher. Restart old processes after patching.
2. Require green CI on Ubuntu/macOS/Windows at both supported minimum versions,
   dependency audit and CodeQL. Inspect the exact reviewed commit and lock diff.
3. Run `npm ci`, `npm run build`, `npm run lint`, `npm test -- --maxWorkers=2`,
   `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=high`,
   `npm pack --dry-run`, and `npm run smoke:package`. Smoke tests pack/install the
   actual tarball into a disposable consumer and run both CLI names through npx
   with synthetic note/revision checks, isolated vault/cache/environment.
4. Review packed files (no .env/secrets/vaults/tests), package identity, alpha
   version/tag, executable shebang, module/types entrypoints and tarball integrity.
5. Verify HTTP has a trusted TLS proxy, private backend firewall, Host allowlist,
   token and no compressed ingress. Never treat a proxy as a substitute for a
   patched runtime. Verify Windows owner-only cache ACLs and private filesystem.
6. Resolve remaining source/data-format release blockers, including issue #4,
   and record the source-to-tarball provenance. Prefer npm trusted publishing with
   provenance; configure publisher trust interactively before enabling any future
   workflow. No workflow here receives a publishing token or runs npm publish.
7. After explicit owner approval, publish intentionally with the alpha tag,
   retain integrity/provenance and verify the installed registry artifact. Do not
   change latest/stable accidentally. Update the changelog and deployment records.

Security triage: high/critical dependency findings block CI. Review lower-level
findings and reachability before release; never add blanket audit exceptions.
An audit service/network failure is a failed verification, not a clean scan:
retry when service is restored and preserve the failed job output. CodeQL uses
security-extended JavaScript/TypeScript queries; review code-scanning alerts and
false positives with evidence. Repository secret scanning and push protection
were enabled when inspected; their availability is controlled by GitHub settings.
Dependabot alerts could not be inventoried with the current token (disabled /
missing admin:repo_hook scope); npm audit and committed update configuration
provide the repository-side checks. Enable alerts in repository settings when
maintainer permissions allow it. Never use pull_request_target with untrusted
code or expose release credentials to PR builds.

Rollback: stop the affected service and use STDIO with a patched Node runtime
while a reviewed fix is prepared. Do not roll back to a vulnerable runtime or
publish the old dependency lockfile as a mitigation. Cache snapshots may be
removed after stopping the process; vault content format is unchanged by this
security bundle. New Local REST capability errors are intentional: use the
filesystem adapter for atomic mutations, revision checks, search and symlink ACLs.
