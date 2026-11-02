// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import "@testing-library/jest-dom/vitest";
import { App } from "./App.js";

afterEach(cleanup);

describe("preview state routing", () => {
  it("uses a safe default for unknown state/query parameters", () => {
    render(<MemoryRouter initialEntries={["/?state=unknown&oauth_query=ignored"]}><App /></MemoryRouter>);
    expect(screen.getByLabelText("Preview state")).toHaveValue("default");
    expect(screen.getByRole("button", { name: "Sign in securely" })).toBeEnabled();
  });
  it("offers reproducible states without carrying credential data into URLs", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={["/?state=error"]}><App /></MemoryRouter>);
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in unsuccessful.");
    await user.selectOptions(screen.getByLabelText("Preview state"), "loading");
    expect(screen.getByRole("button", { name: /Signing in/u })).toBeDisabled();
  });
});
