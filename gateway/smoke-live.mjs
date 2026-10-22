// Live smoke for kiro-gateway: REAL Kiro end-to-end with your own key.
// Usage (on your machine, from the repo root after `node gateway/build.mjs`):
//   KIRO_API_KEY=<your ksk_ key> node gateway/smoke-live.mjs
// Starts the built gateway on :8992, then checks:
//   1. basic non-streaming chat        3. tool_use round trip
//   2. streaming chat (SSE deltas)     4. image input (PIL-generated 256x256 PNG)
// Parallel tools / interrupt / compact / subagents are Claude Code behaviors —
// verify those by hand with the checklist in gateway/README.md.

import { spawn } from "node:child_process";

const key = process.env.KIRO_API_KEY;
if (!key?.startsWith("ksk_")) {
  console.error("Set KIRO_API_KEY to a valid ksk_ key first.");
  process.exit(2);
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const port = 8992;
const base = `http://127.0.0.1:${port}`;
const child = spawn("node", ["gateway/dist/main.js"], {
  env: { ...process.env, GATEWAY_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[gateway] ${d}`));

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("gateway did not come up");
}

const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
async function messages(payload) {
  const res = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json().catch(() => null), raw: res };
}

try {
  await waitHealth();
  check("gateway up", true);

  // 1. basic chat
  const basic = await messages({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OK" }],
  });
  const basicText = basic.body?.content?.map((b) => b.text ?? "").join("") ?? "";
  check("basic chat", basic.status === 200 && basicText.includes("GATEWAY_OK"), basicText.slice(0, 60) || JSON.stringify(basic.body).slice(0, 120));

  // 2. streaming
  const sseRes = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream: true, messages: [{ role: "user", content: "Count from 1 to 5." }] }),
  });
  const sse = await sseRes.text();
  check("streaming", sseRes.status === 200 && sse.includes("message_start") && sse.includes("text_delta") && sse.includes("message_stop"));

  // 3. tool round trip
  const toolReq = await messages({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
    messages: [{ role: "user", content: "Use the get_weather tool for Shanghai. Do not answer directly." }],
  });
  const toolUse = toolReq.body?.content?.find((b) => b.type === "tool_use");
  check("tool_use emitted", toolReq.status === 200 && !!toolUse, toolUse ? `${toolUse.name}(${JSON.stringify(toolUse.input)})` : JSON.stringify(toolReq.body).slice(0, 120));
  if (toolUse) {
    const follow = await messages({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      messages: [
        { role: "user", content: "Use the get_weather tool for Shanghai. Do not answer directly." },
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "sunny, 25C" }] },
      ],
    });
    const followText = follow.body?.content?.map((b) => b.text ?? "").join("") ?? "";
    check("tool_result round trip", follow.status === 200 && followText.length > 0, followText.slice(0, 60));
  }

  // 4. image input (PIL-generated 256x256 gradient PNG, verified decodable)
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADJ0lEQVR4nO3VsQnEABADQR24/5o/+CJs2EkmViL2tt12OzLos/tfgCz67D6xg3xFBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWBaBWDaH92Rhfunl8qyAAAAAElFTkSuQmCC";
  const img = await messages({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: "What is in this image? One short sentence." },
        ],
      },
    ],
  });
  check("image input", img.status === 200, img.status === 200 ? "" : JSON.stringify(img.body).slice(0, 400));
} finally {
  child.kill();
}

console.log(failures === 0 ? "\nLIVE SMOKE: ALL PASS" : `\nLIVE SMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
