import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { LoginShell } from "./components/layouts/LoginShell.js";
import { VBButton, VBCard, VBStatus } from "./components/vb.js";
import { OwnerAuthForm } from "./features/auth/OwnerAuthForm.js";
import type { OwnerFormMode } from "./features/auth/OwnerAuthForm.js";
import { OwnerApiError, ownerRequest } from "./lib/ownerApi.js";
import "./styles/index.css";

type OwnerState = { hasOwner: boolean; recovering: boolean };
type OwnerSession = { username: string; mustChangePassword: boolean; expiresAt: string };
type Screen = OwnerFormMode | "boot" | "unavailable" | "setup-required" | "redirecting";

function navigate(path: string): void {
  window.history.pushState(null, "", `${path}${window.location.search}`);
}

function safeError(error: unknown, operation: "login" | "recovery" | "rotation"): { message: string; retryAfter?: number } {
  if (error instanceof OwnerApiError) {
    if (error.status === 400 && operation === "recovery") {
      return { message: "Recovery was rejected. Check the one-time token and password requirements." };
    }
    return {
      message: error.message,
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    };
  }
  return { message: error instanceof Error ? error.message : "The local owner service is unavailable." };
}

export function OwnerApp() {
  const [screen, setScreen] = useState<Screen>("boot");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  const continueAfterAuthentication = useCallback(async (signal?: AbortSignal) => {
    const oauthQuery = window.location.search.slice(1);
    if (!oauthQuery) {
      window.location.assign("/admin");
      return;
    }
    const result = await ownerRequest<{ url: string }>("/oauth/authorize", {
      method: "POST",
      body: { oauth_query: oauthQuery },
      ...(signal === undefined ? {} : { signal }),
    });
    const target = new URL(result.url, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname !== "/consent"
      || target.username || target.password || !["http:", "https:"].includes(target.protocol)) {
      throw new Error("The signed authorization continuation was rejected.");
    }
    // Navigate to the exact provider-returned value after validating its destination.
    window.location.assign(result.url);
  }, []);

  const loadSession = useCallback(async (signal?: AbortSignal) => {
    const state = await ownerRequest<OwnerState>("/owner-state", signal === undefined ? {} : { signal });
    if (state.recovering) {
      if (window.location.pathname !== "/recover") navigate("/recover");
      setScreen("recover");
      setError("");
      setNotice("");
      return;
    }
    if (!state.hasOwner) {
      setScreen("setup-required");
      setError("");
      setNotice("");
      return;
    }
    if (window.location.pathname === "/recover") navigate("/login");

    try {
      const session = await ownerRequest<OwnerSession>("/api/auth/get-session", signal === undefined ? {} : { signal });
      setError("");
      setNotice("");
      setScreen(session.mustChangePassword ? "rotate" : "redirecting");
      if (!session.mustChangePassword) await continueAfterAuthentication(signal);
    } catch (sessionError) {
      if (sessionError instanceof OwnerApiError && sessionError.status === 401) {
        setScreen("login");
        setError("");
        return;
      }
      throw sessionError;
    }
  }, [continueAfterAuthentication]);

  useEffect(() => {
    const controller = new AbortController();
    const onPopState = () => {
      setError("");
      setNotice("");
      void loadSession(controller.signal).catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setScreen("unavailable");
          setError(loadError instanceof Error ? loadError.message : "The local owner service is unavailable.");
        }
      });
    };
    window.addEventListener("popstate", onPopState);
    void loadSession(controller.signal).catch((loadError: unknown) => {
      if (!controller.signal.aborted) {
        setScreen("unavailable");
        setError(loadError instanceof Error ? loadError.message : "The local owner service is unavailable.");
      }
    });
    return () => {
      controller.abort();
      window.removeEventListener("popstate", onPopState);
    };
  }, [loadSession]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 250);
    return () => { window.clearInterval(timer); };
  }, [cooldownUntil]);

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  async function submit(values: Record<string, string>) {
    const submittedScreen = screen;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (screen === "login") {
        await ownerRequest("/api/auth/sign-in/email", {
          method: "POST",
          body: { username: values.username, password: values.password },
        });
        // A successful sign-in response alone is not treated as an authenticated session.
        const session = await ownerRequest<OwnerSession>("/api/auth/get-session");
        if (session.mustChangePassword) {
          setScreen("rotate");
          return;
        }
        setScreen("redirecting");
        await continueAfterAuthentication();
        return;
      }
      if (screen === "recover") {
        await ownerRequest("/recover-owner", {
          method: "POST",
          body: { token: values.token, password: values.password },
        });
        navigate("/login");
        setScreen("login");
        setNotice("Recovery completed. Sign in with your new password.");
        return;
      }
      if (screen === "rotate") {
        await ownerRequest("/api/auth/change-password", {
          method: "POST",
          body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
        });
        navigate("/login");
        setScreen("login");
        setNotice("Password changed. All existing sessions and owner grants were revoked. Sign in again.");
        return;
      }
    } catch (requestError) {
      if (submittedScreen === "login" || (submittedScreen === "rotate" && requestError instanceof OwnerApiError && requestError.status === 401)) {
        setScreen("login");
      }
      if (submittedScreen === "rotate" && requestError instanceof OwnerApiError && requestError.status === 401) {
        setError("Your owner session expired. Sign in again to continue.");
        throw requestError;
      }
      const result = safeError(requestError, submittedScreen === "recover" ? "recovery" : submittedScreen === "rotate" ? "rotation" : "login");
      setError(result.message);
      if (result.retryAfter) {
        const until = Date.now() + result.retryAfter * 1000;
        setCooldownUntil(until);
        setNow(Date.now());
      }
      throw requestError;
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginShell controls={null}>
      {screen === "boot" || screen === "redirecting" ? (
        <div className="vb-reference">
          <VBCard glass className="p-8 text-center">
            <LoaderCircle className="vb-spinner mx-auto" size={24} aria-hidden="true" />
            <p className="vb-muted mt-4" role="status">{screen === "boot" ? "Checking your local session…" : "Continuing securely…"}</p>
          </VBCard>
        </div>
      ) : screen === "unavailable" || screen === "setup-required" ? (
        <div className="vb-reference">
          <VBCard glass className="p-8">
            <AlertTriangle className="text-[var(--vb-warning)]" aria-hidden="true" />
            <h1 className="vb-auth-title mt-4">{screen === "setup-required" ? "Owner setup required" : "Owner service unavailable"}</h1>
            <VBStatus tone="warning" className="mt-4">
              {screen === "setup-required" ? "Start VaultBridge with OAuth owner setup enabled on this device before signing in." : error || "The local owner service could not be reached."}
            </VBStatus>
            <VBButton className="mt-5 w-full" onClick={() => { setScreen("boot"); void loadSession().catch((e: unknown) => { setScreen("unavailable"); setError(e instanceof Error ? e.message : "The local owner service is unavailable."); }); }}>
              Retry
            </VBButton>
          </VBCard>
        </div>
      ) : (
        <OwnerAuthForm mode={screen} busy={busy} cooldownSeconds={cooldownSeconds}
          error={error} notice={notice} onSubmit={submit} />
      )}
    </LoginShell>
  );
}
