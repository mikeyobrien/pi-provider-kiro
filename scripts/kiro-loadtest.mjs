// Load test: N concurrent real Kiro requests from a single process, to exercise
// the account-level rate limit and the 429 retry + pacing path.
// The token is read from pi's own auth store and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requestPacer, streamKiro } from "../dist/index.js";

const N = Number(process.env.N ?? 100);
const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).kiro;
if (!auth?.access) throw new Error("no kiro credential in ~/.pi/agent/auth.json");

function makeModel() {
  return {
    id: "claude-haiku-4-5",
    name: "Haiku",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 1024,
    kiroRegion: auth.region ?? "us-east-1",
    ...(auth.profileArn ? { kiroProfileArn: auth.profileArn } : {}),
  };
}

function makeContext(i) {
  return {
    systemPrompt: "Answer with the exact token requested and nothing else.",
    messages: [{ role: "user", content: `Reply with exactly: OK${i}`, timestamp: Date.now() }],
    tools: [],
  };
}

async function one(i) {
  const started = Date.now();
  const stream = streamKiro(makeModel(), makeContext(i), { apiKey: auth.access });
  let text = "";
  let error;
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "error") error = event.error.errorMessage ?? "unknown";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { i, ms: Date.now() - started, ok: !error, text: text.trim().slice(0, 40), error };
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => one(i + 1)));
const wall = Date.now() - t0;

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const byError = new Map();
for (const r of failed) {
  const key = (r.error ?? "").replace(/\s+/g, " ").slice(0, 110);
  byError.set(key, (byError.get(key) ?? 0) + 1);
}
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);

console.log(`requests=${N} ok=${ok.length} failed=${failed.length} wall=${(wall / 1000).toFixed(1)}s`);
console.log(
  `latency p50=${latencies[Math.floor(N * 0.5)]}ms p90=${latencies[Math.floor(N * 0.9)]}ms max=${latencies[N - 1]}ms`,
);
console.log(`pacer spacing after run: ${requestPacer.spacingMs}ms`);
for (const [message, count] of [...byError.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}x ${message}`);
}
const wrong = ok.filter((r) => !r.text.includes(`OK${r.i}`));
console.log(`content mismatches: ${wrong.length}`);
