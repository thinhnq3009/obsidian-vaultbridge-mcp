// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerApiError, ownerRequest } from "./ownerApi.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("owner API client", () => {
  it("uses same-origin cookies, no-store reads and JSON+CSRF writes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ recovering: false }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await ownerRequest("/owner-state");
    await ownerRequest("/api/auth/sign-in/email", { method: "POST", body: { username: "owner", password: "secret" } });
    expect(fetch).toHaveBeenNthCalledWith(1, "/owner-state", expect.objectContaining({
      credentials: "same-origin", cache: "no-store", method: "GET",
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/auth/sign-in/email", expect.objectContaining({
      credentials: "same-origin", cache: "no-store", method: "POST",
      headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" },
      body: JSON.stringify({ username: "owner", password: "secret" }),
    }));
  });

  it("maps status and Retry-After without exposing server response content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<script>secret</script>", { status: 429, headers: { "Retry-After": "12" } }),
    ));
    await expect(ownerRequest("/api/auth/sign-in/email", { method: "POST", body: {} }))
      .rejects.toMatchObject({ status: 429, retryAfter: 12, message: "Too many attempts. Wait for the cooldown before retrying." });
    try {
      await ownerRequest("/api/auth/sign-in/email");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerApiError);
      expect((error as Error).message).not.toContain("<script>");
    }
  });

  it("rejects malformed JSON and translates network errors to a safe message", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }))
      .mockRejectedValueOnce(new TypeError("socket details")));
    await expect(ownerRequest("/owner-state")).rejects.toThrow("invalid response");
    await expect(ownerRequest("/owner-state")).rejects.toThrow("Could not reach the local owner service.");
  });
});
