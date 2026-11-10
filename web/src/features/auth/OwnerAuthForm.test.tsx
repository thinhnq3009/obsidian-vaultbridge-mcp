// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { OwnerAuthForm } from "./OwnerAuthForm.js";

afterEach(() => { cleanup(); });

describe("real owner credential forms", () => {
  it("submits username/password in memory and keeps the password input controlled by the browser", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<OwnerAuthForm mode="login" busy={false} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Username"), "obsidian-admin");
    await user.type(screen.getByLabelText("Password"), "disposable-password");
    await user.click(screen.getByRole("button", { name: "Sign in securely" }));
    expect(onSubmit).toHaveBeenCalledWith({ username: "obsidian-admin", password: "disposable-password" });
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByText(/preview only/i)).not.toBeInTheDocument();
  });

  it("requires the actual local recovery token and the backend password policy", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<OwnerAuthForm mode="recover" busy={false} onSubmit={onSubmit} />);
    expect(screen.getByText(/protected local file/i)).toBeVisible();
    expect(screen.getByLabelText("One-time recovery token")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("One-time recovery token"), "one-time-token");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.click(screen.getByRole("button", { name: "Restore owner access" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("at least three character types");
    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), "A-new-owner-password-456!");
    await user.click(screen.getByRole("button", { name: "Restore owner access" }));
    expect(onSubmit).toHaveBeenCalledWith({ token: "one-time-token", password: "A-new-owner-password-456!" });
  });

  it("requires the current password for forced rotation and disables all controls while busy", () => {
    render(<OwnerAuthForm mode="rotate" busy onSubmit={vi.fn(() => Promise.resolve())} />);
    expect(screen.getByLabelText("Current password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Current password")).toBeDisabled();
    expect(screen.getByLabelText("New password")).toBeDisabled();
    expect(screen.getByRole("button", { name: /please wait/i })).toBeDisabled();
  });

  it("announces rate limits without displaying response bodies", () => {
    render(<OwnerAuthForm mode="login" busy={false} cooldownSeconds={15} error="Too many attempts. Wait." onSubmit={vi.fn(() => Promise.resolve())} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many attempts. Wait.");
    expect(screen.getByRole("status")).toHaveTextContent("Try again in 15 seconds.");
    expect(screen.getByRole("button", { name: "Sign in securely" })).toBeDisabled();
  });
});
