import http from "node:http";

/** Fixture credentials can only reach this exact numeric loopback listener.
 * Direct HTTP avoids environment proxy configuration; redirects are errors.
 */
export async function postLoopbackJson(origin: string, route: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const base = new URL(origin);
  const target = new URL(route, base);
  if (base.origin !== origin || target.protocol !== "http:" || target.hostname !== "127.0.0.1"
    || target.origin !== origin || target.username || target.password) {
    throw new Error("Owner test requests must stay on their disposable loopback listener");
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port: target.port, path: target.pathname + target.search,
      method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin, "X-VaultBridge-CSRF": "1", ...extraHeaders,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) { reject(new Error("Owner test requests cannot follow redirects")); return; }
        const headers = new Headers();
        for (const [name, values] of Object.entries(response.headersDistinct)) {
          for (const value of values ?? []) headers.append(name, value);
        }
        resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.setTimeout(5000, () => { request.destroy(new Error("Owner test request timed out")); });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
