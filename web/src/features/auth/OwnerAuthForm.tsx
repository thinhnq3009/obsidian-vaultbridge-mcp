import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { VBButton, VBCard, VBInput, VBLabel, VBStatus } from "../../components/vb.js";
import { BrandMark, BrandName } from "../../components/Brand.js";

export type OwnerFormMode = "login" | "recover" | "rotate";

type OwnerAuthFormProps = {
  mode: OwnerFormMode;
  busy: boolean;
  cooldownSeconds?: number;
  error?: string;
  notice?: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
};

const headings: Record<OwnerFormMode, { title: string; description: string; submit: string }> = {
  login: { title: "Welcome back", description: "Sign in to your local owner portal.", submit: "Sign in securely" },
  recover: { title: "Local recovery", description: "Recovery is available only from this device.", submit: "Restore owner access" },
  rotate: { title: "Update your password", description: "Choose a strong password before continuing.", submit: "Change password" },
};

function meetsOwnerPasswordPolicy(password: string): boolean {
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^a-zA-Z0-9]/u];
  return password.length >= 12 && password.length <= 128
    && password !== "admin39145" && classes.filter((pattern) => pattern.test(password)).length >= 3;
}

export function OwnerAuthForm({ mode, busy, cooldownSeconds = 0, error, notice, onSubmit }: OwnerAuthFormProps) {
  const id = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState("");
  const blocked = busy || cooldownSeconds > 0;
  const copy = headings[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const form = event.currentTarget;
    const values: Record<string, string> = {};
    for (const [key, value] of new FormData(form).entries()) {
      if (typeof value === "string") values[key] = value;
    }
    if (mode === "rotate" && !meetsOwnerPasswordPolicy(values.newPassword ?? "")) {
      setValidationError("Use 12–128 characters and at least three character types.");
      return;
    }
    if (mode === "recover" && !meetsOwnerPasswordPolicy(values.password ?? "")) {
      setValidationError("Use 12–128 characters and at least three character types.");
      return;
    }
    setValidationError("");
    try {
      await onSubmit(values);
      form.reset();
      setShowPassword(false);
    } catch {
      form.reset();
      setShowPassword(false);
    }
  }

  const passwordName = mode === "rotate" ? "newPassword" : "password";
  const passwordLabel = mode === "recover" ? "New password" : "Password";

  return (
    <div className="vb-reference">
      <VBCard glass aria-labelledby={`${id}-title`}>
        <div className="vb-form-brand">
          <BrandMark className="vb-login-mark" />
          <h1 id={`${id}-title`} className="vb-auth-title mt-2"><BrandName /></h1>
          <p className="vb-muted mt-1 text-lg">{copy.title}</p>
          <p className="vb-muted mt-2 text-sm">{copy.description}</p>
        </div>
        {mode === "recover" && (
          <VBStatus className="mt-5">
            Stop the owner service, restart it with <code>--recover-owner</code>, then use the one-time token from its protected local file.
            Tokens expire after 10 minutes. Recovery is not available by email or over the internet.
          </VBStatus>
        )}
        {mode === "rotate" && (
          <VBStatus tone="warning" className="mt-5">
            Your current session is restricted until this password change succeeds. You will need to sign in again afterward.
          </VBStatus>
        )}
        <form className="mt-6" onSubmit={(event) => { void submit(event); }} noValidate>
          <div className="vb-form-fields">
            {mode === "login" && (
              <div>
                <VBLabel htmlFor={`${id}-username`}>Username</VBLabel>
                <div className="relative">
                  <UserRound className="vb-input-icon" size={18} aria-hidden="true" />
                  <VBInput id={`${id}-username`} name="username" autoComplete="username" maxLength={254}
                    required disabled={blocked} className="vb-field-with-icon" aria-describedby={error ? `${id}-error` : undefined} />
                </div>
              </div>
            )}
            {mode === "recover" && (
              <div>
                <VBLabel htmlFor={`${id}-token`}>One-time recovery token</VBLabel>
                <VBInput id={`${id}-token`} name="token" type="password" autoComplete="off" maxLength={128} required disabled={blocked} />
              </div>
            )}
            {mode === "rotate" && (
              <div>
                <VBLabel htmlFor={`${id}-current`}>Current password</VBLabel>
                <VBInput id={`${id}-current`} name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required disabled={blocked} />
              </div>
            )}
            <div>
              <VBLabel htmlFor={`${id}-password`}>{mode === "rotate" ? "New password" : passwordLabel}</VBLabel>
              <div className="relative">
                <LockKeyhole className="vb-input-icon" size={18} aria-hidden="true" />
                <VBInput id={`${id}-password`} name={passwordName}
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  minLength={mode === "login" ? undefined : 12} maxLength={128} required disabled={blocked}
                  className="vb-password vb-field-with-icon"
                  aria-describedby={validationError ? `${id}-validation` : error ? `${id}-error` : undefined} />
                <VBButton variant="ghost" className="vb-password-toggle" disabled={blocked}
                  aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}
                  aria-controls={`${id}-password`} onClick={() => { setShowPassword((value) => !value); }}>
                  {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </VBButton>
              </div>
            </div>
          </div>
          {error && <VBStatus tone="danger" className="mt-4" id={`${id}-error`}>{error}</VBStatus>}
          {notice && <VBStatus tone="success" className="mt-4">{notice}</VBStatus>}
          {validationError && <p id={`${id}-validation`} className="vb-field-error" role="alert">{validationError}</p>}
          {cooldownSeconds > 0 && <VBStatus tone="warning" className="mt-4">Try again in {cooldownSeconds} seconds.</VBStatus>}
          <VBButton type="submit" loading={busy} disabled={blocked} className="mt-6 w-full">
            {busy ? "Please wait…" : copy.submit}
            {!busy && <ArrowRight size={18} aria-hidden="true" />}
          </VBButton>
        </form>
        {mode === "login" && (
          <div className="vb-auth-footer mt-6">
            <div className="vb-divider">LOCAL OWNER ACCESS</div>
            <button type="button" className="vb-button vb-button-ghost vb-recovery"
              onClick={() => { window.location.assign(`/recover${window.location.search}`); }}>
              Need help accessing your vault?
            </button>
            <p className="vb-security-note vb-muted flex items-center gap-3 text-xs">
              <ShieldCheck size={26} className="shrink-0" aria-hidden="true" />
              <span>Local-only owner portal.<br />Your vault remains on your device.</span>
            </p>
          </div>
        )}
      </VBCard>
    </div>
  );
}
