import { describe, expect, it, vi } from "vitest";

import type { VaultBackend } from "../src/backend/types.js";
import {
  addCanvasEdge,
  addCanvasNode,
  canvasDocumentSchema,
  canvasPathSchema,
  parseCanvasDocument,
  removeCanvasNode,
  updateCanvasEdge,
  updateCanvasNode,
} from "../src/tools/canvasCommon.js";
import { registerCreateCanvasTool } from "../src/tools/createCanvas.js";

type ToolResult = { structuredContent?: Record<string, unknown> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type RegisterToolMock = ReturnType<typeof vi.fn> & { mock: { calls: Array<[unknown, unknown, ToolHandler]> } };

describe("canvasPathSchema", () => {
  it("requires a .canvas suffix", () => {
    expect(() => canvasPathSchema.parse("Maps/Plan.md")).toThrow(/\.canvas/i);
  });
});

describe("canvas document validation", () => {
  it("accepts a valid seeded canvas", () => {
    const canvas = canvasDocumentSchema.parse({
      nodes: [
        { id: "n1", type: "file", file: "Projects/Plan.md", x: 0, y: 0, width: 400, height: 240 },
        { id: "n2", type: "text", text: "Next", x: 500, y: 0, width: 320, height: 160 },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
    });

    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.edges).toHaveLength(1);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        nodes: [
          { id: "n1", type: "text", text: "A", x: 0, y: 0, width: 200, height: 100 },
          { id: "n1", type: "text", text: "B", x: 250, y: 0, width: 200, height: 100 },
        ],
        edges: [],
      }),
    ).toThrow(/duplicate node id/i);
  });

  it("rejects dangling edge references", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        nodes: [{ id: "n1", type: "text", text: "A", x: 0, y: 0, width: 200, height: 100 }],
        edges: [{ id: "e1", fromNode: "n1", toNode: "missing" }],
      }),
    ).toThrow(/missing tonode/i);
  });

  it("rejects invalid background style", () => {
    expect(() =>
      parseCanvasDocument(
        JSON.stringify({
          nodes: [{ id: "g1", type: "group", x: 0, y: 0, width: 400, height: 400, backgroundStyle: "stretch" }],
          edges: [],
        }),
        "Maps/Invalid.canvas",
      ),
    ).toThrow(/backgroundstyle/i);
  });
});

describe("canvas mutations", () => {
  const baseCanvas = canvasDocumentSchema.parse({
    nodes: [
      { id: "n1", type: "file", file: "Projects/Plan.md", x: 0, y: 0, width: 400, height: 240 },
      { id: "n2", type: "text", text: "Draft", x: 500, y: 0, width: 320, height: 160 },
    ],
    edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "next" }],
  });

  it("adds nodes", () => {
    const canvas = addCanvasNode(baseCanvas, {
      id: "n3",
      type: "link",
      url: "https://example.com",
      x: 900,
      y: 0,
      width: 300,
      height: 160,
    });

    expect(canvas.nodes.some((node) => node.id === "n3")).toBe(true);
  });

  it("updates file node fields partially", () => {
    const canvas = updateCanvasNode(baseCanvas, "n1", {
      x: 50,
      subpath: "#Next Steps",
      color: "4",
    });
    const node = canvas.nodes.find((candidate) => candidate.id === "n1");

    expect(node).toMatchObject({
      id: "n1",
      x: 50,
      subpath: "#Next Steps",
      color: "4",
    });
  });

  it("removes node and connected edges", () => {
    const canvas = removeCanvasNode(baseCanvas, "n1");

    expect(canvas.nodes.some((node) => node.id === "n1")).toBe(false);
    expect(canvas.edges).toHaveLength(0);
  });

  it("adds edges only when nodes exist", () => {
    const canvas = addCanvasEdge(baseCanvas, {
      id: "e2",
      fromNode: "n2",
      toNode: "n1",
      toSide: "left",
    });

    expect(canvas.edges.some((edge) => edge.id === "e2")).toBe(true);
  });

  it("rejects edges pointing to missing nodes", () => {
    expect(() =>
      addCanvasEdge(baseCanvas, {
        id: "e2",
        fromNode: "n2",
        toNode: "missing",
      }),
    ).toThrow(/missing tonode/i);
  });

  it("updates edge fields", () => {
    const canvas = updateCanvasEdge(baseCanvas, "e1", {
      fromSide: "right",
      toSide: "left",
      label: "blocks",
    });
    const edge = canvas.edges.find((candidate) => candidate.id === "e1");

    expect(edge).toMatchObject({
      id: "e1",
      fromSide: "right",
      toSide: "left",
      label: "blocks",
    });
  });
});

describe("canvas tool metadata", () => {
  it("describes JSON Canvas format in the create tool", () => {
    const registerTool = vi.fn();
    const fakeServer = { registerTool };
    const fakeClient = {} as VaultBackend;

    registerCreateCanvasTool(fakeServer as never, fakeClient);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const firstCall = registerTool.mock.calls[0];
    if (!firstCall) {
      throw new Error("registerTool was not called");
    }

    const metadata = firstCall[1] as { description: string };
    expect(metadata.description).toContain("JSON Canvas");
    expect(metadata.description).toContain("nodes and edges");
    expect(metadata.description).toContain("\"type\":\"file\"");
  });

  it("creates a new canvas path instead of requiring an existing file", async () => {
    const writeFile = vi.fn(() => Promise.resolve({ path: "Maps/New.canvas", message: "created", revision: "sha256:test" }));
    const fakeClient = {
      statPath: vi.fn(() => Promise.resolve({ path: "Maps/New.canvas", exists: false, kind: "missing", size: null, ctime: null, mtime: null, revision: null })),
      writeFile,
    } as unknown as VaultBackend;
    const registerTool = vi.fn() as RegisterToolMock;

    registerCreateCanvasTool({ registerTool } as never, fakeClient);
    const handler = registerTool.mock.calls[0]?.[2];
    if (typeof handler !== "function") {
      throw new Error("registerTool handler was not registered");
    }

    const result = await handler({ path: "Maps/New.canvas", nodes: [], edges: [], open_after_create: false, overwrite: false });

    expect(writeFile).toHaveBeenCalledWith("Maps/New.canvas", expect.any(String), {
      contentType: "application/json; charset=utf-8",
      mode: "create",
    });
    expect(result.structuredContent).toMatchObject({ path: "Maps/New.canvas", nodeCount: 0, edgeCount: 0 });
  });
});
