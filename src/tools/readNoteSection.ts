import { z } from "zod";

import { readHeadingSection } from "../backend/markdown.js";
import { vaultPathSchema } from "../types.js";
import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";

const inputSchema = z.object({
  path: vaultPathSchema.describe("Relative markdown file path inside the vault."),
  heading: z.string().min(1).refine((value) => value.trim().length > 0, "heading is required").describe("Case-sensitive plain heading text, trimmed, as in note metadata."),
  occurrence: z.number().int().min(1).optional().describe("1-based occurrence; required for duplicate heading text."),
  max_chars: z.number().int().min(1).max(100_000).default(20_000).describe("Maximum body UTF-16 code units (1–100000, default 20000); never splits a surrogate pair."),
});

const outputSchema = z.object({
  path: z.string(),
  heading: z.string(),
  level: z.number().int().min(1).max(6),
  content: z.string().describe("Exact section body, excluding the heading and its terminating newline, bounded by max_chars."),
  truncated: z.boolean(),
  start_line: z.number().int().min(1).describe("1-based first body line in the source, even for an empty body."),
  end_line: z.number().int().min(1).describe("Exclusive source line bound of the full body, unaffected by truncation; equals start_line for an empty body."),
  revision: z.string().nullable().describe("Unchanged backend revision of the full note, or null when unavailable."),
});

export const registerReadNoteSectionTool: ToolRegistrar = (server, backend) => {
  server.registerTool(
    "obsidian_read_note_section",
    {
      title: "Read Obsidian Note Section",
      description: "Read an exact Markdown section body through the next heading of equal or lower level. Includes nested headings; ignores code-fence pseudo-headings. Source line bounds describe the full body before truncation.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, heading, occurrence, max_chars: maxChars }) => {
      try {
        const note = await backend.readNote(path);
        const section = readHeadingSection(note.content, heading, occurrence);
        let limit = Math.min(maxChars, section.content.length);
        // String indices count UTF-16 units; retreat when the boundary splits a pair.
        if (limit > 0 && /[\uD800-\uDBFF]/u.test(section.content[limit - 1]!) && /[\uDC00-\uDFFF]/u.test(section.content[limit] ?? "")) limit -= 1;
        const result = {
          path: note.path ?? path,
          ...section,
          content: section.content.slice(0, limit),
          truncated: limit < section.content.length,
          revision: note.revision ?? null,
        };
        return successResult(`Read section "${result.heading}" in ${result.path} (${result.content.length} characters).`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
