import { z } from "zod";

import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";
import { vaultPathSchema } from "../types.js";

const inputSchema = z.object({
  path: vaultPathSchema.describe("Markdown note path to inspect."),
});

const outputSchema = z.object({
  path: z.string(),
  tags: z.array(z.string()),
  frontmatter: z.record(z.string(), z.unknown()),
  stat: z
    .object({
      ctime: z.number().optional(),
      mtime: z.number().optional(),
      size: z.number().optional(),
    })
    .nullable(),
  headings: z.array(z.object({ text: z.string(), level: z.number().int() })).optional(),
  links: z.array(z.string()).optional(),
  revision: z.string().optional(),
});

export const registerReadNoteMetadataTool: ToolRegistrar = (server, client) => {
  server.registerTool(
    "obsidian_read_note_metadata",
    {
      title: "Read Obsidian Note Metadata",
      description: "Read note metadata, including frontmatter, tags, stat fields, and backend-supported headings, links, and revision, without returning the full body.",
      inputSchema,
      outputSchema,
    },
    async ({ path }) => {
      try {
        const metadata = await client.readNoteMetadata(path);
        return successResult(`Read metadata for ${metadata.path}.`, {
          path: metadata.path,
          tags: metadata.tags,
          frontmatter: metadata.frontmatter,
          stat: metadata.stat,
          ...(metadata.headings !== undefined ? { headings: metadata.headings } : {}),
          ...(metadata.links !== undefined ? { links: metadata.links } : {}),
          ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
