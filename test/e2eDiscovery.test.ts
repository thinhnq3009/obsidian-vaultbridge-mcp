import { describe, expect, it } from "vitest";

import { verifyDiscovery } from "../scripts/e2eDiscovery.js";

const origin = "https://disposable-tunnel.example";
const owner = "http://127.0.0.1:39146";

function fixture(changes: Record<string, unknown> = {}, status = 200): typeof fetch {
  return (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return Promise.resolve(Response.json({
        resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`],
      }));
    }
    const rfcAlias = url.endsWith("/.well-known/oauth-authorization-server/api/auth");
    return Promise.resolve(Response.json({
      issuer: `${origin}/api/auth`,
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
      code_challenge_methods_supported: ["S256"],
      ...(rfcAlias ? changes : {}),
    }, { status: rfcAlias ? status : 200 }));
  };
}

describe("CLI discovery evidence", () => {
  it("accepts consistent protected-resource metadata and both authorization aliases", async () => {
    await verifyDiscovery(fixture(), origin, owner);
  });

  it.each(["authorization_endpoint", "token_endpoint", "revocation_endpoint"])(
    "rejects a wrong %s on the RFC alias even when the other alias is correct",
    async (field) => {
      await expect(verifyDiscovery(fixture({ [field]: "https://wrong.example" }), origin, owner)).rejects.toThrow();
    },
  );

  it("rejects a private owner URL hidden in an additional metadata field", async () => {
    await expect(verifyDiscovery(fixture({ extra: owner }), origin, owner)).rejects.toThrow();
  });

  it("rejects an error response with an otherwise plausible metadata document", async () => {
    await expect(verifyDiscovery(fixture({}, 503), origin, owner)).rejects.toThrow();
  });
});
