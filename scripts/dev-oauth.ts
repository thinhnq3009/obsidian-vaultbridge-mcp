import { startHttpServer } from "../src/http.js";
import { createDevOauthConfig } from "./dev-oauth-config.js";

async function main(): Promise<void> {
  const config = createDevOauthConfig(process.env, process.argv.slice(2));
  const server = await startHttpServer(config);
  const publicOrigin = new URL(config.mcpOauthIssuer!).origin;
  process.stderr.write(`[vaultbridge] OAuth dev MCP: ${publicOrigin}${config.mcpHttpPath}\n`);
  process.stderr.write(`[vaultbridge] Local-only owner login: ${server.ownerOrigin}/login\n`);
  process.stderr.write("[vaultbridge] Experimental OAuth: grant-family revocation limitation #60 remains. Do not use this as a production deployment.\n");
  let closing = false;
  function shutdown(): void {
    if (closing) return;
    closing = true;
    server.close();
    void server.closed.catch(() => { process.exitCode = 1; });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[vaultbridge] OAuth dev failed: ${message}\n`);
  process.exitCode = 1;
});
