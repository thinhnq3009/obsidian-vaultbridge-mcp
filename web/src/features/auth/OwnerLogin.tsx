import { useEffect, useState } from "react";
import { LoginShell } from "../../components/layouts/LoginShell.js";
import { LoginForm } from "./LoginForm.js";
import type { PreviewState } from "./LoginForm.js";

type Session = { mustChangePassword: boolean };

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" },
    body: JSON.stringify(body),
  });
}

// Never interpret query parameters as a destination. Only the owner provider can
// return the signed consent URL; credentials never enter a URL or storage.
async function continueSession(session: Session): Promise<void> {
  const query = location.search.slice(1);
  if (query && !session.mustChangePassword) {
    const response = await post("/oauth/authorize", { oauth_query: query });
    if (!response.ok) throw new Error("Authorization rejected. Restart authorization from your MCP client.");
    const result = await response.json() as { url: string };
    const target = new URL(result.url, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/consent") throw new Error("Authorization rejected.");
    location.replace(target.href);
  } else {
    // Preserve OAuth query through mandatory password rotation and the existing
    // admin/recovery flow. Login cookies are not MCP credentials.
    location.replace(`/admin${location.search}`);
  }
}

export function OwnerLogin() {
  const [state, setState] = useState<PreviewState>("disabled");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let active = true;
    async function initialize() {
      const ownerResponse = await fetch("/owner-state", { credentials: "same-origin" });
      if (!ownerResponse.ok) throw new Error("Owner service unavailable. Reload to retry.");
      const owner = await ownerResponse.json() as { recovering: boolean };
      if (!active) return;
      if (owner.recovering) { location.replace(`/admin${location.search}`); return; }
      const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
      if (!active) return;
      if (response.ok) await continueSession(await response.json() as Session);
      else if (response.status === 401) setState("default");
      else throw new Error("Owner service unavailable. Reload to retry.");
    }
    void initialize().catch(() => {
      if (active) { setState("disabled"); setFeedback("Owner service unavailable. Reload to retry."); }
    });
    return () => { active = false; };
  }, []);

  async function signIn(credentials: { username: string; password: string }) {
    setState("loading");
    setFeedback("");
    try {
      const response = await post("/api/auth/sign-in/email", credentials);
      if (!response.ok) {
        setState("error");
        setFeedback(response.status === 429
          ? `Too many attempts. Retry after ${response.headers.get("Retry-After") ?? "60"} seconds.`
          : "Sign-in unsuccessful. Check your credentials and try again.");
        return;
      }
      const session = await fetch("/api/auth/get-session", { credentials: "same-origin" });
      if (!session.ok) throw new Error("Session unavailable");
      await continueSession(await session.json() as Session);
    } catch {
      setState("error");
      setFeedback("Sign-in could not complete. Reload or restart authorization from your MCP client.");
    }
  }

  return <LoginShell><div className="vb-reference">
    <LoginForm state={state} feedback={feedback} onSignIn={(credentials) => { void signIn(credentials); }} />
  </div></LoginShell>;
}
