import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerHtml, ownerScript } from "../src/auth/ui.js";

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); });

function page(state: { hasOwner: boolean; recovering: boolean }, loggedIn = false, grants: unknown[] = []) {
  dom = new JSDOM(ownerHtml, { url: "http://127.0.0.1:39146", runScripts: "outside-only" });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    await Promise.resolve();
    if (init?.method === "POST") return Response.json({ success: true });
    if (url === "/owner-state") return Response.json(state);
    if (url === "/oauth/grants") return loggedIn ? Response.json({ grants }) : new Response(null, { status: 401 });
    return loggedIn ? Response.json({ email: "<img src=x onerror=alert(1)>", expiresAt: "tomorrow" }) : new Response(null, { status: 401 });
  });
  Object.assign(dom.window, { fetch: fetcher });
  dom.window.eval(ownerScript);
  return { window: dom.window, document: dom.window.document, fetcher };
}
async function ready() {
  await vi.waitFor(() => expect(dom!.window.document.getElementById("status")!.textContent).toContain("Ready"));
}
function formData(document: Document, id: string, values: Record<string, string>) {
  const form = document.getElementById(id)! as HTMLFormElement;
  for (const [name, value] of Object.entries(values)) (form.elements.namedItem(name) as HTMLInputElement).value = value;
  return form;
}

describe("minimal owner UI behavior independent from HTTP", () => {
  it("renders client grants as text and revokes only via a same-origin CSRF-protected POST", async () => {
    const { document, fetcher } = page({ hasOwner: true, recovering: false }, true, [{
      grantId: "local-grant", clientId: "<img src=x onerror=alert(1)>", revoked: false,
      clientPermissions: [{ path: "Notes", actions: ["readNote"], tools: ["obsidian_read_note"] }],
    }]);
    await ready();
    await vi.waitFor(() => expect(document.getElementById("grant-list")!.textContent).toContain("<img"));
    expect(document.querySelector("img")).toBeNull();
    document.getElementById("grant-list")!.querySelector("button")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/oauth/grants/revoke", expect.objectContaining({
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" },
      body: JSON.stringify({ grantId: "local-grant" }),
    })));
  });
  it("shows first-run setup only and submits tokens/passwords in a same-origin POST, not URLs or storage", async () => {
    const { document, window, fetcher } = page({ hasOwner: false, recovering: false }); await ready();
    expect(document.getElementById("setup")!.hidden).toBe(false);
    expect(document.getElementById("login")!.hidden).toBe(true);
    const form = formData(document, "setup-form", { token: "one-time", email: "owner@example.test", password: "long-password-123" });
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/setup", expect.objectContaining({
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" },
      body: JSON.stringify({ token: "one-time", email: "owner@example.test", password: "long-password-123" }),
    })));
    await vi.waitFor(() => expect((form.elements.namedItem("password") as HTMLInputElement).value).toBe(""));
    expect(window.location.search).toBe(""); expect(window.localStorage.length).toBe(0);
  });

  it("shows recovery without email and submits only token and new password", async () => {
    const { document, window, fetcher } = page({ hasOwner: true, recovering: true }); await ready();
    expect(document.getElementById("setup-email")!.hidden).toBe(true);
    formData(document, "setup-form", { token: "recover", password: "new-password-123" }).dispatchEvent(new window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/setup", expect.objectContaining({ body: JSON.stringify({ token: "recover", password: "new-password-123" }) })));
  });

  it("renders account identity as text, allows logout and all-session revocation", async () => {
    const { document, fetcher } = page({ hasOwner: true, recovering: false }, true); await ready();
    expect(document.getElementById("account")!.hidden).toBe(false);
    expect(document.getElementById("login")!.hidden).toBe(true);
    expect(document.getElementById("identity")!.textContent).toContain("<img src=x");
    expect(document.querySelector("img")).toBeNull();
    document.getElementById("logout")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/auth/sign-out", expect.objectContaining({ method: "POST" })));
    document.getElementById("revoke")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/auth/revoke-sessions", expect.objectContaining({ method: "POST" })));
  });

  it("shows login and rate-limit feedback without rendering server error HTML", async () => {
    const { document, window, fetcher } = page({ hasOwner: true, recovering: false }); await ready();
    expect(document.getElementById("login")!.hidden).toBe(false);
    fetcher.mockResolvedValueOnce(new Response("<script>bad</script>", { status: 429, headers: { "Retry-After": "900" } }));
    formData(document, "login-form", { email: "owner@example.test", password: "wrong" }).dispatchEvent(new window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("status")!.textContent).toContain("900 seconds"));
    expect(document.getElementById("status")!.innerHTML).not.toContain("<script>");
  });
});
