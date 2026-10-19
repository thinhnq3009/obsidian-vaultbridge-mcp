import { describe, expect, it } from "vitest";

import { parseMetadata, patchFrontmatterContent, patchHeadingContent } from "../src/backend/markdown.js";

describe("Markdown engine", () => {
  it("extracts metadata without treating code blocks as tags or links", () => {
    const metadata = parseMetadata("---\ntags: [project]\nstatus: active\n---\n# Plan\nSee [[Notes/Target]] and #roadmap.\n```md\n#fake [[Nope]]\n```\n");
    expect(metadata.frontmatter).toMatchObject({ status: "active" });
    expect(metadata.headings).toEqual([{ text: "Plan", level: 1 }]);
    expect(metadata.tags).toEqual(expect.arrayContaining(["project", "roadmap"]));
    expect(metadata.links).toContain("Notes/Target");
    expect(metadata.links).not.toContain("Nope");
  });

  it("requires an occurrence for duplicate headings", () => {
    const content = "# Same\nFirst\n# Same\nSecond\n";
    expect(() => patchHeadingContent(content, "Same", "Updated", "replace")).toThrow(/ambiguous/i);
    const patched = patchHeadingContent(content, "Same", "Updated", "replace", 2);
    expect(patched).toContain("First");
    expect(patched).toContain("# Same\nUpdated");
  });

  it("excludes numeric-only body references while keeping mixed and Unicode tags", () => {
    const metadata = parseMetadata("#123 #6120 #１２３ #123abc #123/456 #6120-x #_123 #tiếng-việt #日本語 #123abc");
    expect(metadata.tags).toEqual(["123abc", "123/456", "6120-x", "_123", "tiếng-việt", "日本語"]);
  });

  it.each([
    "tags: [project/test, '#tiếng-việt', project/test]",
    "tags:\n  - project/test\n  - '#tiếng-việt'\n  - project/test",
    "tags: 'project/test, #tiếng-việt project/test'",
    "tag: 'project/test, #tiếng-việt project/test'",
  ])("preserves supported frontmatter tag forms: %s", (yaml) => {
    expect(parseMetadata(`---\n${yaml}\n---\n#123 #6120 #body`).tags).toEqual(["body", "project/test", "tiếng-việt"]);
  });

  it("extracts wikilink targets independently of aliases and anchors and retains standard link URLs", () => {
    const metadata = parseMetadata("[[Notes/Plain]] [[Notes/Aliased|Alias]] [[Notes/Anchored#Part]] [[Notes/日本語#見出し|表示]] [[Notes/Plain]] [site](https://example.com/#part) [local](Notes/Target.md#Part)");
    expect(metadata.links).toEqual(["Notes/Plain", "Notes/Aliased", "Notes/Anchored", "Notes/日本語", "https://example.com/#part", "Notes/Target.md#Part"]);
  });

  it("preserves BOM and CRLF while patching frontmatter", () => {
    const content = "\uFEFF---\r\nstatus: open # keep\r\nowner: me\r\n---\r\n# Note\r\n";
    const patched = patchFrontmatterContent(content, "status", "done", "replace", true);
    expect(patched.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(patched).toContain("owner: me");
    expect(patched).toContain("# keep");
    expect(patched).toContain("status: done");
  });

  it("preserves array frontmatter when appending and prepending", () => {
    const content = "---\ntags:\n  - mcp-test\n  - alpha\n---\n# Note\n";
    const appended = patchFrontmatterContent(content, "tags", "appended-tag", "append", true);
    const prepended = patchFrontmatterContent(appended, "tags", "prepended-tag", "prepend", true);
    const metadata = parseMetadata(prepended);

    expect(metadata.frontmatter.tags).toEqual(["prepended-tag", "mcp-test", "alpha", "appended-tag"]);
    expect(prepended).not.toContain("prepended-tag[");
  });

  it("concatenates arrays when patching array frontmatter with array values", () => {
    const content = "---\ntags: [alpha]\n---\n# Note\n";
    const patched = patchFrontmatterContent(content, "tags", ["beta", "gamma"], "append", true);

    expect(parseMetadata(patched).frontmatter.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("refuses malformed frontmatter without producing output", () => {
    expect(() => patchFrontmatterContent("---\nbroken: [\n---\nBody", "status", "done", "replace", true)).toThrow(/invalid yaml/i);
  });
});
