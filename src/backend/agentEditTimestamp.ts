import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, parseDocument, visit } from "yaml";

import { VaultError } from "../types.js";

export const agentEditField = "agents_edit_at";

/** Called under the file lock, after revision/transform validation. */
export function prepareAgentEdit(content: string, previous: string | undefined, enabled: boolean): string {
  const next = frontmatter(content);
  const before = previous === undefined ? undefined : frontmatter(previous);
  if (before && next.body === before.body && next.bom === before.bom && isDeepStrictEqual(next.properties, before.properties)) {
    return previous!;
  }
  if (enabled) return validated(next.set(JSON.stringify(new Date().toISOString())));
  // Disabling automatic updates freezes the existing managed value, even when a
  // full replacement omits it. It does not grant clients ownership of the field.
  if (before?.managed !== undefined) return validated(next.set(before.managed));
  if (next.managed !== undefined) throw new VaultError(`${agentEditField} is server-managed.`, { code: "ACCESS_DENIED" });
  return content;
}

function frontmatter(content: string) {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = content.slice(bom.length);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const match = /^(---[ \t]*\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(source);
  // A thematic break elsewhere in the body is not frontmatter.
  const block = match?.index === 0 ? match : null;
  if (!block && /^---[ \t]*(?:\r?\n|$)/u.test(source)) invalid("Unclosed YAML frontmatter.");
  const yaml = block?.[2] ?? "";
  const document = parseDocument(yaml, { keepSourceTokens: true, intAsBigInt: true });
  if (document.errors.length || (document.contents !== null && !isMap(document.contents))) invalid("Frontmatter must be a valid YAML mapping.");
  const mapping = isMap(document.contents) ? document.contents : undefined;
  if (mapping?.items.some((pair) => !isScalar(pair.key) || typeof pair.key.value !== "string")) invalid("Frontmatter keys must be strings.");
  const managed = mapping?.items.find((pair) => isScalar(pair.key) && pair.key.value === agentEditField);
  const value = managed?.value;
  // Anchors/tags/collections on this reserved field cannot be replaced without
  // potentially changing other properties. Fail before writing instead.
  if (managed && (!isScalar(value) || value.anchor || value.tag || value.type === "BLOCK_LITERAL" || value.type === "BLOCK_FOLDED" || !value.range)) invalid(`${agentEditField} must be an untagged scalar without an anchor.`);
  const range = isScalar(value) ? value.range : undefined;
  const rawManaged = range ? yaml.slice(range[0], range[1]) : undefined;
  // Keep integers exact, including inside collections and aliases. Normalize
  // integral floats too so equivalent numeric spellings (1, 1.0, 1e0) remain
  // no-ops without converting a potentially unsafe bigint back to a number.
  // Visit the AST before resolving aliases, which may contain cycles.
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === "number" && Number.isInteger(node.value) && !Object.is(node.value, -0)) node.value = BigInt(node.value);
    },
  });
  const properties: unknown = document.toJS();
  if (properties && typeof properties === "object") Reflect.deleteProperty(properties, agentEditField);
  return {
    bom,
    body: block ? source.slice(block[0].length) : source,
    properties: properties ?? {},
    managed: rawManaged,
    set(raw: string): string {
      let updated: string;
      if (range) {
        const replacement = range[0] === range[1] ? ` ${raw} ` : raw;
        updated = yaml.slice(0, range[0]) + replacement + yaml.slice(range[1]);
      } else if (mapping?.flow && mapping.range) {
        // Insert immediately after '{', preserving every existing token/comment.
        const offset = mapping.range[0] + 1;
        updated = yaml.slice(0, offset) + `${agentEditField}: ${raw}${mapping.items.length ? ", " : ""}` + yaml.slice(offset);
      } else {
        const indent = " ".repeat(mapping?.srcToken?.indent ?? 0);
        updated = yaml + (yaml && !yaml.endsWith("\n") ? newline : "") + `${indent}${agentEditField}: ${raw}${newline}`;
      }
      if (!block) return `${bom}---${newline}${updated}---${newline}${source}`;
      const start = block[1]!.length;
      return bom + source.slice(0, start) + updated + source.slice(start + yaml.length);
    },
  };
}

function validated(content: string): string {
  frontmatter(content);
  return content;
}

function invalid(message: string): never {
  throw new VaultError(message, { code: "INVALID_MARKDOWN" });
}
