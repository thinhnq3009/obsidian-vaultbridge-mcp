import { z } from "zod";

import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));

const inputSchema = z.object({
  query: z.string().optional(),
  folder: z.string().optional(),
  tag: z.string().optional(),
  regex: z.string().max(256).optional(),
  frontmatter: z.record(z.string(), jsonValueSchema).optional(),
  case_sensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  sort: z.enum(["relevance", "path"]).default("relevance"),
});

const outputSchema = z.object({
  results: z.array(z.object({ path: z.string(), score: z.number().optional(), snippet: z.string().optional() })),
  nextCursor: z.string().optional(),
});

export const registerSearchContentAdvancedTool: ToolRegistrar = (server, backend) => {
  server.registerTool(
    "obsidian_search_content_advanced",
    {
      title: "Advanced Vault Search",
      description: "Search note content, paths, tags, frontmatter, and bounded regular expressions without requiring Obsidian.",
      inputSchema,
      outputSchema,
    },
    async ({ query, folder, tag, regex, frontmatter, case_sensitive: caseSensitive, limit, cursor, sort }) => {
      try {
        const result = await backend.search({
          match: "exact",
          ...(query !== undefined ? { query } : {}), ...(folder !== undefined ? { folder } : {}), ...(tag !== undefined ? { tag } : {}),
          ...(regex !== undefined ? { regex } : {}), ...(frontmatter !== undefined ? { frontmatter } : {}), caseSensitive, limit,
          ...(cursor !== undefined ? { cursor } : {}), sort,
        });
        return successResult(`Found ${result.results.length} advanced search result${result.results.length === 1 ? "" : "s"}.`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
