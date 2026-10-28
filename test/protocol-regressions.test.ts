import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";

const model: Model<Api> = {
  id: "claude-haiku-4-5",
  name: "Test",
  provider: "kiro",
  api: "kiro-api",
  baseUrl: "https://runtime.us-east-1.kiro.dev/",
  reasoning: false,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "Synthetic test", timestamp: 0 }], tools: [] };

async function run(frames: Record<string, unknown>[]) {
  const bytes = concatMessages(...frames.map((frame) => encodeEventMessage(frame)));
  const fetch = vi.fn().mockImplementation(async () => new Response(new Uint8Array(bytes).buffer));
  vi.stubGlobal("fetch", fetch);
  const stream = streamKiro(model, context, { apiKey: "synthetic-token" });
  const events = [];
  for await (const event of stream) events.push(event);
  return { message: await stream.result(), events, fetch };
}

beforeEach(() => resetProfileArnCache(true));
afterEach(() => vi.unstubAllGlobals());

describe("response protocol regressions", () => {
  it("preserves identical consecutive text deltas", async () => {
    const { message } = await run([{ content: "ha" }, { content: "ha" }, { content: "!" }, { stopReason: "END_TURN" }]);
    expect(message.content).toContainEqual({ type: "text", text: "haha!" });
  });

  it("honors END_TURN with metadata-only context usage", async () => {
    const { message } = await run([
      { content: "Done" },
      {
        stopReason: "END_TURN",
        tokenUsage: { contextUsagePercentage: 42, uncachedInputTokens: 7, outputTokens: 1, totalTokens: 8 },
      },
    ]);
    expect(message.stopReason).toBe("stop");
    expect(message.usage.input).toBe(7);
    expect((message.usage as unknown as Record<string, unknown>).contextPercent).toBe(42);
  });

  it("does not retry an explicitly completed empty turn", async () => {
    const { message, fetch } = await run([{ stopReason: "END_TURN" }]);
    expect(message.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors output truncation even with a tool call", async () => {
    const { message } = await run([
      { name: "read", toolUseId: "t1", input: '{"path":"test"}', stop: true },
      { contextUsagePercentage: 5 },
      { stopReason: "MAX_TOKENS" },
    ]);
    expect(message.stopReason).toBe("length");
  });

  it.each([
    "CONTENT_FILTERED",
    "MODEL_CONTEXT_WINDOW_EXCEEDED",
    "PAUSE_TURN",
  ])("surfaces %s without provider retries", async (stopReason) => {
    const { message, fetch } = await run([{ stopReason, stopDetails: { reason: "synthetic" } }]);
    expect(message.stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
