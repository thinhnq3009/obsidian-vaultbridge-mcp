import { toString } from "mdast-util-to-string";
import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { parseDocument } from "yaml";

import type { PatchOperation } from "../types.js";
import { VaultError } from "../types.js";

type PositionedNode = {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

export function parseMetadata(content: string) {
  const tree = parser.parse(stripBom(content));
  const headings: Array<{ text: string; level: number }> = [];
  const links = new Set<string>();
  const tags = new Set<string>();
  let frontmatter: Record<string, unknown> = {};

  visit(tree, (rawNode) => {
    const node = rawNode as PositionedNode;
    if (node.type === "heading" && node.depth) {
      headings.push({ text: toString(node as never), level: node.depth });
    } else if (node.type === "link" && node.url) {
      links.add(node.url);
    } else if (node.type === "yaml" && typeof node.value === "string") {
      const document = parseDocument(node.value);
      if (document.errors.length > 0) {
        throw new VaultError("Invalid YAML frontmatter.", { code: "INVALID_MARKDOWN", details: document.errors.map((error) => error.message) });
      }
      frontmatter = (document.toJS() as Record<string, unknown> | null) ?? {};
    } else if (node.type === "text" && typeof node.value === "string") {
      for (const match of node.value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) {
        if (match[1]) links.add(match[1].trim());
      }
      for (const match of node.value.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
        if (match[2] && !/^\p{N}+$/u.test(match[2])) tags.add(match[2]);
      }
    }
  });

  const frontmatterTags = frontmatter.tags ?? frontmatter.tag;
  if (typeof frontmatterTags === "string") {
    for (const tag of frontmatterTags.split(/[ ,]+/u)) tags.add(tag.replace(/^#/u, ""));
  } else if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) if (typeof tag === "string") tags.add(tag.replace(/^#/u, ""));
  }

  return { frontmatter, headings, tags: [...tags], links: [...links] };
}

export function patchHeadingContent(content: string, heading: string, patch: string, operation: PatchOperation, occurrence?: number): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = stripBom(content);
  const tree = parser.parse(source);
  const headingNodes: PositionedNode[] = [];
  visit(tree, "heading", (rawNode) => {
    const node = rawNode as PositionedNode;
    if (toString(node as never).trim() === heading.trim()) headingNodes.push(node);
  });

  if (headingNodes.length === 0) throw new VaultError(`Heading not found: ${heading}`, { code: "HEADING_NOT_FOUND" });
  if (occurrence === undefined && headingNodes.length > 1) throw new VaultError(`Heading is ambiguous: ${heading}`, { code: "AMBIGUOUS_HEADING" });
  const selected = headingNodes[(occurrence ?? 1) - 1];
  if (!selected?.position?.end.offset || !selected.depth) throw new VaultError("Heading position is unavailable.", { code: "INVALID_MARKDOWN" });

  const start = selected.position.end.offset;
  let end = source.length;
  visit(tree, "heading", (rawNode) => {
    const node = rawNode as PositionedNode;
    const offset = node.position?.start.offset;
    if (offset !== undefined && offset > start && (node.depth ?? 7) <= selected.depth! && offset < end) end = offset;
  });

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const current = source.slice(start, end);
  const normalizedPatch = patch.replace(/\r?\n/gu, newline);
  let replacement: string;
  if (operation === "replace") {
    replacement = `${newline}${normalizedPatch.replace(/^\r?\n|\r?\n$/gu, "")}${newline}${newline}`;
  } else if (operation === "prepend") {
    replacement = `${newline}${normalizedPatch.replace(/\r?\n$/gu, "")}${current}`;
  } else {
    const trimmedCurrent = current.replace(/\s*$/u, "");
    replacement = `${trimmedCurrent}${newline}${normalizedPatch.replace(/^\r?\n/gu, "")}${newline}${newline}`;
  }
  return bom + source.slice(0, start) + replacement + source.slice(end);
}

export function patchFrontmatterContent(content: string, field: string, value: unknown, operation: PatchOperation, createIfMissing: boolean): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = stripBom(content);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  const document = parseDocument(match?.[1] ?? "");
  if (document.errors.length > 0) throw new VaultError("Invalid YAML frontmatter.", { code: "INVALID_MARKDOWN", details: document.errors.map((error) => error.message) });
  const exists = document.hasIn(field.split("."));
  if (!exists && !createIfMissing) throw new VaultError(`Frontmatter field not found: ${field}`, { code: "NOT_FOUND" });
  const path = field.split(".");
  const current = toPlainYamlValue(document.getIn(path));
  if (operation === "replace" || current === undefined) document.setIn(path, value);
  else document.setIn(path, patchFrontmatterValue(current, value, operation));
  const yaml = document.toString({ lineWidth: 0 }).trimEnd().replace(/\n/gu, newline);
  const block = `---${newline}${yaml}${newline}---${newline}`;
  return bom + (match ? block + source.slice(match[0].length) : block + source);
}

function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function patchFrontmatterValue(current: unknown, value: unknown, operation: Exclude<PatchOperation, "replace">): unknown {
  if (Array.isArray(current)) {
    const currentItems = current as unknown[];
    const incomingItems = Array.isArray(value) ? (value as unknown[]) : [value];
    return operation === "append" ? [...currentItems, ...incomingItems] : [...incomingItems, ...currentItems];
  }

  if (isScalar(current) && isScalar(value)) {
    return operation === "append" ? `${valueToText(current)}${valueToText(value)}` : `${valueToText(value)}${valueToText(current)}`;
  }

  throw new VaultError("Frontmatter append/prepend requires an array or scalar field with a compatible value.", { code: "INVALID_MARKDOWN" });
}

function isScalar(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function toPlainYamlValue(value: unknown): unknown {
  if (value && typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    return (value as { toJSON: () => unknown }).toJSON();
  }

  return value;
}
