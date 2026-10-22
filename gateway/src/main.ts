// kiro-gateway entry point.
//
// Wraps the provider's streamKiro() (the exact function the pi extension
// runs) behind an Anthropic Messages API surface for Claude Code / cc-switch.
//
// Env:
//   GATEWAY_PORT   listen port (default 8990)
//   GATEWAY_HOST   listen host (default 127.0.0.1)
//   KIRO_API_KEY   fallback ksk_ key when the client sends a placeholder
//   PROXY_API_KEY  optional local gate token; clients sending it use KIRO_API_KEY

import { streamKiro } from "../../src/stream.js";
import { createGatewayServer, type StreamFn } from "./server.js";

export { createGatewayServer };

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8990);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const fallbackToken = process.env.KIRO_API_KEY;
  const gateToken = process.env.PROXY_API_KEY;
  const server = createGatewayServer({
    streamFn: streamKiro as unknown as StreamFn,
    fallbackToken,
    gateToken,
  });
  server.listen(port, host, () => {
    console.log(`[kiro-gateway] listening on http://${host}:${port} (POST /v1/messages, GET /v1/models, GET /health)`);
  });
}
