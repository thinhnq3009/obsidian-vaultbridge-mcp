import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { getOAuthProviderApi } from "@better-auth/oauth-provider";
import { createAuthEndpoint } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { z } from "zod";

export const oauthScopes = ["vault:read", "vault:write", "offline_access"] as const;
export type OAuthProviderOptions = { issuer: string; resource: string; ownerOrigin: string; vaultId: string };

/** Provider-owned active opaque-token validation, not JWT decoding/introspection-by-HTTP. */
export function oauthPlugins(options: OAuthProviderOptions) {
  const provider = mcp({
    resource: options.resource,
    loginPage: `${options.ownerOrigin}/login`,
    consentPage: `${options.ownerOrigin}/consent`,
    scopes: [...oauthScopes],
    grantTypes: ["authorization_code", "refresh_token"],
    codeExpiresIn: 120,
    accessTokenExpiresIn: 300,
    refreshTokenReuseInterval: 0,
    disableJwtPlugin: true,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
  });
  return [
    jwt(),
    provider,
    cimd({
      metadataProfile: "mcp-2026-07-28",
      // Maintained Node transport: resolve once, reject private/special-use IPs,
      // pin the connection, validate TLS, never follow redirects.
      fetchClientMetadataResource,
      maxCacheEntries: 128,
      metadataFetchPolicy: {
        maximumConcurrentFetches: 4, maximumConcurrentFetchesPerOrigin: 2,
        maximumFetchesPerMinute: 30, maximumFetchesPerOriginPerMinute: 10,
      },
    }),
    {
      id: "vaultbridge-active-access",
      endpoints: {
        verifyVaultAccess: createAuthEndpoint("/vaultbridge/verify-access", {
          method: "POST", body: z.object({ token: z.string().min(1).max(8192) }),
          metadata: { SERVER_ONLY: true },
        }, async (ctx) => {
          const api = getOAuthProviderApi(ctx, provider.options);
          const claims = await api.requireActiveAccessToken(ctx.body.token);
          const client = typeof claims.client_id === "string" ? await api.getClient(claims.client_id) : null;
          if (!client || client.disabled) throw new Error("Inactive OAuth client");
          return claims;
        }),
      },
    },
  ];
}

const verified = new WeakSet<VerifiedPrincipal>();
const claimsSchema = z.object({
  active: z.literal(true), iss: z.string(), aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(512), client_id: z.string().min(1).max(2048),
  scope: z.string().min(1), exp: z.number().int(), token_type: z.literal("Bearer"),
});
export type VerifiedPrincipal = Readonly<{
  principalId: string; clientId: string; resource: string; scopes: readonly string[]; expiresAt: number;
}>;

/**
 * The verifier capability is captured at owner/runtime construction. No route
 * accepts claims or a verifier from the caller. Opaque tokens only (#60).
 */
export function principalVerifier(
  validate: (token: string) => Promise<unknown>,
  options: { issuer: string; resource: string; ownerId: () => string | undefined },
) {
  return async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
    const match = /^Bearer ([A-Za-z0-9_-]{16,8192})$/u.exec(authorization ?? "");
    if (!match) throw new Error("Invalid bearer");
    const claims = claimsSchema.parse(await validate(match[1]!));
    const scopes = claims.scope.split(" ");
    const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (claims.iss !== options.issuer || audience.length !== 1 || audience[0] !== options.resource
      || claims.exp * 1000 <= Date.now() || claims.sub !== options.ownerId()
      || !scopes.some((scope) => scope === "vault:read" || scope === "vault:write")
      || scopes.some((scope) => !oauthScopes.includes(scope as typeof oauthScopes[number]))) throw new Error("Invalid bearer claims");
    const principal: VerifiedPrincipal = Object.freeze({
      principalId: claims.sub, clientId: claims.client_id, resource: options.resource,
      scopes: Object.freeze(scopes), expiresAt: claims.exp * 1000,
    });
    verified.add(principal);
    return principal;
  };
}

export function assertVerifiedPrincipal(principal: VerifiedPrincipal): void {
  if (!verified.has(principal) || principal.expiresAt <= Date.now()) throw new Error("Unverified OAuth principal");
}
