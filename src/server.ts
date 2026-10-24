import { readFileSync } from "node:fs";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { FilesystemVaultBackend } from "./backend/filesystem.js";
import { LocalRestBackend } from "./backend/localRest.js";
import type { VaultBackend } from "./backend/types.js";
import { toolRegistrars } from "./tools/index.js";
import type { AppConfig } from "./types.js";

export type ApplicationContext = { backend: VaultBackend; close(): Promise<void> };
type ToolInputSchema = undefined | ZodRawShapeCompat | AnySchema;
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export async function createApplication(config: AppConfig): Promise<ApplicationContext> {
  const backend: VaultBackend = config.backend === "local-rest" ? new LocalRestBackend(config) : new FilesystemVaultBackend(config);
  await backend.initialize();
  return { backend, close: () => backend.close() };
}

type McpServerOptions = { colorfulLogs?: boolean };

export function createMcpServer(backend: VaultBackend, options: McpServerOptions = {}) {
  const identity = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const server = new McpServer({ name: identity.name, version: identity.version });
  installToolCallLogging(server, options);
  for (const registerTool of toolRegistrars) registerTool(server, backend);
  return server;
}

export async function createServer(config: AppConfig, options: { application?: ApplicationContext } = {}) {
  const application = options.application ?? await createApplication(config);
  return { server: createMcpServer(application.backend, { colorfulLogs: config.colorfulLogs }), backend: application.backend, application };
}

function installToolCallLogging(server: McpServer, options: McpServerOptions): void {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => registerTool(name, config, wrapToolCallback(name, callback, options))) as McpServer["registerTool"];
}

function wrapToolCallback<InputArgs extends ToolInputSchema>(toolName: string, callback: ToolCallback<InputArgs>, options: McpServerOptions): ToolCallback<InputArgs> {
  const wrapped = async (...args: Parameters<ToolCallback<InputArgs>>): Promise<CallToolResult> => {
    const startedAt = Date.now();
    const { input, extra } = extractToolCallArgs(args);
    const inputBytes = jsonByteLength(input);
    try {
      const invoke = callback as (...invokeArgs: Parameters<ToolCallback<InputArgs>>) => CallToolResult | Promise<CallToolResult>;
      const result = await invoke(...args);
      const error = result.isError === true ? errorSummaryFromResult(result) : undefined;
      writeToolLog({ toolName, extra, inputBytes, outputBytes: jsonByteLength(result), durationMs: Date.now() - startedAt, status: result.isError === true ? "error" : "ok", colorful: options.colorfulLogs === true, ...(error ? { error } : {}) });
      return result;
    } catch (error) {
      writeToolLog({ toolName, extra, inputBytes, outputBytes: 0, durationMs: Date.now() - startedAt, status: "error", colorful: options.colorfulLogs === true, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  return wrapped as ToolCallback<InputArgs>;
}

function extractToolCallArgs(args: readonly unknown[]): { input: unknown; extra: Partial<ToolExtra> | undefined } {
  const maybeExtra = args.length > 1 ? args[1] : args[0];
  return {
    input: args.length > 1 ? args[0] : undefined,
    extra: isRecord(maybeExtra) ? maybeExtra as Partial<ToolExtra> : undefined,
  };
}

function writeToolLog(event: { toolName: string; extra: Partial<ToolExtra> | undefined; inputBytes: number; outputBytes: number; durationMs: number; status: "ok" | "error"; colorful: boolean; error?: string }): void {
  const caller = callerFields(event.extra);
  const fields = [
    colorize("[obsidian-vault-mcp]", "cyan", event.colorful),
    `tool=${colorize(event.toolName, "magenta", event.colorful)}`,
    ...caller,
    `in=${event.inputBytes}B`,
    `out=${event.outputBytes}B`,
    colorize(event.status, event.status === "ok" ? "green" : "red", event.colorful),
    colorize(`${event.durationMs}ms`, "yellow", event.colorful),
  ];
  if (event.error) fields.push(`error=${formatField(event.error, 120)}`);
  process.stderr.write(`${fields.join(" ")}\n`);
}

function colorize(value: string, color: "cyan" | "green" | "magenta" | "red" | "yellow", enabled: boolean): string {
  if (!enabled) return value;
  const codes = { cyan: 36, green: 32, magenta: 35, red: 31, yellow: 33 } as const;
  return `\u001B[${String(codes[color])}m${value}\u001B[0m`;
}

function callerFields(extra: Partial<ToolExtra> | undefined): string[] {
  const requestInfo = extra?.requestInfo;
  const headers = requestInfo?.headers;
  const fields = [`caller=${requestInfo ? "http" : "stdio"}`];
  const host = headers ? headerValue(headers, "host") : undefined;
  const origin = headers ? headerValue(headers, "origin") : undefined;
  const userAgent = headers ? headerValue(headers, "user-agent") : undefined;
  const requestId = extra?.requestId;
  if (host) fields.push(`host=${formatField(host, 80)}`);
  if (origin) fields.push(`origin=${formatField(origin, 80)}`);
  if (userAgent) fields.push(`ua=${formatField(userAgent, 80)}`);
  if (extra?.sessionId) fields.push(`session=${formatField(extra.sessionId, 40)}`);
  if (requestId !== undefined) fields.push(`request=${formatField(String(requestId), 40)}`);
  return fields;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = match?.[1];
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function errorSummaryFromResult(result: CallToolResult): string | undefined {
  const text = result.content.find((item) => item.type === "text")?.text;
  return text ? text.replace(/\s+/gu, " ").trim() : undefined;
}

function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function formatField(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, "_");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
