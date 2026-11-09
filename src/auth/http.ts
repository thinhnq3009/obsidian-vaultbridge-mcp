import http from "node:http";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import express from "express";
import { MemoryStore, rateLimit } from "express-rate-limit";
import { z } from "zod";

import { createOwnerAuth, type OwnerAuth } from "./owner.js";
import { ownerHtml, ownerScript } from "./ui.js";
import type { OAuthProviderOptions } from "./oauth.js";

/** No proxy support: bind to literal IPv4 loopback, validate TCP peer and exact Host. */
export function isOwnerRequestAllowed(peer: string | undefined, host: string | undefined, origin: string | undefined, expectedOrigin: string): boolean {
  const expected = new URL(expectedOrigin);
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") && host === expected.host && (origin === undefined || origin === expectedOrigin);
}

type OwnerUiMode = "legacy" | "react";

export async function startOwnerServer(options: { directory: string; vaultPath: string; port: number; ownerUsername?: string; ownerPassword?: string; recover?: boolean; maxFailures?: number; windowSeconds?: number; ownerUiMode?: OwnerUiMode; ownerUiDirectory?: string; oauth?: Omit<OAuthProviderOptions, "ownerOrigin"> }) {
  z.number().int().min(0).max(65535).parse(options.port);
  let owner: OwnerAuth | undefined;
  let origin = "";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const limiterStore = new MemoryStore();
  const ownerUiDirectory = options.ownerUiDirectory ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    import.meta.url.includes(`${path.sep}dist${path.sep}auth${path.sep}`) ? ".." : "../../dist",
    "owner-ui",
  );
  app.use((request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    });
    if (!owner) { response.sendStatus(503); return; }
    // The public provider must be able to navigate a browser to the static
    // owner login/consent shell. Never allow cross-site fetches, iframe loads,
    // API reads, mutations or arbitrary owner pages through this exception.
    const oauthNavigation = request.method === "GET"
      && ["/login", "/consent"].includes(request.path)
      && request.headers["sec-fetch-mode"] === "navigate"
      && request.headers["sec-fetch-dest"] === "document";
    if (!isOwnerRequestAllowed(request.socket.remoteAddress, request.headers.host, request.headers.origin, origin)
      || (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])) && !oauthNavigation)) {
      response.sendStatus(403); return;
    }
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") { response.sendStatus(415); return; }
    if (!["GET", "POST"].includes(request.method)) { response.sendStatus(405); return; }
    // Exact Origin AND non-simple custom header AND JSON are required, even for first login.
    if (request.method === "POST" && (request.headers.origin !== origin || request.headers["x-vaultbridge-csrf"] !== "1" || !request.is("application/json"))) {
      response.sendStatus(403); return;
    }
    next();
  });
  app.use(rateLimit({
    windowMs: 60000, limit: 120,
    keyGenerator: () => "owner-listener", // One bounded entry; never spoofable headers.
    store: limiterStore,
    standardHeaders: "draft-8", legacyHeaders: false,
  }));
  app.use(express.json({ limit: "8kb", inflate: false, strict: true }));
  async function sendOwnerUiAsset(relativePath: string, response: Response): Promise<void> {
    if (relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
      response.sendStatus(404);
      return;
    }
    const isEntry = relativePath === "owner.html";
    const isAsset = /^assets\/[A-Za-z0-9._-]+\.(?:js|css|png|svg|woff2?)$/u.test(relativePath);
    if (!isEntry && !isAsset) {
      response.sendStatus(404);
      return;
    }
    try {
      const root = await realpath(ownerUiDirectory);
      const file = await realpath(path.join(root, relativePath));
      if (!file.startsWith(`${root}${path.sep}`)) {
        response.sendStatus(404);
        return;
      }
      const expected = await lstat(file);
      if (!expected.isFile() || expected.isSymbolicLink()) {
        response.sendStatus(404);
        return;
      }
      const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
          response.sendStatus(404);
          return;
        }
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      const mime = relativePath.endsWith(".html") ? "text/html; charset=utf-8"
        : relativePath.endsWith(".js") ? "text/javascript; charset=utf-8"
          : relativePath.endsWith(".css") ? "text/css; charset=utf-8"
            : relativePath.endsWith(".png") ? "image/png"
              : relativePath.endsWith(".svg") ? "image/svg+xml"
                : relativePath.endsWith(".woff") ? "font/woff" : "font/woff2";
      response.set("Content-Type", mime).send(content);
    } catch {
      response.status(503).type("text/plain").send("Owner UI bundle unavailable. Build the package or select legacy mode.");
    }
  }
  if (options.ownerUiMode === "react") {
    app.get(["/login", "/recover"], async (_request, response) => { await sendOwnerUiAsset("owner.html", response); });
    app.get("/assets/*asset", async (request, response) => {
      const asset = request.params.asset;
      const relativePath = Array.isArray(asset) ? asset.join("/") : asset;
      await sendOwnerUiAsset(`assets/${relativePath}`, response);
    });
  }
  app.get(["/", "/admin", "/consent", ...(options.ownerUiMode === "react" ? [] : ["/login", "/recover"])], (_request, response) => {
    response.type("html").send(ownerHtml);
  });
  app.get("/owner.js", (_request, response) => { response.type("js").send(ownerScript); });
  let recoveryComplete = false;
  app.get("/owner-state", (_request, response) => { response.json({ hasOwner: owner!.hasOwner(), recovering: owner!.recovering && !recoveryComplete }); });
  app.post("/recover-owner", async (request: Request<Record<string, string>, unknown, unknown>, response) => {
    if (!owner!.recovering || recoveryComplete) { response.sendStatus(404); return; }
    const body = z.object({ token: z.string().max(128), password: z.string() }).strict().safeParse(request.body);
    if (!body.success) { response.sendStatus(400); return; }
    const { token, ...input } = body.data;
    if (!await owner!.recoverPassword(input, token)) { response.status(400).json({ error: "Recovery rejected" }); return; }
    recoveryComplete = true;
    response.json({ success: true });
  });
  app.use(async (request: Request<Record<string, string>, unknown, unknown>, response) => {
    const url = new URL(request.originalUrl, origin);
    if (url.origin !== origin || (!url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/oauth/"))) { response.sendStatus(404); return; }
    const headers = new Headers();
    for (const name of ["cookie", "content-type", "origin", "sec-fetch-site", "x-vaultbridge-csrf"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const result = await owner!.handle(new globalThis.Request(url, {
      method: request.method, headers,
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
    }), request.socket.remoteAddress!);
    response.status(result.status);
    result.headers.forEach((value, name) => { if (name !== "set-cookie") response.setHeader(name, value); });
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader("Set-Cookie", cookies);
    response.send(Buffer.from(await result.arrayBuffer()));
  });
  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    void _next;
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : 500;
    response.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: "Owner request rejected" });
  });
  const server = http.createServer({ maxHeaderSize: 8192 }, app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 100;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owner listener address unavailable");
    origin = `http://127.0.0.1:${String(address.port)}`;
    owner = await createOwnerAuth({ ...options, origin });
    return {
      origin,
      tokenPath: owner.tokenPath,
      owner,
      async close() {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve(); });
          server.closeIdleConnections();
        });
        limiterStore.shutdown();
        await owner!.close();
      },
    };
  } catch (error) {
    limiterStore.shutdown();
    server.close();
    await owner?.close();
    throw error;
  }
}
