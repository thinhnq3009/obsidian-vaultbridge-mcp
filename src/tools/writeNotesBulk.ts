import { z } from "zod";

import { vaultPathSchema } from "../types.js";
import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";

const fileSchema = z.object({
  path: vaultPathSchema.describe("Relative markdown file path inside the vault."),
  content: z.string().describe("Full note content to write."),
  mode: z.enum(["create", "replace"]).default("create").describe("Create a new note or replace an existing note."),
  overwrite: z.boolean().optional().describe("Compatibility alias for mode=replace."),
  expected_revision: z.string().optional().describe("Required when replacing an existing note."),
});

const inputSchema = z.object({
  files: z.array(fileSchema).min(1).describe("Markdown notes to create or safely replace."),
});

const outputSchema = z.object({
  written: z.array(
    z.object({
      path: z.string(),
      message: z.string(),
      revision: z.string().optional(),
    }),
  ),
  count: z.number().int().nonnegative(),
});

export const registerWriteNotesBulkTool: ToolRegistrar = (server, client) => {
  server.registerTool(
    "obsidian_write_notes_bulk",
    {
      title: "Write Obsidian Notes Bulk",
      description: "Create or safely replace multiple markdown notes in one request.",
      inputSchema,
      outputSchema,
    },
    async ({ files }) => {
      try {
        await client.preflightWriteNotes?.(files.map((file) => file.path));
        const written = [];
        for (const file of files) {
          const mode = file.overwrite ? "replace" : file.mode;
          written.push(await client.writeNote(file.path, file.content, { mode, ...(file.expected_revision ? { expectedRevision: file.expected_revision } : {}) }));
        }

        return successResult(`Wrote ${written.length} note${written.length === 1 ? "" : "s"}.`, { written, count: written.length });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
