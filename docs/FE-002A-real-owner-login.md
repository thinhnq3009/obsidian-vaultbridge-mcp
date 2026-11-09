# FE-002A — Real Owner Login

## Scope

The React owner app adds real same-origin login, one-time local recovery and
forced password rotation to the existing private owner listener. It does not
implement OAuth consent, mutate grants, add a dashboard endpoint or change the
OAuth provider/token lifecycle.

The rollout setting is `MCP_OWNER_UI_MODE=legacy|react`. It defaults to
`legacy`. In `react` mode only `/login` and `/recover` serve the built
`dist/owner-ui/owner.html`; `/consent`, `/admin` and the legacy `/owner.js`
remain available for compatibility. The mode affects the owner server on
`127.0.0.1:39146` only. The public MCP/OAuth listener remains `39145`.

## Security behavior

- The static server serves only the built owner entry and allowlisted generated
  assets. It rejects traversal/dotfiles, checks canonical paths after symlink
  resolution, returns `404` for unknown assets, and fails visibly with `503`
  when the selected React bundle is missing.
- Both UI modes use `Cache-Control: no-store` and CSP:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
  connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri
  'none'`.
- Browser writes use JSON, `credentials: same-origin`, and
  `X-VaultBridge-CSRF: 1`; the existing exact Origin, peer, Host and server-side
  session checks remain in place.
- React reads session state from `/api/auth/get-session`; a successful sign-in
  response alone is not trusted. Password inputs are cleared after success or
  failure, and no credential, session token, recovery token or signed query is
  put into Web Storage or logs.
- The raw `location.search.slice(1)` is passed as the `oauth_query` value
  without parsing or reserializing. After login/rotation it is sent to the
  existing owner authorization handler; only a validated same-origin
  `/consent` destination is followed. Consent itself remains legacy in this PR.
- Recovery remains CLI-gated and uses the backend's one-time token. Rotation
  uses the backend's 12–128 character / three-character-class policy and
  returns to login after the existing backend revokes sessions and grants.

Rollback is `MCP_OWNER_UI_MODE=legacy` followed by restarting the owner server.
No database, provider or grant migration is required.

## Validation

Executed on Linux with Node `24.22.1`:

- `npm ci`: pass; npm reports 10 moderate findings in the complete dependency
  tree. `npm audit --omit=dev`: 0 production vulnerabilities.
- `npm run lint`: pass on Node 22.23.4 and Node 24.22.1.
- `npm run build`: pass on Node 22.23.4 and Node 24.22.1; emits separate
  preview and private owner HTML entries.
- Full Vitest suite: pass on both Node versions; Node 24.22.1 reported 47 test
  files, 810 passed and 1 skipped. Focused owner HTTP/auth, configuration, API
  client and React-form suites also passed (5 files, 46 tests).
- `npm run verify:owner-ui`: pass against the built owner UI served by the real
  owner server on `127.0.0.1:39146`; checks bootstrap login, forced rotation,
  generic invalid-credential feedback, Retry-After cooldown, expired-session
  handling during rotation, previous-session rejection, exact signed-query
  continuity, logout, normal recovery gating, actual one-time recovery, strict
  CSP, local-only network requests, Axe WCAG 2.1 AA and no horizontal overflow
  at six viewports.
- `npm run smoke:package`: pass on Node 22.23.4 and Node 24.22.1. Installs a
  disposable packed package, verifies its private React entry/assets work from
  the installed tarball, and completes MCP round trips through both CLI names.
- `npm pack --dry-run --json`: pass on Node 24.22.1; 215 packed files include
  both `dist/owner-ui/owner.html` and the FE-001 preview entry.
- Browser screenshots and the machine-readable run report are in
  `docs/screenshots/fe-002a/`.

GitHub CI and independent security review remain separate checks before this
phase can be considered accepted.
