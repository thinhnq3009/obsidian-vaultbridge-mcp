import { z } from "zod";

import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";
import { patchOperationSchema, vaultPathSchema, VaultError } from "../types.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

const frontmatterEditSchema = z.object({
  field: z.string().min(1),
  value: jsonValueSchema,
  operation: patchOperationSchema.default("replace"),
  create_if_missing: z.boolean().default(true),
});

const sectionEditSchema = z.object({
  heading: z.string().min(1),
  content: z.string(),
  operation: patchOperationSchema.default("replace"),
  occurrence: z.number().int().min(1).optional(),
});

const inputSchema = z.object({
  path: vaultPathSchema.describe("Existing Markdown note path inside the vault."),
  expected_revision: z.string().min(1).describe("Revision of the entire note from the latest read."),
  frontmatter_updates: z.array(frontmatterEditSchema).max(50).optional(),
  section_edits: z.array(sectionEditSchema).max(50).optional(),
});

const outputSchema = z.object({
  path: z.string(),
  message: z.string(),
  revision: z.string(),
  frontmatter_edits: z.number().int(),
  section_edits: z.number().int(),
  changed: z.boolean(),
});

export const registerApplyNoteEditsTool: ToolRegistrar = (server, backend) => {
  server.registerTool(
    "obsidian_apply_note_edits",
    {
      title: "Atomically Apply Note Edits",
      description: "Apply frontmatter and heading patches in request order to one existing Markdown note with one revision check and one atomic filesystem write. Unsupported on Local REST.",
      inputSchema,
      outputSchema,
    },
    async ({ path, expected_revision, frontmatter_updates, section_edits }) => {
      try {
        if ((frontmatter_updates?.length ?? 0) + (section_edits?.length ?? 0) === 0) {
          throw new VaultError("At least one frontmatter or section edit is required.", { code: "INVALID_QUERY" });
        }
        const result = await backend.applyNoteEdits(path, expected_revision, {
          frontmatter: (frontmatter_updates ?? []).map(({ field, value, operation, create_if_missing }) =>
            ({ field, value, operation, createIfMissing: create_if_missing })),
          sections: (section_edits ?? []).map(({ heading, content, operation, occurrence }) =>
            ({ heading, content, operation, ...(occurrence ? { occurrence } : {}) })),
        });
        return successResult(`Applied note edits to ${result.path}.`, {
          path: result.path,
          message: result.message,
          revision: result.revision,
          frontmatter_edits: result.frontmatterEdits,
          section_edits: result.sectionEdits,
          changed: result.changed,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
