import { z } from "zod";

import { VaultError } from "../types.js";

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
// Phase B must replace the test-only issuer with an actual provider verifier.
const trustedContexts = new WeakSet<OAuthContext>();

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
  if (!trustedContexts.has(context)) throw authorizationDenied();
}

export function authorizationDenied(): VaultError {
  return new VaultError("Request authorization denied.", { code: "ACCESS_DENIED" });
}
