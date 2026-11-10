import assert from "node:assert/strict";

interface ToolClient {
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; [key: string]: unknown }>;
}

function assertAccessDenied(result: { isError?: boolean; [key: string]: unknown }, message: string): void {
  assert.equal(result.isError, true, message);
  assert.ok(Array.isArray(result.content) && result.content.some((block: unknown) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text"
    && "text" in block && typeof block.text === "string" && block.text.startsWith("ACCESS_DENIED:"),
  ), message);
}

/** Shared local/tunnel probe: errors must prove authorization, not bad inputs. */
export async function verifyReadonlyTools(client: ToolClient, options: { notePath: string; deniedPath: string; expectedContent: string }): Promise<void> {
  const allowed = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.notEqual(allowed.isError, true);
  assert.ok(JSON.stringify(allowed).includes(options.expectedContent), "Allowed note content");
  const revision = allowed.structuredContent?.revision;
  assert.equal(typeof revision, "string", "Read must supply the revision for a valid replace attempt");
  const denied = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.deniedPath } });
  assertAccessDenied(denied, "Read outside the grant must fail for authorization");
  const write = await client.callTool({
    name: "obsidian_write_note", arguments: {
      path: options.notePath, content: "must not write", mode: "replace", expected_revision: revision,
    },
  });
  assertAccessDenied(write, "Write must fail for authorization, not validation or conflict");
  const unchanged = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.notEqual(unchanged.isError, true);
  assert.ok(JSON.stringify(unchanged).includes(options.expectedContent), "Denied write must not modify the note");
  assert.equal(unchanged.structuredContent?.revision, revision, "Denied write must preserve the exact revision");
}

/** Positive mutation evidence through the same OAuth MCP client, on a disposable note. */
export async function verifyWritableTools(client: ToolClient, options: { notePath: string; deniedPath: string }): Promise<void> {
  const firstContent = "Disposable OAuth write probe v1";
  const secondContent = "Disposable OAuth write probe v2";
  const created = await client.callTool({ name: "obsidian_write_note", arguments: {
    path: options.notePath, content: firstContent, mode: "create",
  } });
  assert.notEqual(created.isError, true, "Scoped OAuth create must succeed");
  const first = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.notEqual(first.isError, true);
  assert.equal(first.structuredContent?.content, firstContent);
  const revision = first.structuredContent?.revision;
  assert.equal(typeof revision, "string");
  const replaced = await client.callTool({ name: "obsidian_write_note", arguments: {
    path: options.notePath, content: secondContent, mode: "replace", expected_revision: revision,
  } });
  assert.notEqual(replaced.isError, true, "Revision-valid OAuth replace must succeed");
  const second = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.notEqual(second.isError, true);
  assert.equal(second.structuredContent?.content, secondContent);
  assert.equal(typeof second.structuredContent?.revision, "string");
  assert.notEqual(second.structuredContent?.revision, revision);
  const stale = await client.callTool({ name: "obsidian_write_note", arguments: {
    path: options.notePath, content: "must not overwrite", mode: "replace", expected_revision: revision,
  } });
  assert.equal(stale.isError, true);
  assert.ok(Array.isArray(stale.content) && stale.content.some((block: unknown) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text"
    && "text" in block && typeof block.text === "string" && block.text.startsWith("CONFLICT:")),
  "Stale OAuth replace must fail specifically for revision conflict");
  const unchanged = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.notEqual(unchanged.isError, true);
  assert.equal(unchanged.structuredContent?.content, secondContent);
  assert.equal(unchanged.structuredContent?.revision, second.structuredContent?.revision);
  const denied = await client.callTool({ name: "obsidian_write_note", arguments: {
    path: options.deniedPath, content: "must not write", mode: "create",
  } });
  assertAccessDenied(denied, "A write token must still respect its path grant");
  const deleted = await client.callTool({ name: "obsidian_delete_path", arguments: {
    path: options.notePath, expected_revision: second.structuredContent?.revision,
  } });
  assert.notEqual(deleted.isError, true, "Revision-valid OAuth delete must succeed");
  const missing = await client.callTool({ name: "obsidian_read_note", arguments: { path: options.notePath } });
  assert.equal(missing.isError, true);
  assert.ok(Array.isArray(missing.content) && missing.content.some((block: unknown) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text"
    && "text" in block && typeof block.text === "string" && block.text.startsWith("NOT_FOUND:")),
  "Deleted note must be absent, not hidden by a changed authorization policy");
}
