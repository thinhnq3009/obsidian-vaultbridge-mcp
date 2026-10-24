import fs from "node:fs/promises";
import path from "node:path";

import { normalizeVaultPathInput, VaultError } from "../types.js";

type Access = "read" | "write";

/** Shared lexical and canonical path authorization for filesystem entry points. */
export class VaultAccessPolicy {
  private readonly readPrefixes: string[];
  private readonly writePrefixes: string[];

  public constructor(
    private readonly root: string,
    private readonly readOnly: boolean,
    readPaths: string[],
    writePaths: string[],
  ) {
    this.readPrefixes = readPaths.map(normalizeRelative).filter(Boolean);
    this.writePrefixes = writePaths.map(normalizeRelative).filter(Boolean);
  }

  public async resolve(input: string, access: Access, mustExist: boolean, denyRoot = false): Promise<{ relative: string; absolute: string }> {
    const relative = this.authorize(input, access);
    const absolute = path.resolve(this.root, ...relative.split("/").filter(Boolean));
    this.assertInside(absolute);
    const ancestor = await nearestExisting(absolute);
    const canonical = path.resolve(await fs.realpath(ancestor), path.relative(ancestor, absolute));
    this.assertInside(canonical);
    this.assertAllowed(normalizeRelative(path.relative(this.root, canonical)), access);
    if (denyRoot && path.relative(this.root, canonical) === "") {
      throw new VaultError("Deleting or moving the vault root is not allowed.", { code: "ACCESS_DENIED" });
    }
    if (mustExist && !(await exists(absolute))) throw new VaultError(`Path does not exist: ${relative}`, { code: "NOT_FOUND" });
    return { relative, absolute };
  }

  /** Allows walking ancestors of read scopes without authorizing their contents. */
  public mayTraverse(absolute: string): boolean {
    const relative = path.relative(this.root, absolute).replace(/\\/gu, "/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || isProtectedPath(relative)) return false;
    return relative === "" || this.readPrefixes.length === 0 || this.readPrefixes.some((prefix) => contains(prefix, relative) || contains(relative, prefix));
  }

  /** Search deliberately excludes all symlinks/junctions, including in-scope aliases. */
  public async allowsSearchPath(absolute: string, directory = false): Promise<boolean> {
    try {
      this.assertInside(absolute);
      const relative = normalizeRelative(path.relative(this.root, absolute));
      if (isProtectedPath(relative)) return false;
      if (directory) {
        if (!this.mayTraverse(absolute)) return false;
      } else {
        this.assertAllowed(relative, "read");
      }
      const canonical = await fs.realpath(absolute);
      this.assertInside(canonical);
      // Comparing the complete path also rejects symlinks in parent directories.
      if (path.relative(absolute, canonical) !== "") return false;
      if (!directory) this.assertAllowed(normalizeRelative(path.relative(this.root, canonical)), "read");
      return !(await fs.lstat(absolute)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Lexical authorization for adapters that cannot resolve remote filesystem paths. */
  public authorize(input: string, access: Access): string {
    const relative = normalizeRelative(input);
    this.assertAllowed(relative, access);
    return relative;
  }

  private assertAllowed(relative: string, access: Access): void {
    if (isProtectedPath(relative)) throw new VaultError("Protected vault path.", { code: "ACCESS_DENIED" });
    if (access === "write" && this.readOnly) throw new VaultError("Vault is in read-only mode.", { code: "READ_ONLY" });
    const prefixes = access === "read" ? this.readPrefixes : this.writePrefixes;
    if (prefixes.length > 0 && !prefixes.some((prefix) => contains(prefix, relative))) throw new VaultError(`Path is outside configured ${access} scope: ${relative}`, { code: "ACCESS_DENIED" });
  }

  private assertInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new VaultError("Resolved path escapes the vault.", { code: "INVALID_PATH" });
  }
}

function contains(prefix: string, relative: string): boolean {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

function normalizeRelative(input: string): string {
  if (input.includes("\0") || path.isAbsolute(input) || /^[a-zA-Z]:/u.test(input) || /^[/\\]/u.test(input)) throw new VaultError("Absolute and UNC paths are not allowed.", { code: "INVALID_PATH" });
  const relative = normalizeVaultPathInput(input);
  if (relative.split("/").includes("..")) throw new VaultError("Path traversal is not allowed.", { code: "INVALID_PATH" });
  const normalized = path.posix.normalize(relative);
  return normalized === "." ? "" : normalized.replace(/\/$/u, "");
}

async function exists(candidate: string): Promise<boolean> {
  try { await fs.lstat(candidate); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

async function nearestExisting(candidate: string): Promise<string> {
  let current = candidate;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** Case-insensitive on every platform, including Windows trailing-dot/ADS aliases. */
export function isProtectedPath(relative: string): boolean {
  return relative.replace(/\\/gu, "/").split("/").some((segment) => {
    const name = segment.split(":")[0]!.replace(/[. ]+$/gu, "").toLowerCase();
    return name === ".obsidian" || name === ".git" || name === ".env" || name.startsWith(".env.") || name.startsWith(".obsidian-vault-mcp-");
  });
}
