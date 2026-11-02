import { useId, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { VBButton, VBCard, VBDialog, VBInput, VBLabel, VBStatus } from "../../components/vb.js";
import { BrandMark, BrandName } from "../../components/Brand.js";

export const previewStates = ["default", "error", "rate-limited", "loading", "disabled", "expired"] as const;
export type PreviewState = typeof previewStates[number];

const messages = {
  error: "Sign-in unsuccessful. Check your credentials and try again.",
  "rate-limited": "Too many attempts. Try again after 60 seconds.",
  expired: "Your session has expired. Sign in again to continue.",
};

/** Visual reference only. Never calls an owner API, persists credentials or resumes OAuth. */
export function LoginForm({ state = "default" }: { state?: PreviewState }) {
  const id = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({ username: "", password: "" });
  const [submitted, setSubmitted] = useState(false);
  const blocked = state === "loading" || state === "disabled" || state === "rate-limited";
  const feedback = state === "error" || state === "rate-limited" || state === "expired" ? messages[state] : "";

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const form = event.currentTarget;
    const next = {
      username: usernameRef.current?.value.trim() ? "" : "Enter your username.",
      password: passwordRef.current?.value ? "" : "Enter your password.",
    };
    setErrors(next);
    setSubmitted(false);
    if (next.username) { usernameRef.current?.focus(); return; }
    if (next.password) { passwordRef.current?.focus(); return; }
    // Clear password-manager / typed values rather than retaining preview credentials.
    form.reset();
    setShowPassword(false);
    setSubmitted(true);
  }

  return (
    <VBCard glass aria-labelledby={`${id}-title`}>
      <div className="vb-form-brand">
        <BrandMark className="vb-login-mark" />
        <h1 id={`${id}-title`} className="vb-auth-title mt-2"><BrandName /></h1>
        <p className="vb-muted mt-1 text-lg">Welcome back</p>
      </div>
      <form className="mt-6" onSubmit={submit} noValidate aria-describedby={`${id}-preview`}>
        <div className="vb-form-fields">
          <div>
            <VBLabel htmlFor={`${id}-username`}>Username</VBLabel>
            <div className="relative">
              <UserRound className="vb-input-icon" size={18} aria-hidden="true" />
              <VBInput ref={usernameRef} id={`${id}-username`} name="username" autoComplete="username"
                placeholder="Your owner username" maxLength={254} required disabled={blocked} className="vb-field-with-icon"
                aria-invalid={Boolean(errors.username)} aria-describedby={errors.username ? `${id}-username-error` : undefined} />
            </div>
            {errors.username && <p id={`${id}-username-error`} className="vb-field-error">{errors.username}</p>}
          </div>
          <div>
            <VBLabel htmlFor={`${id}-password`}>Password</VBLabel>
            <div className="relative">
              <LockKeyhole className="vb-input-icon" size={18} aria-hidden="true" />
              <VBInput ref={passwordRef} id={`${id}-password`} name="password" type={showPassword ? "text" : "password"}
                autoComplete="current-password" placeholder="Enter your password" maxLength={128} required disabled={blocked}
                className="vb-password vb-field-with-icon" aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? `${id}-password-error` : undefined} />
              <VBButton variant="ghost" className="vb-password-toggle" disabled={blocked}
                aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}
                aria-controls={`${id}-password`} onClick={() => { setShowPassword(!showPassword); }}>
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </VBButton>
            </div>
            {errors.password && <p id={`${id}-password-error`} className="vb-field-error">{errors.password}</p>}
          </div>
        </div>
        {feedback && <VBStatus tone={state === "expired" ? "warning" : "danger"} className="mt-4">{feedback} (Preview)</VBStatus>}
        {submitted && <VBStatus className="mt-4">Preview only. No credentials were sent. Fields cleared.</VBStatus>}
        <VBButton type="submit" loading={state === "loading"} disabled={blocked} className="mt-6 w-full">
          {state === "loading" ? "Signing in… (preview)" : "Sign in securely"}
          {state !== "loading" && <ArrowRight size={18} aria-hidden="true" />}
        </VBButton>
        <p id={`${id}-preview`} className="vb-muted mt-3 text-center text-xs">Static preview only. Do not enter real credentials.</p>
      </form>
      <div className="vb-auth-footer mt-6">
        <div className="vb-divider">LOCAL OWNER ACCESS</div>
        <VBDialog title="Local owner recovery" description="Recovery is available only on the host running VaultBridge."
          trigger={<VBButton id="local-help" variant="ghost" className="vb-recovery">Need help accessing your vault?</VBButton>}>
          <p className="vb-muted text-sm">Stop the owner service, then run <code>owner-auth --recover-owner</code> locally.
            Follow the CLI instructions for the one-time recovery token. Recovery revokes all sessions.
            This preview cannot perform recovery or sign-in. There is no public registration or email reset.</p>
        </VBDialog>
        <p className="vb-security-note vb-muted flex items-center gap-3 text-xs">
          <ShieldCheck size={26} className="shrink-0" aria-hidden="true" />
          <span>Local-only owner portal.<br />Your vault remains on your device.</span>
        </p>
      </div>
    </VBCard>
  );
}
