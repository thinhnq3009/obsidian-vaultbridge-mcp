import type { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { z } from "zod";

import type { VaultBackend } from "../backend/types.js";
import { isProtectedPath } from "../backend/accessPolicy.js";
import { authorizationDenied } from "./requestContext.js";

export const pathActions = [
  "listFiles", "statPath", "readNote", "writeNote", "writeFile", "appendToNote",
  "deletePath", "createFolder", "movePath", "readNoteMetadata", "applyNoteEdits",
  "patchHeading", "patchFrontmatter", "search", "openFile",
] as const satisfies readonly (keyof VaultBackend)[];
export type PathAction = typeof pathActions[number];

/** Explicit non-root subtrees or individual paths, never glob/implicit-all. */
export function grantPath(input: string): string {
  if (!input || input !== input.trim() || input.includes("\\") || input.includes("\0")
    || /[*?[\]:]/u.test(input) || path.posix.isAbsolute(input)
    || input.split("/").some((part) => !part || part === "." || part === "..")
    || isProtectedPath(input)) throw authorizationDenied();
  return input;
}

const id = z.string().trim().min(1).max(512);
const prefix = z.string().refine((value) => { try { grantPath(value); return true; } catch { return false; } });
const actions = z.array(z.enum(pathActions)).min(1);
const permission = z.object({ path: prefix, actions }).strict();
export const vaultGrantSchema = z.object({
  version: z.literal(1),
  grantId: id,
  principalId: id,
  clientId: id,
  vaultId: id,
  resource: z.url(),
  consentScopes: z.array(id).min(1),
  principalPermissions: z.array(permission).min(1),
  clientPermissions: z.array(permission.extend({
    tools: z.array(z.string().regex(/^obsidian_[a-z_]+$/u)).min(1),
  })).min(1),
}).strict();
export type VaultGrantInput = z.infer<typeof vaultGrantSchema>;
export type VaultGrant = VaultGrantInput & { revision: number; revoked: boolean };
export interface GrantReader { get(grantId: string): VaultGrant | undefined }

/** Independent application-owned migration; never edits Better Auth tables. */
export class SqliteGrantStore implements GrantReader {
  public constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS vaultbridge_authz_migration (version INTEGER PRIMARY KEY)");
    const version = db.prepare("SELECT max(version) AS version FROM vaultbridge_authz_migration").get()?.version;
    if (typeof version === "number" && version > 1) throw new Error("Authorization schema is newer than this binary");
    if (version === 1) return;
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE vaultbridge_vault_grant (
        grant_id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        revoked INTEGER NOT NULL CHECK(revoked IN (0, 1))
      );
      INSERT INTO vaultbridge_authz_migration VALUES (1);
      COMMIT;`);
  }

  /** Trusted owner-side API only; intentionally not registered as an MCP tool. */
  public put(input: VaultGrantInput): void {
    const grant = vaultGrantSchema.parse(input);
    if (!this.get(grant.grantId) && Number(this.db.prepare("SELECT count(*) AS count FROM vaultbridge_vault_grant").get()?.count) >= 1024) throw authorizationDenied();
    this.db.prepare(`INSERT INTO vaultbridge_vault_grant VALUES (?, ?, 1, 0)
      ON CONFLICT(grant_id) DO UPDATE SET document=excluded.document,
      revision=vaultbridge_vault_grant.revision+1, revoked=0`).run(grant.grantId, JSON.stringify(grant));
  }

  public revoke(grantId: string): void {
    this.db.prepare("UPDATE vaultbridge_vault_grant SET revoked=1, revision=revision+1 WHERE grant_id=?").run(grantId);
  }

  public revokePrincipal(principalId: string): void {
    for (const grant of this.list()) if (grant.principalId === principalId && !grant.revoked) this.revoke(grant.grantId);
  }

  public get(grantId: string): VaultGrant | undefined {
    const row = this.db.prepare("SELECT document, revision, revoked FROM vaultbridge_vault_grant WHERE grant_id=?").get(grantId);
    if (!row || typeof row.document !== "string" || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision)
      || row.revision < 1 || (row.revoked !== 0 && row.revoked !== 1)) return undefined;
    try {
      const parsed = vaultGrantSchema.safeParse(JSON.parse(row.document) as unknown);
      if (!parsed.success || parsed.data.grantId !== grantId) return undefined;
      return { ...parsed.data, revision: row.revision, revoked: row.revoked === 1 };
    } catch { return undefined; }
  }

  /** Owner-only enumeration, never registered as an MCP tool or public API. */
  public list(): VaultGrant[] {
    const rows = this.db.prepare("SELECT grant_id FROM vaultbridge_vault_grant LIMIT 1025").all();
    if (rows.length > 1024) throw authorizationDenied();
    return rows.map((row) => {
      const grant = typeof row.grant_id === "string" ? this.get(row.grant_id) : undefined;
      if (!grant) throw authorizationDenied();
      return grant;
    });
  }

  /** Ambiguous or missing live grants fail closed; HTTP input never selects an ID. */
  public resolve(principalId: string, clientId: string, vaultId: string, resource: string): VaultGrant | undefined {
    const grants = this.list().filter((grant) => !grant.revoked && grant.principalId === principalId
      && grant.clientId === clientId && grant.vaultId === vaultId && grant.resource === resource);
    return grants.length === 1 ? grants[0] : undefined;
  }
}
