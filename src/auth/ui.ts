export const ownerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VaultBridge Owner</title></head>
<body><main><h1>VaultBridge Owner</h1>
<p>Local owner identity only. This does not authorize MCP clients or grant vault access.</p>
<p id="status" role="status">Loading…</p>
<section id="oauth" hidden><h2>OAuth consent (experimental)</h2>
<p>OAuth remains subject to the unresolved grant-family revocation risk (#60). Authorization does not grant vault access without a separate owner-managed vault grant.</p>
<pre id="oauth-details"></pre><button id="oauth-accept">Approve OAuth scopes</button><button id="oauth-deny">Deny</button></section>
<section id="setup" hidden><h2 id="setup-title">First-run setup</h2><p>Read the one-time token from the protected setup-token file shown by the CLI. It expires after ten minutes.</p>
<form id="setup-form"><label>Setup token <input name="token" type="password" autocomplete="off" required maxlength="128"></label>
<label id="setup-email">Email <input name="email" type="email" autocomplete="username" maxlength="254"></label>
<label>New password (12–128 characters) <input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button>Save owner</button></form></section>
<section id="login" hidden><h2>Login</h2><form id="login-form"><label>Email <input name="email" type="email" autocomplete="username" maxlength="254" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><button>Login</button></form></section>
<section id="account" hidden><h2>Account / admin</h2><p id="identity"></p><button id="logout">Logout</button><button id="revoke">Revoke all sessions</button>
<p>Forgotten password? Stop this owner service, then run owner-auth --recover-owner locally. Recovery revokes every session. No public registration or email reset is available.</p></section>
</main><script src="/owner.js" defer></script></body></html>`;

export const ownerScript = `"use strict";
const byId = (id) => document.getElementById(id);
const status = (message) => { byId("status").textContent = message; };
async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Retry after " + (response.headers.get("Retry-After") || "60") + " seconds." : "Request rejected. Check credentials or setup token.");
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
      const result = await post("/oauth/consent", { oauth_query: oauthQuery, accept });
      const target = new URL(result.url);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid callback.");
      // This callback comes only from the provider after signed-query validation.
      location.assign(target.href);
    } catch (error) { status(error.message); }
  });
}
async function refresh() {
  const state = await (await fetch("/owner-state")).json();
  byId("setup").hidden = state.hasOwner && !state.recovering;
  byId("setup-title").textContent = state.recovering ? "Local owner recovery" : "First-run setup";
  byId("setup-email").hidden = state.recovering;
  const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
  byId("account").hidden = !response.ok;
  byId("login").hidden = !state.hasOwner || response.ok;
  if (response.ok) { const account = await response.json(); byId("identity").textContent = account.email + " — session expires " + account.expiresAt; }
  status("Ready. Owner service is loopback-only.");
  if (response.ok) await resumeOAuth();
}
for (const [id, url] of [["setup-form", "/setup"], ["login-form", "/api/auth/sign-in/email"]]) {
  byId(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (id === "setup-form" && byId("setup-email").hidden) delete data.email;
    try { await post(url, data); form.reset(); await refresh(); } catch (error) { status(error.message); }
  });
}
for (const [id, url] of [["logout", "/api/auth/sign-out"], ["revoke", "/api/auth/revoke-sessions"]]) {
  byId(id).addEventListener("click", async () => { try { await post(url, {}); await refresh(); } catch (error) { status(error.message); } });
}
refresh().catch(() => status("Owner service unavailable."));`;
