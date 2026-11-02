import { randomUUID } from "node:crypto";

import type { RequestHandler, Response } from "express";

import type { AppConfig } from "./types.js";

type HttpStage = "host_validation" | "issuer_host" | "origin_validation" | "request_budget"
  | "authentication" | "content_encoding" | "oauth_budget" | "oauth_body" | "oauth_provider"
  | "mcp_body" | "grant_authorization" | "mcp_transport" | "unmatched_route";

/** Fixed route labels and categories only: never log raw request-controlled data. */
export function createHttpDiagnostics(config: AppConfig) {
  const states = new WeakMap<Response, { stage: HttpStage }>();
  const canonicalHost = config.mcpOauthIssuer ? new URL(config.mcpOauthIssuer).host : undefined;
  const routes = new Set([
    config.mcpHttpPath,
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${config.mcpHttpPath}`,
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration",
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/revoke",
    "/api/auth/oauth2/register",
  ]);
  const observe: RequestHandler = (request, response, next) => {
    const id = randomUUID();
    const startedAt = performance.now();
    const state: { stage: HttpStage } = { stage: "host_validation" };
    states.set(response, state);
    response.setHeader("X-VaultBridge-Request-Id", id);
    const route = routes.has(request.path) ? request.path : "<unmatched>";
    const method = ["GET", "POST", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"].includes(request.method) ? request.method : "<other>";
    const host = !request.headers.host ? "missing" : request.headers.host === canonicalHost ? "canonical"
      : ["127.0.0.1", "localhost", "[::1]"].includes(request.hostname) ? "loopback"
        : config.mcpAllowedHosts?.includes(request.hostname) ? "allowed" : "unexpected";
    const origin = request.headers.origin === undefined ? "absent" : "present";
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      const status = response.writableFinished ? String(response.statusCode) : "aborted";
      process.stderr.write(`[obsidian-vault-mcp] http request=${id} time=${new Date().toISOString()} method=${method} route=${route} host=${host} origin=${origin} status=${status} stage=${state.stage} duration=${Math.round(performance.now() - startedAt)}ms\n`);
    };
    response.once("finish", log);
    response.once("close", log);
    next();
  };
  return {
    observe,
    stage(response: Response, stage: HttpStage) {
      const state = states.get(response);
      if (state) state.stage = stage;
    },
  };
}
