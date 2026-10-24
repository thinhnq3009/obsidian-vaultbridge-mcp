# Prerelease preparation and evidence — issue #5

This repository prepares `obsidian-vaultbridge-mcp@0.1.0-alpha.1`; it has not
published that version. Only a reviewed prerelease on a green CI revision may be
published intentionally. Publication, merging, changing registry tags and a stable
release are not performed by this task. Use disposable, non-sensitive vaults.

## Published alpha provenance (verified 2026-10-24)

Registry query:

```sh
npm view obsidian-vaultbridge-mcp version dist-tags gitHead repository homepage bugs time dist --json
npm pack obsidian-vaultbridge-mcp@0.1.0-alpha.0 --json --pack-destination /path/to/evidence
```

- Version: `0.1.0-alpha.0`, published `2026-09-29T07:31:33.221Z`.
- Both `alpha` and `latest` point to that version. No registry changes were made.
- Tarball: <https://registry.npmjs.org/obsidian-vaultbridge-mcp/-/obsidian-vaultbridge-mcp-0.1.0-alpha.0.tgz>.
- SHA-1: `5740fcea205e5a5a65515165a9d8731126f7e243`.
- Integrity: `sha512-FM0RpS9d4P61kNoTpY2siYr6k/y8C4+mZ1arIeDtInNZhHt1BZ6SvGjwQiuXwmNtsfF5TiP1P6tCVEYn9KM57A==`.
- Downloaded pack: 144 entries, 76,820 compressed bytes, 397,110 unpacked bytes;
  its checksum matches registry metadata.
- Registry has no `gitHead` or `dist.attestations`. A registry integrity signature
  establishes artifact identity; it does not establish the publisher's source SHA.
- Packaged PROJECT_REVIEW.md says it reviewed local HEAD `1edecc0`, which resolves
  to `1edecc07dfd2e45d1a2ac685faff6f8534f1b3e0` in this repository.

Rebuilding an archive of that commit using `npm ci` from its lockfile and
`npm run build` on Linux/Node 24.22.1 reproduces **137 of 138 dist files byte for
byte**, including declarations and source maps. The only differing file is
`dist/server.js`: the published file replaces the server identity
`obsidian-vault-mcp` / `1.0.0` with `obsidian-vaultbridge-mcp` / `0.1.0-alpha.0`.
The published package also changes package metadata/README, adds PROJECT_REVIEW.md,
and omits scripts/devDependencies. Therefore **1edecc0 is a strongly supported
implementation baseline, not a verified exact publisher revision**. Exact source
attestation for alpha.0 remains unavailable; do not claim it was built from current
main. Publisher build records would be needed to close that historical gap.

Before this change, `npm pack` on main
`3c296b83f842831d680c386231d7350f09b3e405` produced
`obsidian-local-rest-mcp@1.0.0`: 155 entries, 88,608 compressed bytes, 453,734
unpacked bytes, SHA-1 `7c19c1cc587ded1a8eb78b10b85926fe02c96a0a`. That artifact
was not published. Main includes later metadata, YAML, timestamp, section-read,
atomic-edit, vault-boundary and search-consistency work absent from alpha.0.

To repeat the historical comparison, archive `1edecc0` into a temporary directory,
install its lockfile, build, and compare its `dist/` with the extracted registry
tarball. Keep the registry manifest/README unchanged when preserving evidence;
do not reconstruct provenance by silently relabeling current main.

## Test discoverability investigation

The [npm.io page](https://npm.io/package/obsidian-vaultbridge-mcp) still displays
alpha.0, B 65/100, README present, tests absent and no stable release at inspection.
Its GitHub/homepage links still use the legacy repository URL. This is a snapshot
of a third-party index, not evidence that current GitHub has no tests.

The registry tarball's package.json has **no scripts or devDependencies**, whereas
the source has a real `npm test` command, Vitest suites and a six-job CI matrix.
The tarball contains no tests, intentionally. The public package page supplies no
recognition algorithm, and a public search did not establish one. Missing published
test metadata is a possible explanation, **not a verified cause** of the indicator.
No metadata field or tarball test inclusion has been invented to influence it.

The new package retains its actual scripts, README links to the source tests and
CI, and CI exercises the installed package. Re-check the page after an intentional
publish and indexing delay; record version and observation date. No score change
or index refresh time is promised.

## Safety gates

| Item | Current evidence and gate |
| --- | --- |
| K03: search read scopes / symlinks | Fixed on main by PR #21; `test/securityBoundaries.test.ts` and search tests cover both modes and scope/cache changes. |
| K04: search freshness | Fixed on main by PR #22; `test/searchConsistency.test.ts` covers committed mutations, watcher ordering and failures. External edits with watchers off still require rebuild. |
| #4: YAML integer precision | Closed with lossless comparison; `test/agentEditTimestamp.test.ts` covers adjacent unsafe integers, no-op controls, integral floats and key collisions (#8/#9). |
| K06: Local REST enforcement | Implemented in this security branch (#17): read-only/scopes enforced before forwarding; remote search/active-file and atomic/revision promises fail closed. Canonical symlink checks require filesystem mode. |
| Other known safety work | #16 merged through PR #24. This branch implements #14, #18, #19 and #20 plus source/runtime remediation for #23. Deployment inventories, Windows ACL checks, green CI/review and owner approval are release gates. |
| Dependency advisories | Baseline production audit found 8 affected packages (1 critical, 3 high, 3 moderate, 1 low). Resolutions are refreshed within existing semver ranges; the SDK minimum is raised to 1.32.0; Vitest/coverage to 4.1.12 and tsx to 4.23.15 resolve the tooling advisories. Audit the reviewed lockfile and installed artifact before publishing. Audit success is not an exploitability or overall safety guarantee. |

The README scopes its controls to filesystem mode. An alpha is for disposable
pilot data; a production-safe or stable claim requires closing the above gates,
reviewing all safety evidence and an explicit owner decision. Do not increase a
version to improve a third-party score.

## Package verification

```sh
npm ci
npm run build
npm test
npm run lint
npm pack --dry-run
npm audit --omit=dev --audit-level=high
npm run smoke:package
```

`smoke:package` runs `npm pack` (with a fresh build), checks its file allowlist,
installs the actual tarball and production dependencies into an independent
temporary consumer, and invokes its two installed executable names through npx.
It verifies the shebang/executable bit, package links, README, declarations and
export paths, dependency resolution and production audit, package/server identity and a real MCP
initialize/list-tools/create/read/replace/stale-revision round trip. It uses an
explicit disposable vault/cache and removes its temporary files. It does not test
an exported library API; this package's root is a CLI entrypoint.

CI runs these checks on Ubuntu/macOS/Windows × Node 22.23.4/24.22.1. Local results do not
prove all six jobs passed; inspect checks on the exact reviewed commit. The build
cleans dist first to avoid publishing deleted/stale modules. Internal tests,
source, node_modules, credentials and coverage are not package payloads.

The package provides the deprecated `obsidian-local-rest-mcp` executable alias;
`npx obsidian-local-rest-mcp` still downloads the separate old registry package.
Use the new package spec in all client configurations. See MIGRATION.md.

## Intentional manual publication (owner, after review and green CI)

1. Use a clean checkout of the reviewed commit. Confirm the candidate version is
   unused in the registry and keep it a prerelease. Record `git rev-parse HEAD`,
   Node/npm versions and the CI run URL. Run the verification commands above.
2. Run `npm pack --json --pack-destination /path/to/evidence` twice; compare the
   integrity values. Preserve the pack manifests, tarball and SHA with the release
   evidence. The tarball smoke uses the same packaging path. No generated files
   should differ from the reviewed source.
3. Publish deliberately from that clean source checkout using
   `npm publish --tag alpha --provenance` in a supported CI/provenance environment.
   There is no automatic publish workflow in this repository. Configure supported
   OIDC/trusted publishing separately; do not silently drop provenance if it is
   unavailable. If the supported path is unavailable, stop publication and record
   the missing requirement. Do not use `latest`. `publishConfig.tag=alpha` is the
   default, and prepublishOnly runs lint, tests, tarball smoke and the production
   audit. npm builds again through prepack.
4. Record `npm view obsidian-vaultbridge-mcp@0.1.0-alpha.1 gitHead dist --json`
   and `npm view obsidian-vaultbridge-mcp dist-tags --json`. Verify source SHA,
   tarball integrity, provenance subject/build source and that alpha points to the
   intended version. The existing latest tag is left unchanged by this procedure;
   changing it requires a separate intentional decision.
5. On Node 22.23.4 and 24.22.1, run
   `npm run smoke:package -- obsidian-vaultbridge-mcp@0.1.0-alpha.1` and
   `npm run smoke:package -- obsidian-vaultbridge-mcp@alpha`. These check the actual
   registry installation through npx against disposable vaults. Preserve evidence.
6. After npm.io updates, compare its indexed version, links and test indicator.
   Update the issue/task with observed outcomes, not a promised health score.

The published-artifact checks for alpha.1, remote CI review, publisher provenance
and npm.io refresh remain pending until the owner intentionally performs release.


## Security bundle release gate — issues #14, #17–#20 and #23


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
6. Review the source/data-format release gates above,
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
