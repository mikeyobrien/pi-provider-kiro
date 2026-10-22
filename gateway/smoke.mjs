// Smoke tests for kiro-gateway: drives the REAL gateway server + adapter
// stack with a FAKE pi event stream (no Kiro credentials needed), plus the
// auth/error mapping paths. Run: node gateway/smoke.mjs
// For a REAL end-to-end check with a live ksk_ key, use gateway/smoke-live.mjs.

import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createGatewayServer } from "./dist/main.js";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function baseMessage() {
  return {
    role: "assistant",
    content: [],
    api: "kiro-api",
    provider: "kiro",
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function fakeStreamFn(model, context) {
  const stream = new AssistantMessageEventStream();
  const lastText = JSON.stringify(context.messages);
  const wantError = lastText.includes("FORCE_ERROR");
  queueMicrotask(() => {
    if (wantError) {
      const msg = baseMessage();
      msg.stopReason = "error";
      msg.errorMessage = "403 Invalid token: the bearer token was rejected";
      stream.push({ type: "error", reason: "error", error: msg });
      stream.end(msg);
      return;
    }
    const partial = baseMessage();
    stream.push({ type: "start", partial });
    partial.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello ", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "world", partial });
    partial.content[0].text = "Hello world";
    stream.push({ type: "text_end", contentIndex: 0, content: "Hello world", partial });
    const toolCall = { type: "toolCall", id: "tooluse_smoke1", name: "get_weather", arguments: { city: "Shanghai" } };
    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 1, partial });
    stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"city":"Shanghai"}', partial });
    stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial });
    const final = baseMessage();
    final.content = partial.content;
    final.stopReason = "toolUse";
    final.usage = { input: 1234, output: 56, cacheRead: 0, cacheWrite: 0, totalTokens: 1290, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    stream.push({ type: "done", reason: "toolUse", message: final });
    stream.end(final);
  });
  return stream;
}

const server = createGatewayServer({ streamFn: fakeStreamFn, log: () => {} });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: "Bearer <redacted>", "Content-Type": "application/json" };

try {
  // 1. health
  const health = await (await fetch(`${base}/health`)).json();
  check("health", health.status === "ok", `${health.models} models`);

  // 2. models
  const models = await (await fetch(`${base}/v1/models`)).json();
  check("models list", models.data.some((m) => m.id === "claude-sonnet-4-6"), `${models.data.length} models`);

  // 3. count_tokens
  const ct = await (
    await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "count these tokens please" }] }),
    })
  ).json();
  check("count_tokens", ct.input_tokens > 0, `input_tokens=${ct.input_tokens}`);

  const reqBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: "You are helpful.",
    tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [
      { role: "user", content: "Weather in Shanghai?" },
      { role: "assistant", content: [{ type: "tool_use", id: "tooluse_prev", name: "get_weather", input: { city: "Shanghai" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tooluse_prev", content: "sunny" }] },
      { role: "user", content: "go ahead" },
    ],
  };

  // 4. non-streaming full round trip
  const msg = await (await fetch(`${base}/v1/messages`, { method: "POST", headers: auth, body: JSON.stringify(reqBody) })).json();
  check("non-stream shape", msg.type === "message" && msg.role === "assistant");
  check("non-stream text", msg.content.some((b) => b.type === "text" && b.text === "Hello world"));
  const tu = msg.content.find((b) => b.type === "tool_use");
  check("non-stream tool_use", !!tu && tu.input.city === "Shanghai" && tu.id === "tooluse_smoke1");
  check("non-stream stop+usage", msg.stop_reason === "tool_use" && msg.usage.input_tokens === 1234 && msg.usage.output_tokens === 56);

  // 5. streaming SSE sequence
  const sseRes = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...reqBody, stream: true }),
  });
  const sse = await sseRes.text();
  const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
  let pos = -1;
  let ordered = true;
  for (const name of order) {
    const i = sse.indexOf(`event: ${name}`, pos + 1);
    if (i < 0) ordered = false;
    else pos = i;
  }
  check("stream content-type", (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"));
  check("stream event order", ordered);
  check("stream text delta", sse.includes('"text_delta","text":"Hello "') || sse.includes('"text":"Hello "'));
  check("stream input_json_delta", sse.includes('\\"city\\"') && sse.includes("input_json_delta"));
  check("stream stop_reason", sse.includes('"stop_reason":"tool_use"'));

  // 6. error mapping, non-stream
  const errRes = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "FORCE_ERROR" }] }),
  });
  const errBody = await errRes.json();
  check("error non-stream status", errRes.status === 401, `status=${errRes.status}`);
  check("error non-stream shape", errBody.type === "error" && errBody.error.type === "authentication_error");

  // 7. error mapping, stream (pre-output -> HTTP error, not SSE)
  const errStreamRes = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "FORCE_ERROR" }] }),
  });
  check("error stream status", errStreamRes.status === 401 && !(errStreamRes.headers.get("content-type") ?? "").includes("text/event-stream"));

  // 8. no credential at all
  const noAuth = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
  });
  check("missing key -> 401", noAuth.status === 401);
} finally {
  server.close();
}

console.log(failures === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
