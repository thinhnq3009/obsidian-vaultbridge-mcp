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
