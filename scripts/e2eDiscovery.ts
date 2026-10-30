import assert from "node:assert/strict";

/** Check both discovery aliases, not just a successful status on one alias. */
export async function verifyDiscovery(fetch: typeof globalThis.fetch, origin: string, ownerOrigin: string): Promise<void> {
  function assertNoOwnerLeak(document: unknown) {
    const text = JSON.stringify(document);
    assert.ok(!text.includes(ownerOrigin), "Discovery leaked the private owner origin");
    if (new URL(origin).protocol === "https:") {
      assert.doesNotMatch(text, /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/"])/i);
    }
  }
  const resourceResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json() as { resource: string; authorization_servers: string[] };
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${origin}/api/auth`]);
  assertNoOwnerLeak(resource);
  for (const endpoint of [
    "/api/auth/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
  ]) {
    const response = await fetch(`${origin}${endpoint}`);
    assert.equal(response.status, 200, endpoint);
    const metadata = await response.json() as Record<string, unknown>;
    assert.equal(metadata.issuer, `${origin}/api/auth`, endpoint);
    assert.equal(metadata.authorization_endpoint, `${origin}/api/auth/oauth2/authorize`, endpoint);
    assert.equal(metadata.token_endpoint, `${origin}/api/auth/oauth2/token`, endpoint);
    assert.equal(metadata.revocation_endpoint, `${origin}/api/auth/oauth2/revoke`, endpoint);
    assert.ok(Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes("S256"));
    assertNoOwnerLeak(metadata);
  }
}
