#!/usr/bin/env node
// ABOUTME: Loopback fake of the Kiro HTTP API (runtime + management) for fake-mode verification.
// ABOUTME: Frames replies as real AWS event-stream binary and logs every request (auth redacted).
//
// Usage: node fake-kiro.mjs <port> <scenario|script.json> <requestLog.jsonl>
//   port 0 picks a free port; the bound URL is printed as `fake-kiro listening <url>`.
//   Built-in scenarios: chat, tool, rate-limit, too-big, stream-error (see SCENARIOS).
//   A script file is a JSON array of replies played in order, one per
//   generateAssistantResponse request; the last reply repeats. Reply shape:
//     {"events":[{"type":"<ChatResponseStream member>","payload":{...}}], "delayMs":0}
//     {"status":429,"body":{...},"headers":{...}}          -> plain HTTP error, JSON body
//     {"exception":{"type":"throttlingError","payload":{...}}} -> exception frame mid-stream
//   Switch scenario on a running fake (resets the reply counter):
//     curl -s -X POST "$FAKE/__verify/scenario?name=tool"
//     curl -s -X POST "$FAKE/__verify/scenario" --data-binary @script.json
//   A text payload may contain {{toolResult}}: replaced by the first tool result text the
//   request carried (proves the round trip reached the fake).
//
// WEAKER THAN LIVE: this proves pi + this provider's request shaping, event-stream decoding,
// thinking/tool/error handling against the documented wire contract. It cannot prove what the
// real Kiro service accepts or answers.

import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { EventStreamCodec } from "@smithy/core/event-streams";

const [portArg, scenarioArg, logFile] = process.argv.slice(2);
if (!portArg || !scenarioArg || !logFile) {
  console.error("usage: fake-kiro.mjs <port> <scenario|script.json> <requestLog.jsonl>");
  process.exit(2);
}

const codec = new EventStreamCodec(
  (b) => new TextDecoder().decode(b),
  (s) => new TextEncoder().encode(s),
);

const FAKE_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:000000000000:profile/VERIFYFAKE";

const usageTail = [
  { type: "metadataEvent", payload: { tokenUsage: { uncachedInputTokens: 1200, outputTokens: 24, totalTokens: 1224 } } },
  { type: "contextUsageEvent", payload: { contextUsagePercentage: 0.12 } },
  { type: "meteringEvent", payload: { usage: 0.05, unit: "credit", unitPlural: "credits" } },
];

const chatReply = {
  events: [
    { type: "reasoningContentEvent", payload: { text: "The user wants a short greeting. " } },
    { type: "reasoningContentEvent", payload: { text: "Answer with the marker." } },
    { type: "assistantResponseEvent", payload: { content: "VERIFY-OK " } },
    { type: "assistantResponseEvent", payload: { content: "hello from fake Kiro" } },
    ...usageTail,
  ],
};

const SCENARIOS = {
  chat: [chatReply],
  tool: [
    {
      events: [
        { type: "assistantResponseEvent", payload: { content: "Running the command." } },
        {
          type: "toolUseEvent",
          payload: { toolUseId: "tooluse_verify_1", name: "bash", input: '{"command":"echo verify-tool-ran"}' },
        },
        { type: "toolUseEvent", payload: { toolUseId: "tooluse_verify_1", name: "bash", stop: true } },
        ...usageTail,
      ],
    },
    {
      events: [
        { type: "assistantResponseEvent", payload: { content: "VERIFY-OK tool said: {{toolResult}}" } },
        ...usageTail,
      ],
    },
  ],
  "rate-limit": [
    {
      status: 429,
      body: { message: "Rate exceeded (fake)", reason: "USER_REQUEST_RATE_EXCEEDED" },
      headers: { "retry-after": "1" },
    },
    chatReply,
  ],
  "too-big": [{ status: 413, body: { message: "Input is too long (fake)", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" } }],
  "stream-error": [
    {
      events: [{ type: "assistantResponseEvent", payload: { content: "partial " } }],
      exception: { type: "throttlingError", payload: { message: "Too many requests (fake)" } },
    },
    chatReply,
  ],
};

function loadScript(nameOrPath) {
  const loaded = SCENARIOS[nameOrPath] ?? JSON.parse(readFileSync(nameOrPath, "utf-8"));
  if (!Array.isArray(loaded) || loaded.length === 0) throw new Error(`unknown scenario or empty script: ${nameOrPath}`);
  return loaded;
}

let scenarioName = scenarioArg;
let script;
try {
  script = loadScript(scenarioArg);
} catch (error) {
  console.error(`fake-kiro: ${error.message}`);
  process.exit(2);
}

const CATALOG = {
  models: [
    { modelId: "claude-sonnet-4.6", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } },
    { modelId: "claude-haiku-4.5", tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } },
    { modelId: "auto", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } },
  ],
};

let served = 0;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|token|cookie|secret/i.test(k) ? `[REDACTED len=${String(v).length}]` : v;
  }
  return out;
}

function log(entry) {
  appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function frame(key, payload) {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: key },
      ":message-type": { type: "string", value: "event" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

function exceptionFrame(key, payload) {
  return codec.encode({
    headers: {
      ":exception-type": { type: "string", value: key },
      ":message-type": { type: "string", value: "exception" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

function firstToolResultText(body) {
  const results = body?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults;
  const first = Array.isArray(results) ? results[0] : undefined;
  const text = first?.content?.map?.((c) => c.text ?? (c.json ? JSON.stringify(c.json) : "")).join("") ?? "";
  return text.trim();
}

function fill(payload, body) {
  const json = JSON.stringify(payload).replaceAll("{{toolResult}}", JSON.stringify(firstToolResultText(body)).slice(1, -1));
  return JSON.parse(json);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(req, res, body) {
  const reply = script[Math.min(served, script.length - 1)];
  served++;
  if (reply.status && reply.status !== 200) {
    res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
    res.end(JSON.stringify(reply.body ?? {}));
    return { status: reply.status };
  }
  res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
  for (const ev of reply.events ?? []) {
    if (reply.delayMs) await sleep(reply.delayMs);
    res.write(frame(ev.type, fill(ev.payload, body)));
  }
  if (reply.exception) res.write(exceptionFrame(reply.exception.type, reply.exception.payload));
  res.end();
  return { status: 200, events: (reply.events ?? []).map((e) => e.type), exception: reply.exception?.type };
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = { unparsed: raw.slice(0, 2000) };
  }
  const url = new URL(req.url ?? "/", "http://fake");
  const entry = {
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    originalHost: req.headers["x-verify-original-host"],
    headers: redactHeaders(req.headers),
    body,
  };

  try {
    if (url.pathname === "/__verify/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenario: scenarioName, served, pid: process.pid }));
      return;
    }
    if (url.pathname === "/__verify/scenario" && req.method === "POST") {
      // ?name=<built-in> or a JSON array body; resets the reply counter.
      const name = url.searchParams.get("name");
      script = name ? loadScript(name) : Array.isArray(body) ? body : loadScript("");
      scenarioName = name ?? "posted-script";
      served = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenario: scenarioName, replies: script.length }));
      return;
    }
    if (url.pathname === "/generateAssistantResponse") {
      entry.reply = await generate(req, res, body);
    } else if (url.pathname === "/List-Available-Models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
    } else if (url.pathname === "/List-Available-Profiles") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ profiles: [{ arn: FAKE_PROFILE_ARN }] }));
    } else if (url.pathname === "/refreshToken") {
      // Kiro desktop (social) refresh. Dummy values only; rotates the refresh token like the
      // real service may, so a write-back to the scratch kiro-cli DB is observable.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          accessToken: "aoaVERIFYREFRESHEDACCESS000000000000000000000000000",
          refreshToken: "aorVERIFYROTATEDREFRESH0000000000000000000000000000",
          expiresIn: 3600,
          profileArn: FAKE_PROFILE_ARN,
        }),
      );
    } else if (url.pathname === "/Get-Usage-Limits") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usageBreakdownList: [], subscriptionInfo: { subscriptionTitle: "FAKE" } }));
    } else if (req.headers["x-amz-target"] === "AmazonCodeWhispererService.GetProfile") {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      res.end(JSON.stringify({ profile: { arn: FAKE_PROFILE_ARN } }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `fake-kiro: no route for ${req.method} ${url.pathname}` }));
      entry.reply = { status: 404 };
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `fake-kiro: ${error.message}` }));
    entry.reply = { status: 400, error: error.message };
  } finally {
    if (!url.pathname.startsWith("/__verify/")) log(entry);
  }
});

server.listen(Number(portArg), "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`fake-kiro listening http://127.0.0.1:${port} scenario=${scenarioArg}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
