import { z } from "zod";

import { VaultError } from "../types.js";
import { assertVerifiedPrincipal, type VerifiedPrincipal } from "./oauth.js";
import type { VaultGrant } from "./grants.js";

const identifier = z.string().trim().min(1).max(512);
const contextSchema = z.object({
  mode: z.literal("oauth"),
  principalId: identifier,
  clientId: identifier,
  grantId: identifier,
  vaultId: identifier,
  resource: z.url(),
  scopes: z.array(identifier).min(1),
  requestId: identifier,
}).strict();

export type OAuthContext = Readonly<Omit<z.infer<typeof contextSchema>, "scopes"> & { scopes: readonly string[] }>;
export type AuthContext = OAuthContext | Readonly<{ mode: "token" | "none" | "stdio" }>;

// A structurally valid object (including a decoded JWT/header) is not verified.
const trustedContexts = new WeakSet<OAuthContext>();
const expirations = new WeakMap<OAuthContext, number>();

/** Production issuer accepts only a live provider-verified object and server-resolved grant. */
export function createVerifiedAuthContext(principal: VerifiedPrincipal, grant: VaultGrant, requestId: string): OAuthContext {
  assertVerifiedPrincipal(principal);
  if (grant.revoked || grant.principalId !== principal.principalId || grant.clientId !== principal.clientId
    || grant.resource !== principal.resource) throw authorizationDenied();
  const data = contextSchema.parse({
    mode: "oauth", principalId: principal.principalId, clientId: principal.clientId,
    resource: principal.resource, scopes: [...principal.scopes], requestId,
    vaultId: grant.vaultId, grantId: grant.grantId,
  });
  const context: OAuthContext = Object.freeze({ ...data, scopes: Object.freeze(data.scopes) });
  trustedContexts.add(context);
  expirations.set(context, principal.expiresAt);
  return context;
}

/** Test harness only. No production route, configuration or HTTP injection hook. */
export function createTestAuthContext(input: unknown): OAuthContext {
  if (process.env.NODE_ENV !== "test") throw authorizationDenied();
  const result = contextSchema.safeParse(input);
  if (!result.success) throw authorizationDenied();
  const context: OAuthContext = Object.freeze({ ...result.data, scopes: Object.freeze([...result.data.scopes]) });
  trustedContexts.add(context);
  return context;
}

export function assertTrustedContext(context: OAuthContext): void {
  if (!trustedContexts.has(context) || (expirations.get(context) ?? Infinity) <= Date.now()) throw authorizationDenied();
}

export function authorizationDenied(): VaultError {
  return new VaultError("Request authorization denied.", { code: "ACCESS_DENIED" });
}
