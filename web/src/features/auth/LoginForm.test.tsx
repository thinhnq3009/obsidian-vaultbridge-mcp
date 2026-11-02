// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { LoginForm } from "./LoginForm.js";
import { VBButton, VBCard, VBStatus } from "../../components/vb.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("golden login reference (never authenticates)", () => {
  it("labels password-manager fields, validates and focuses the first missing field", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: "Sign in securely" }));
    expect(username).toHaveFocus();
    expect(username).toHaveAccessibleDescription("Enter your username.");
    expect(username).toHaveAttribute("aria-invalid", "true");
    await user.type(username, "preview-owner");
    await user.click(screen.getByRole("button", { name: "Sign in securely" }));
    expect(password).toHaveFocus();
    expect(password).toHaveAccessibleDescription("Enter your password.");
  });

  it("toggles visibility accessibly and never submits or persists credentials even with Enter", async () => {
    const fetch = vi.fn();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText("Username"), "preview-owner");
    await user.type(screen.getByLabelText("Password"), "not-a-real-password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByLabelText("Password"));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("No credentials were sent");
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it.each(["loading", "disabled", "rate-limited"] as const)("disables every credential control in %s preview", (state) => {
    render(<LoginForm state={state} />);
    expect(screen.getByLabelText("Username")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show password" })).toBeDisabled();
    const submit = screen.getByRole("button", { name: /Sign(?:ing)? in/u });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", String(state === "loading"));
  });

  it.each([
    ["error", "Sign-in unsuccessful."],
    ["rate-limited", "Try again after 60 seconds."],
    ["expired", "Your session has expired."],
  ] as const)("announces the %s state without implying a real request", (state, text) => {
    render(<LoginForm state={state} />);
    expect(screen.getByRole(state === "expired" ? "status" : "alert")).toHaveTextContent(text);
    expect(screen.getByText(/Static preview only/u)).toBeVisible();
  });

  it("opens recovery guidance in a labelled dialog and restores trigger focus after Escape", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    const trigger = screen.getByRole("button", { name: "Need help accessing your vault?" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Local owner recovery" })).toBeVisible();
    expect(screen.getByText("owner-auth --recover-owner")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("shared Crystal wrappers", () => {
  it("keeps variants and status semantics centralized", () => {
    render(<VBCard><VBButton variant="secondary">Cancel</VBButton><VBButton variant="destructive">Revoke</VBButton>
      <VBButton loading>Working</VBButton><VBStatus tone="success">Complete</VBStatus><VBStatus tone="warning">Warning</VBStatus>
      <VBStatus tone="danger">Rejected</VBStatus></VBCard>);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("vb-button-secondary");
    expect(screen.getByRole("button", { name: "Revoke" })).toHaveClass("vb-button-destructive");
    expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Rejected");
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });
});
