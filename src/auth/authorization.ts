import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { VaultAccessPolicy } from "../backend/accessPolicy.js";
import type { GrantReader, PathAction, VaultGrant } from "./grants.js";
import { grantPath } from "./grants.js";
import type { OAuthContext } from "./requestContext.js";
import { assertTrustedContext, authorizationDenied } from "./requestContext.js";

export type AuthorizationDecision = Readonly<{ allowed: boolean; code: "ALLOW" | "ACCESS_DENIED" }>;
const writeActions = new Set<PathAction>(["writeNote", "writeFile", "appendToNote", "deletePath", "createFolder", "movePath", "applyNoteEdits", "patchHeading", "patchFrontmatter"]);
const contains = (prefix: string, target: string) => prefix === target || target.startsWith(`${prefix}/`);

/** One immutable principal/tool/action binding, with live grant reads, not cached consent. */
export class OperationAuthorization {
  public readonly scope: "read" | "write";
  public constructor(
    private readonly context: OAuthContext,
    private readonly grants: GrantReader,
    private readonly vaultId: string,
    private readonly resource: string,
    private readonly tool: string,
    private readonly action: PathAction,
  ) {
    this.scope = writeActions.has(action) ? "write" : "read";
    this.assertActive();
  }

  private current(): VaultGrant {
    assertTrustedContext(this.context);
    const grant = this.grants.get(this.context.grantId);
    if (!grant || grant.revoked || grant.version !== 1 || grant.grantId !== this.context.grantId
      || grant.principalId !== this.context.principalId || grant.clientId !== this.context.clientId
      || grant.vaultId !== this.vaultId || grant.vaultId !== this.context.vaultId
      || grant.resource !== this.resource || grant.resource !== this.context.resource
      || !this.tool || !this.context.scopes.includes(`vault:${this.scope}`)
      || !grant.consentScopes.includes(`vault:${this.scope}`)
      || !grant.principalPermissions.some((rule) => rule.actions.includes(this.action))
      || !grant.clientPermissions.some((rule) => rule.actions.includes(this.action) && rule.tools.includes(this.tool))) throw authorizationDenied();
    return grant;
  }

  public assertActive(): void { this.current(); }

  /** Global lexical/canonical/read-only policy is applied separately, below. */
  public decide(target: string): AuthorizationDecision {
    const grant = this.current();
    try {
      grantPath(target);
      const allowed = grant.principalPermissions.some((rule) => rule.actions.includes(this.action) && contains(rule.path, target))
        && grant.clientPermissions.some((rule) => rule.actions.includes(this.action) && rule.tools.includes(this.tool) && contains(rule.path, target));
      return Object.freeze({ allowed, code: allowed ? "ALLOW" : "ACCESS_DENIED" });
    } catch { return Object.freeze({ allowed: false, code: "ACCESS_DENIED" }); }
  }

  public assertPath(target: string): void {
    if (!this.decide(target).allowed) throw authorizationDenied();
  }

  public fingerprint(): string {
    const grant = this.current();
    return createHash("sha256").update(JSON.stringify({
      ...this.context, requestId: undefined, scopes: [...this.context.scopes].sort(),
      revision: grant.revision, grant, tool: this.tool, action: this.action,
    })).digest("hex");
  }
}

/** A fresh instance per operation; the shared server policy is never mutated. */
export class RequestAccessPolicy extends VaultAccessPolicy {
  private readonly checked = new Map<string, "read" | "write">();
  public constructor(private readonly vault: string, private readonly global: VaultAccessPolicy, public readonly authorization: OperationAuthorization) {
    super(vault, false, [], []);
  }

  public override authorize(input: string, access: "read" | "write"): string {
    if (access === "write" && this.authorization.scope !== "write") throw authorizationDenied();
    this.authorization.assertPath(input);
    const relative = this.global.authorize(input, access);
    this.authorization.assertPath(relative);
    return relative;
  }

  // Request views cannot start a shared index traversal.
  public override mayTraverse(_absolute: string): boolean { void _absolute; return false; }

  public override async resolve(input: string, access: "read" | "write", mustExist: boolean, denyRoot = false) {
    if (access === "write" && this.authorization.scope !== "write") throw authorizationDenied();
    this.authorization.assertPath(input);
    const resolved = await this.global.resolve(input, access, mustExist, denyRoot);
    // Scoped OAuth deliberately rejects aliases, even in-vault ones. Verify
    // every existing component, including a parent of a not-yet-created file.
    let current = this.vault;
    let existing = this.vault;
    let missing: string[] = [];
    const segments = resolved.relative.split("/");
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw authorizationDenied();
        existing = current;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          missing = segments.slice(index);
          break;
        }
        throw error;
      }
    }
    // Apply scoped rights to the canonical target as well as the lexical path,
    // including platform aliases such as case/trailing-dot normalization.
    const canonical = path.resolve(await fs.realpath(existing), ...missing);
    this.authorization.assertPath(path.relative(this.vault, canonical).split(path.sep).join("/"));
    this.authorization.assertPath(resolved.relative);
    this.checked.set(input, access);
    return resolved;
  }

  public async revalidate(): Promise<void> {
    this.authorization.assertActive();
    for (const [input, access] of this.checked) await this.resolve(input, access, false);
  }

  public override async allowsSearchPath(absolute: string, directory = false): Promise<boolean> {
    this.authorization.assertActive();
    if (this.authorization.scope !== "read") return false;
    if (!(await this.global.allowsSearchPath(absolute, directory))) return false;
    const relative = path.relative(this.vault, absolute).split(path.sep).join("/");
    return !directory && this.authorization.decide(relative).allowed;
  }
}
