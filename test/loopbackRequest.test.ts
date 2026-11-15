import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { postLoopbackJson } from "./loopbackRequest.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  });
});
async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("file-backed fixture credential transport", () => {
  it("rejects alternate origins and credentials before reaching any listener", async () => {
    let requests = 0;
    const origin = await listen((_request, response) => { requests++; response.end(); });
    const port = new URL(origin).port;
    for (const target of [
      "https://example.invalid/setup",
      "//example.invalid/setup",
      "http://127.0.0.1:1/setup",
      `http://[::1]:${port}/setup`,
      origin.replace("127.0.0.1", "127.0.0.2"),
      origin.replace("127.0.0.1", "localhost"),
      origin.replace("http://", "http://user:password@"),
    ]) {
      await expect(postLoopbackJson(origin, target, { token: "disposable" })).rejects.toThrow("disposable loopback");
    }
    expect(requests).toBe(0);
  });

  it("bypasses proxy environment variables and connects only to the loopback listener", async () => {
    let directRequests = 0;
    let proxyRequests = 0;
    const proxy = await listen((_request, response) => { proxyRequests++; response.end(); });
    const origin = await listen((_request, response) => {
      directRequests++;
      response.end(JSON.stringify({ ok: true }));
    });
    const proxyVariables = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
    const previousValues = new Map(proxyVariables.map((name) => [name, process.env[name]]));

    try {
      process.env.HTTP_PROXY = proxy;
      process.env.HTTPS_PROXY = proxy;
      process.env.ALL_PROXY = proxy;
      delete process.env.NO_PROXY;

      const response = await postLoopbackJson(origin, "/setup", { token: "disposable" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(directRequests).toBe(1);
      expect(proxyRequests).toBe(0);
    } finally {
      for (const [name, value] of previousValues) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not replay credentials to a redirect target", async () => {
    let leaked = 0;
    const sink = await listen((_request, response) => { leaked++; response.end(); });
    const origin = await listen((_request, response) => { response.writeHead(307, { location: `${sink}/capture` }); response.end(); });
    await expect(postLoopbackJson(origin, "/recover-owner", { token: "disposable" })).rejects.toThrow("redirects");
    expect(leaked).toBe(0);
  });

  it("preserves JSON, CSRF headers and separate session cookies", async () => {
    const origin = await listen((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/recover-owner?fixture=1");
      expect(request.headers["x-vaultbridge-csrf"]).toBe("1");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", "set-cookie": ["one=1; HttpOnly", "two=2; HttpOnly"] });
        response.end(Buffer.concat(chunks));
      });
    });
    const result = await postLoopbackJson(origin, "/recover-owner?fixture=1", { token: "disposable" });
    expect(await result.json()).toEqual({ token: "disposable" });
    expect(result.headers.getSetCookie()).toHaveLength(2);
  });
});
