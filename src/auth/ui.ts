export const ownerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VaultBridge Owner</title></head>
<body><main><h1>VaultBridge Owner</h1>
<p>Local owner identity only. This does not authorize MCP clients or grant vault access.</p>
<p id="status" role="status">Loading…</p>
<section id="oauth" hidden><h2>OAuth consent (experimental)</h2>
<p>OAuth remains subject to the unresolved grant-family revocation risk (#60). Permissions are the intersection of server policy, token scopes and the explicit grant below. No root or wildcard paths.</p>
<pre id="oauth-details"></pre>
<label>Allowed subtree (for example Notes; required) <input id="grant-path" autocomplete="off"></label>
<p>This preset permits only read note, metadata, list, stat and search. For other exact action/tool grants use the owner-only API described in the operator guide.</p>
<button id="oauth-accept">Approve read-only subtree and OAuth scopes</button><button id="oauth-deny">Deny</button></section>
<section id="setup" hidden><h2>Local owner recovery</h2><p>Read the one-time recovery token from the protected file shown by the CLI. It expires after ten minutes.</p>
<form id="setup-form"><label>Recovery token <input name="token" type="password" autocomplete="off" required maxlength="128"></label>
<label>New password (12–128 characters) <input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button>Save owner</button></form></section>
<section id="login" hidden><h2>Login</h2><form id="login-form"><label>Username or legacy email <input name="username" autocomplete="username" maxlength="254" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><button>Login</button></form></section>
<section id="account" hidden><h2>Account / admin</h2><p id="identity"></p><button id="logout">Logout</button><button id="revoke">Revoke all sessions</button>
<p id="rotation-warning" role="alert" hidden>Insecure public bootstrap password in use. Change it now. OAuth grants, consent, and MCP vault access are blocked until rotation.</p>
<form id="change-password-form"><h3>Change password</h3>
<label>Current password <input name="currentPassword" type="password" autocomplete="current-password" required></label>
<label>New strong password (12–128 characters) <input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
<button>Change password and sign out</button></form>
<p>Logout, all-session revocation and local owner recovery also disable this owner's OAuth vault grants. Explicit consent is required to grant access again.</p>
<section id="grants" hidden><h3>Local client grants</h3><p>Revocation blocks the next operation. It does not promise upstream refresh-family invalidation. Regranting a client may authorize its still-active tokens.</p><div id="grant-list"></div></section>
<p>Forgotten password? Stop this owner service, then run owner-auth --recover-owner locally. Recovery revokes every session. No public registration or email reset is available.</p></section>
</main><script src="/owner.js" defer></script></body></html>`;

export const ownerScript = `"use strict";
const byId = (id) => document.getElementById(id);
const status = (message) => { byId("status").textContent = message; };
async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Retry after " + (response.headers.get("Retry-After") || "60") + " seconds." : "Request rejected. Check credentials or password.");
  return response.json();
}
let oauthQuery = location.search.slice(1);
async function resumeOAuth() {
  if (!oauthQuery) return;
  if (location.pathname !== "/consent") {
    const result = await post("/oauth/authorize", { oauth_query: oauthQuery });
    const target = new URL(result.url, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/consent") throw new Error("Authorization rejected.");
    location.assign(target.href);
    return;
  }
  const preview = await post("/oauth/preview", { oauth_query: oauthQuery });
  byId("oauth-details").textContent = JSON.stringify(preview, null, 2);
  byId("oauth").hidden = false;
}
for (const [id, accept] of [["oauth-accept", true], ["oauth-deny", false]]) {
  byId(id).addEventListener("click", async () => {
    try {
      if (accept) {
        const path = byId("grant-path").value;
        const actions = ["readNote", "readNoteMetadata", "listFiles", "statPath", "search"];
        const tools = ["obsidian_read_note", "obsidian_read_note_metadata", "obsidian_list_files", "obsidian_stat_path", "obsidian_search", "obsidian_search_content_advanced"];
        await post("/oauth/grants", { oauth_query: oauthQuery, principalPermissions: [{ path, actions }], clientPermissions: [{ path, actions, tools }] });
      }
      const result = await post("/oauth/consent", { oauth_query: oauthQuery, accept });
      const target = new URL(result.url);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid callback.");
      // This callback comes only from the provider after signed-query validation.
      location.assign(target.href);
    } catch (error) { status(error.message); }
  });
}
async function refreshGrants() {
  const response = await fetch("/oauth/grants", { credentials: "same-origin" });
  if (!response.ok) { byId("grants").hidden = true; return; }
  const data = await response.json();
  byId("grants").hidden = false;
  byId("grant-list").replaceChildren();
  for (const grant of data.grants) {
    const row = document.createElement("p");
    const label = document.createElement("span");
    label.textContent = grant.clientId + " — " + (grant.revoked ? "revoked" : "active") + " — " + JSON.stringify(grant.clientPermissions);
    row.append(label);
    if (!grant.revoked) {
      const button = document.createElement("button");
      button.textContent = "Revoke grant";
      button.addEventListener("click", async () => {
        try { await post("/oauth/grants/revoke", { grantId: grant.grantId }); await refreshGrants(); } catch (error) { status(error.message); }
      });
      row.append(button);
    }
    byId("grant-list").append(row);
  }
}
async function refresh() {
  const state = await (await fetch("/owner-state")).json();
  byId("setup").hidden = !state.recovering;
  const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
  byId("account").hidden = !response.ok;
  byId("login").hidden = !state.hasOwner || response.ok;
  if (response.ok) {
    const account = await response.json();
    byId("identity").textContent = account.username + " — session expires " + account.expiresAt;
    byId("rotation-warning").hidden = !account.mustChangePassword;
  }
  status("Ready. Owner service is loopback-only.");
  if (response.ok) { if (byId("rotation-warning").hidden) { await refreshGrants(); await resumeOAuth(); } else byId("oauth").hidden = true; }
}
for (const [id, url] of [["setup-form", "/recover-owner"], ["login-form", "/api/auth/sign-in/email"]]) {
  byId(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try { await post(url, data); form.reset(); await refresh(); } catch (error) { status(error.message); }
  });
}
byId("change-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await post("/api/auth/change-password", Object.fromEntries(new FormData(form)));
    form.reset();
    await refresh();
    status("Password changed. All sessions and local grants revoked; sign in again.");
  } catch (error) { status(error.message); }
});
for (const [id, url] of [["logout", "/api/auth/sign-out"], ["revoke", "/api/auth/revoke-sessions"]]) {
  byId(id).addEventListener("click", async () => { try { await post(url, {}); await refresh(); } catch (error) { status(error.message); } });
}
refresh().catch(() => status("Owner service unavailable."));`;
