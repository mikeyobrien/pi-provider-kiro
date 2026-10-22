// Gateway HTTP server: Anthropic Messages API surface backed by streamKiro().
//
// Deliberately dependency-free (node:http only). The stream function is
// injectable so the smoke tests can drive the whole adapter stack with a
// fake pi event stream and no Kiro credentials.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { kiroModels } from "../../src/models.js";
import { countTokens } from "../../src/tokenizer.js";
import { anthropicToPiContext, contextToText, type AnthropicRequest } from "./convert-in.js";
import {
  AnthropicStreamWriter,
  anthropicErrorBody,
  errorTypeFor,
  PreOutputError,
  toAnthropicMessage,
} from "./convert-out.js";

export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: Record<string, unknown>,
) => AssistantMessageEventStream;

export interface GatewayOptions {
  streamFn: StreamFn;
  /** Fallback Kiro key when the client sends a non-ksk placeholder token. */
  fallbackToken?: string;
  /** Optional local gate: if set, requests must carry this token (any shape). */
  gateToken?: string;
  log?: (msg: string) => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function clientToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key : undefined;
}

export function createGatewayServer(opts: GatewayOptions): Server {
  const log = opts.log ?? ((m: string) => console.log(m));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok", models: kiroModels.length });
      }

      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return sendJson(res, 200, {
          data: kiroModels.map((m) => ({
            type: "model",
            id: m.id,
            display_name: m.name,
            created_at: "2026-01-01T00:00:00Z",
            max_input_tokens: m.contextWindow,
            max_tokens: m.maxTokens,
          })),
          has_more: false,
          first_id: kiroModels[0]?.id,
          last_id: kiroModels[kiroModels.length - 1]?.id,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = JSON.parse((await readBody(req)) || "{}") as AnthropicRequest;
        const { context } = anthropicToPiContext(body);
        return sendJson(res, 200, { input_tokens: Math.max(1, countTokens(contextToText(context))) });
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        return await handleMessages(req, res, opts, log);
      }

      return sendJson(res, 404, anthropicErrorBody(`not found: ${req.method} ${url.pathname}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) return sendJson(res, 500, anthropicErrorBody(message));
      res.end();
    }
  });
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, opts: GatewayOptions, log: (m: string) => void) {
  const raw = await readBody(req);
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw) as AnthropicRequest;
  } catch {
    return sendJson(res, 400, anthropicErrorBody("request body is not valid JSON"));
  }

  // Credential resolution: a ksk_ token from the client wins (that is the
  // cc-switch UX — the key lives in the provider form like any API key).
  // A placeholder token falls back to the gateway's own KIRO_API_KEY.
  const token = clientToken(req);
  let apiKey: string | undefined;
  if (token?.startsWith("ksk_")) apiKey = token;
  else if (opts.gateToken && token === opts.gateToken) apiKey = opts.fallbackToken;
  else if (!opts.gateToken && token && !token.startsWith("ksk_")) apiKey = opts.fallbackToken ?? token;
  if (!apiKey) {
    return sendJson(res, 401, anthropicErrorBody("no Kiro API key: send a ksk_ token or configure KIRO_API_KEY"));
  }

  const { context, model, reasoning, sessionId } = anthropicToPiContext(body);
  const estimatedInputTokens = Math.max(1, countTokens(contextToText(context)));
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  const streamOptions: Record<string, unknown> = {
    apiKey,
    signal: abort.signal,
    ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  const events = opts.streamFn(model as Model<Api>, context, streamOptions);
  const requestedModel = body.model ?? model.id;

  if (!body.stream) {
    // Non-streaming: drain the pi stream and aggregate the final message.
    try {
      const final = await events.result();
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        const message = final.errorMessage ?? "Kiro request failed";
        const { status } = errorTypeFor(message);
        return sendJson(res, status, anthropicErrorBody(message));
      }
      const id = `msg_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
      return sendJson(res, 200, toAnthropicMessage(final, requestedModel, estimatedInputTokens, id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { status } = errorTypeFor(message);
      return sendJson(res, status, anthropicErrorBody(message));
    }
  }

  // Streaming: headers are held until the first pi event so a pre-output
  // error can still become a proper HTTP error response.
  const writer = new AnthropicStreamWriter(
    (chunk) => {
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      }
      res.write(chunk);
    },
    requestedModel,
    estimatedInputTokens,
  );
  // SSE comment heartbeat so Claude Code does not idle-timeout during Kiro's
  // long first-token waits (Opus firstTokenTimeout is 180s in the catalog).
  const heartbeat = setInterval(() => {
    if (res.headersSent && !writer.isFinished) res.write(": ping\n\n");
  }, 15000);
  try {
    for await (const event of events) {
      try {
        writer.handle(event);
      } catch (error) {
        if (error instanceof PreOutputError) {
          const { status } = errorTypeFor(error.message);
          if (!res.headersSent) return sendJson(res, status, anthropicErrorBody(error.message));
          res.end();
          return;
        }
        throw error;
      }
    }
    if (!writer.isFinished && !res.writableEnded) {
      log("[kiro-gateway] stream ended without terminal event");
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
