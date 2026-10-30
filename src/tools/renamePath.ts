import { z } from "zod";

import { basename, parentPath, renameWithinParent } from "./pathOperations.js";
import { performMovePath } from "./movePath.js";
import type { ToolRegistrar } from "./common.js";
import { errorResult, successResult } from "./common.js";
import { vaultPathSchema } from "../types.js";

const inputSchema = z.object({
  path: vaultPathSchema.describe("Existing path to rename."),
  new_name: z.string().min(1, "new_name is required").describe("New basename for the file or folder."),
  overwrite: z.boolean().default(false),
  expected_revision: z.string().optional().describe("Required when renaming a file."),
  expected_destination_revision: z.string().optional().describe("Required when overwriting an existing destination file."),
});

const outputSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  parentPath: z.string(),
});

export const registerRenamePathTool: ToolRegistrar = (server, client) => {
  server.registerTool(
    "obsidian_rename_path",
    {
      title: "Rename Obsidian Path",
      description: "Rename a file or folder within the same parent folder.",
      inputSchema,
      outputSchema,
    },
    async ({ path, new_name: newName, overwrite, expected_revision: expectedRevision, expected_destination_revision: expectedDestinationRevision }) => {
      try {
        const newPath = renameWithinParent(path, newName);
        const parent = parentPath(path);

        const sourceName = basename(path);
        if (sourceName === newName) {
          // Legacy no-ops stay compatible. A scoped request must still prove
          // move/path rights and the file revision, not just echo a denied path.
          if (client.requestScoped) await performMovePath(client, path, newPath, true, expectedRevision, expectedRevision);
          return successResult(`Path already has the name ${newName}.`, {
            oldPath: path,
            newPath,
            parentPath: parent,
          });
        }
        await performMovePath(client, path, newPath, overwrite, expectedRevision, expectedDestinationRevision);
        return successResult(`Renamed ${path} to ${newPath}.`, {
          oldPath: path,
          newPath,
          parentPath: parent,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
};
