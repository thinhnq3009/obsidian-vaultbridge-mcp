import type { ToolRegistrar } from "./common.js";
import { registerAddCanvasEdgeTool } from "./addCanvasEdge.js";
import { registerAddCanvasNodeTool } from "./addCanvasNode.js";
import { registerAppendToNoteTool } from "./appendToNote.js";
import { registerCreateCanvasTool } from "./createCanvas.js";
import { registerDeleteCanvasTool } from "./deleteCanvas.js";
import { registerDeletePathTool } from "./deletePath.js";
import { registerGetActiveFileTool } from "./getActiveFile.js";
import { registerListFilesTool } from "./listFiles.js";
import { registerMovePathTool } from "./movePath.js";
import { registerOpenFileTool } from "./openFile.js";
import { registerPatchFrontmatterTool } from "./patchFrontmatter.js";
import { registerPatchHeadingTool } from "./patchHeading.js";
import { registerReadNoteSectionTool } from "./readNoteSection.js";
import { registerReadNoteTool } from "./readNote.js";
import { registerReadNoteMetadataTool } from "./readNoteMetadata.js";
import { registerRenamePathTool } from "./renamePath.js";
import { registerRemoveCanvasEdgeTool } from "./removeCanvasEdge.js";
import { registerRemoveCanvasNodeTool } from "./removeCanvasNode.js";
import { registerSearchContentAdvancedTool } from "./searchContentAdvanced.js";
import { registerSearchTool } from "./search.js";
import { registerStatPathTool } from "./statPath.js";
import { registerTreeTool } from "./tree.js";
import { registerReadCanvasTool } from "./readCanvas.js";
import { registerUpdateCanvasEdgeTool } from "./updateCanvasEdge.js";
import { registerUpdateCanvasNodeTool } from "./updateCanvasNode.js";
import { registerUpdateCanvasTool } from "./updateCanvas.js";
import { registerWriteNoteTool } from "./writeNote.js";
import { registerBackendStatusTool } from "./backendStatus.js";
import { registerCreateFolderTool } from "./createFolder.js";
import { registerRebuildSearchIndexTool } from "./rebuildSearchIndex.js";
import { registerVaultHealthTool } from "./vaultHealth.js";
import { registerWriteNotesBulkTool } from "./writeNotesBulk.js";

export const toolRegistrars: ToolRegistrar[] = [
  registerListFilesTool,
  registerReadNoteTool,
  registerReadNoteSectionTool,
  registerReadNoteMetadataTool,
  registerReadCanvasTool,
  registerWriteNoteTool,
  registerWriteNotesBulkTool,
  registerCreateCanvasTool,
  registerUpdateCanvasTool,
  registerDeleteCanvasTool,
  registerAppendToNoteTool,
  registerPatchHeadingTool,
  registerPatchFrontmatterTool,
  registerSearchTool,
  registerSearchContentAdvancedTool,
  registerAddCanvasNodeTool,
  registerUpdateCanvasNodeTool,
  registerRemoveCanvasNodeTool,
  registerAddCanvasEdgeTool,
  registerUpdateCanvasEdgeTool,
  registerRemoveCanvasEdgeTool,
  registerMovePathTool,
  registerRenamePathTool,
  registerDeletePathTool,
  registerStatPathTool,
  registerTreeTool,
  registerCreateFolderTool,
  registerBackendStatusTool,
  registerVaultHealthTool,
  registerRebuildSearchIndexTool,
  registerGetActiveFileTool,
  registerOpenFileTool,
];
