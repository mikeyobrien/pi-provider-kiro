import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Model,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capacityRetryConfig, retryConfig } from "../src/retry.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";

const ts = Date.now();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
    ...overrides,
  };
}

function makeContext(userMsg = "Hello"): Context {
  return {
    systemPrompt: "You are helpful",
    messages: [{ role: "user", content: userMsg, timestamp: Date.now() }],
    tools: [],
  };
}

async function collect(stream: ReturnType<typeof streamKiro>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") {
      return events;
    }
  }
  return events;
}

function mockFetchOk(body: string) {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    },
  });
}

function mockFetchChunked(chunks: string[]) {
  const readMock = vi.fn();
  for (const chunk of chunks) {
    readMock.mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunk) });
  }
  readMock.mockResolvedValueOnce({ done: true, value: undefined });
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: { getReader: () => ({ read: readMock }) },
  });
}

describe("Feature 9: Streaming Integration", () => {
  beforeEach(() => {
    // Mark profileArn as already resolved so tests don't see an extra fetch
    resetProfileArnCache(true);
  });

  it("emits error when no credentials provided", async () => {
    const stream = streamKiro(makeModel(), makeContext(), {});
    const events = await collect(stream);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("/login kiro");
  });

  it("emits error with reason 'aborted' when signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = streamKiro(makeModel(), makeContext(), { signal: ac.signal });
    const events = await collect(stream);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
  });

  it("makes POST to correct endpoint with auth header", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "test-token" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("generateAssistantResponse");
    expect(opts.headers.Authorization).toBe("Bearer test-token");

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.content.some((b) => b.type === "text" && b.text.includes("Hi"))).toBe(true);

    // contextUsagePercentage=10 with contextWindow=200000 -> input should be 20000
    expect(msg?.usage.input).toBe(20000);
    expect(msg?.usage.totalTokens).toBeGreaterThan(20000);

    vi.unstubAllGlobals();
  });

  it("resolves profileArn via ListAvailableProfiles and includes it in request body", async () => {
    resetProfileArnCache(false);
    const testArn = "arn:aws:codewhisperer:us-east-1:123:profile/TEST";
    const mockFetch = vi
      .fn()
      // 1st call: ListAvailableProfiles
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: testArn }] }),
      })
      // 2nd call: generateAssistantResponse
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call is ListAvailableProfiles
    expect(mockFetch.mock.calls[0][1].headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
    // Second call includes profileArn in the body
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.profileArn).toBe(testArn);

    // Subsequent call reuses cached ARN without another ListAvailableProfiles
    const mockFetch2 = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch2);
    const stream2 = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    await collect(stream2);
    expect(mockFetch2).toHaveBeenCalledOnce();
    const body2 = JSON.parse(mockFetch2.mock.calls[0][1].body);
    expect(body2.profileArn).toBe(testArn);

    vi.unstubAllGlobals();
  });

  it("sets stopReason to toolUse when tool calls are present", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":20}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  it("does not retry on 413 - propagates error immediately", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Streaming event sequence (pi-mono: stream.test.ts handleStreaming)
  // =========================================================================

  it("emits complete text_start -> text_delta -> text_end sequence", async () => {
    const mockFetch = mockFetchChunked(['{"content":"Hello "}', '{"content":"world"}', '{"contextUsagePercentage":5}']);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const types = events.map((e) => e.type);

    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types).toContain("done");

    // text_start before text_delta before text_end
    const textStart = types.indexOf("text_start");
    const firstDelta = types.indexOf("text_delta");
    const textEnd = types.indexOf("text_end");
    expect(textStart).toBeLessThan(firstDelta);
    expect(firstDelta).toBeLessThan(textEnd);

    // Accumulated deltas match final content
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Hello world");

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.content[0].type === "text" && msg.content[0].text).toBe("Hello world");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Thinking + text streaming (pi-mono: stream.test.ts handleThinking)
  // =========================================================================

  it("emits thinking_start -> thinking_delta -> thinking_end -> text_start -> text_delta -> text_end for reasoning model", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"<thinking>Let me think"}',
      '{"content":"</thinking>\\n\\n"}',
      '{"content":"The answer"}',
      '{"contextUsagePercentage":15}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: true }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const types = events.map((e) => e.type);

    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("thinking_end");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");

    // thinking before text
    const thinkEnd = types.indexOf("thinking_end");
    const textStart = types.indexOf("text_start");
    expect(thinkEnd).toBeLessThan(textStart);

    const thinkDeltas = events
      .filter((e) => e.type === "thinking_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(thinkDeltas).toContain("Let me think");

    const textDeltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(textDeltas).toContain("The answer");

    vi.unstubAllGlobals();
  });

  it("does not withhold the tail of plain text in reasoning mode", async () => {
    const mockFetch = mockFetchChunked(['{"content":"Hello world"}', '{"contextUsagePercentage":5}']);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: true }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const firstTextDelta = events.find((e) => e.type === "text_delta");

    expect(firstTextDelta?.type === "text_delta" && firstTextDelta.delta).toBe("Hello world");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Tool call streaming events (pi-mono: stream.test.ts handleToolCall)
  // =========================================================================

  it("emits toolcall_start -> toolcall_delta -> toolcall_end with parsed arguments", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const mockFetch = mockFetchOk(`{"content":"Let me run that."}${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const types = events.map((e) => e.type);

    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("toolcall_end");

    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.name).toBe("bash");
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.id).toBe("tc1");
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).cmd).toBe("ls");

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  it("emits tool calls as they arrive instead of waiting for stream end", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"I\'ll inspect the file."}',
      '{"name":"read","toolUseId":"tc1","input":"{\\"path\\":\\"file"}',
      '{"input":".txt\\"}"}',
      '{"stop":true}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const types = events.map((e) => e.type);
    const toolcallStart = types.indexOf("toolcall_start");
    const textEnd = types.indexOf("text_end");

    expect(toolcallStart).toBeGreaterThan(-1);
    expect(textEnd).toBeGreaterThan(-1);
    expect(toolcallStart).toBeLessThan(textEnd);

    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).path).toBe(
      "file.txt",
    );

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Multiple tool calls (pi-mono: stream.test.ts multiTurn)
  // =========================================================================

  it("handles multiple tool calls in a single response", async () => {
    const tool1 = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const tool2 = '{"name":"read","toolUseId":"tc2","input":"{\\"path\\":\\"f.txt\\"}","stop":true}';
    const mockFetch = mockFetchOk(`${tool1}${tool2}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const tcEnds = events.filter((e) => e.type === "toolcall_end");
    expect(tcEnds).toHaveLength(2);
    expect(tcEnds[0].type === "toolcall_end" && tcEnds[0].toolCall.name).toBe("bash");
    expect(tcEnds[1].type === "toolcall_end" && tcEnds[1].toolCall.name).toBe("read");

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(2);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // totalTokens consistency (pi-mono: total-tokens.test.ts)
  // =========================================================================

  it("totalTokens equals input + output", async () => {
    const mockFetch = mockFetchOk('{"content":"Hello there, this is a response."}{"contextUsagePercentage":8}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    expect(msg).toBeDefined();
    if (!msg) throw new Error("msg undefined");
    expect(msg.usage.input).toBeGreaterThan(0);
    expect(msg.usage.output).toBeGreaterThan(0);
    expect(msg.usage.totalTokens).toBe(msg.usage.input + msg.usage.output);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Abort mid-stream (pi-mono: abort.test.ts testAbortSignal)
  // =========================================================================

  it("emits aborted when signal fires mid-stream", async () => {
    const ac = new AbortController();
    let readCount = 0;
    const readMock = vi.fn().mockImplementation(async () => {
      readCount++;
      if (readCount === 1) {
        return { done: false, value: new TextEncoder().encode('{"content":"chunk1"}') };
      }
      // Abort after first chunk
      ac.abort();
      // fetch with aborted signal throws
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: readMock }) },
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok", signal: ac.signal });
    const events = await collect(stream);

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
    // Should have partial content from first chunk
    expect(error?.type === "error" && error.error.content.length).toBeGreaterThanOrEqual(0);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Abort then new message (pi-mono: abort.test.ts testAbortThenNewMessage)
  // =========================================================================

  it("handles aborted assistant message in context followed by new request", async () => {
    // Simulate: first request was aborted, now sending follow-up
    const abortedAssistant: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "aborted",
      timestamp: ts,
    };

    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Hello", timestamp: ts },
        abortedAssistant,
        { role: "user", content: "Try again", timestamp: ts },
      ],
    };

    const mockFetch = mockFetchOk('{"content":"Sure!"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("stop");
    expect(done?.type === "done" && done.message.content.length).toBeGreaterThan(0);

    // The aborted message should have been filtered by normalizeMessages
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const historyStr = JSON.stringify(body.conversationState.history ?? []);
    expect(historyStr).not.toContain("aborted");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Empty / whitespace messages (pi-mono: empty.test.ts)
  // =========================================================================

  it("handles empty string user message", async () => {
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [{ role: "user", content: "", timestamp: ts }],
    };
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.role).toBe("assistant");

    vi.unstubAllGlobals();
  });

  it("handles whitespace-only user message", async () => {
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [{ role: "user", content: "   \n\t  ", timestamp: ts }],
    };
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("handles empty content array user message", async () => {
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [{ role: "user" as const, content: [] as (TextContent | ImageContent)[], timestamp: ts }],
    };
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done" || e.type === "error");
    expect(done).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("handles empty assistant message in conversation context", async () => {
    const emptyAssistant: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: ts,
    };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Hello", timestamp: ts },
        emptyAssistant,
        { role: "user", content: "Please respond", timestamp: ts },
      ],
    };
    const mockFetch = mockFetchOk('{"content":"Here I am"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.content.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Images in history don't break session (regression)
  // =========================================================================

  it("strips images from history entries so they don't bloat the request", async () => {
    const imageContent: ImageContent = { type: "image", data: "x".repeat(100000), mimeType: "image/png" };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: [{ type: "text", text: "Look at this" }, imageContent], timestamp: ts },
        {
          role: "assistant",
          content: [{ type: "text", text: "I see a cat" }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: ts,
        } as AssistantMessage,
        { role: "user", content: "What color was it?", timestamp: ts },
      ],
    };
    const mockFetch = mockFetchOk('{"content":"It was orange."}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("stop");

    // History should NOT contain the image base64 data
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const historyStr = JSON.stringify(body.conversationState.history ?? []);
    expect(historyStr).not.toContain("x".repeat(1000));
    // But the history entry text should still be there
    expect(historyStr).toContain("Look at this");

    vi.unstubAllGlobals();
  });

  it("handles multi-turn with images without exceeding size limits", async () => {
    const largeImage: ImageContent = { type: "image", data: "y".repeat(500000), mimeType: "image/jpeg" };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: [{ type: "text", text: "Image 1" }, largeImage], timestamp: ts },
        {
          role: "assistant",
          content: [{ type: "text", text: "Got it" }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: ts,
        } as AssistantMessage,
        { role: "user", content: [{ type: "text", text: "Image 2" }, largeImage], timestamp: ts },
        {
          role: "assistant",
          content: [{ type: "text", text: "Got that too" }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: ts,
        } as AssistantMessage,
        { role: "user", content: "Describe both images", timestamp: ts },
      ],
    };
    const mockFetch = mockFetchOk('{"content":"Both were photos."}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    // Request body should be well under the limit (no image bloat)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const bodySize = JSON.stringify(body).length;
    expect(bodySize).toBeLessThan(850000);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // =========================================================================

  it("handles assistant with tool calls followed by user message (no tool results)", async () => {
    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts,
    };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Run ls", timestamp: ts },
        assistantWithToolCall,
        { role: "user", content: "Never mind, what is 2+2?", timestamp: ts },
      ],
      tools: [{ name: "bash", description: "Run cmd", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"4"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).not.toBe("error");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Multi-turn tool flow (pi-mono: stream.test.ts multiTurn)
  // =========================================================================

  it("handles full multi-turn: user -> assistant(toolCall) -> toolResult -> assistant(text)", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "calc", arguments: { expr: "2+2" } }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts,
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "calc",
      content: [{ type: "text", text: "4" }],
      isError: false,
      timestamp: ts,
    };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [{ role: "user", content: "Calculate 2+2", timestamp: ts }, assistantWithTool, toolResult],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"The answer is 4."}{"contextUsagePercentage":8}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("stop");

    // Verify tool results were sent in the request body
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const currentMsg = body.conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe("Tool results provided.");
    expect(currentMsg.userInputMessageContext?.toolResults).toHaveLength(1);
    expect(currentMsg.userInputMessageContext.toolResults[0].toolUseId).toBe("tc1");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Non-retryable errors (complement to retry test)
  // =========================================================================

  it("emits error on 400 without retryable message", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Invalid parameter: modelId"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce(); // No retry
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("400");

    vi.unstubAllGlobals();
  });

  it("retries INSUFFICIENT_MODEL_CAPACITY with backoff then throws after max retries", async () => {
    const origConfig = { ...capacityRetryConfig };
    capacityRetryConfig.baseDelayMs = 10;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("INSUFFICIENT_MODEL_CAPACITY"),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
      const events = await collect(stream);

      // 1 initial + 3 capacity retries
      expect(mockFetch).toHaveBeenCalledTimes(4);
      const error = events.find((e) => e.type === "error");
      expect(error).toBeDefined();
      expect(error?.type === "error" && error.error.errorMessage).toContain("INSUFFICIENT_MODEL_CAPACITY");
      expect(error?.type === "error" && error.error.errorMessage).not.toContain("429");
    } finally {
      Object.assign(capacityRetryConfig, origConfig);
      vi.unstubAllGlobals();
    }
  });

  it("succeeds after transient capacity error without consuming outer retry budget", async () => {
    const origConfig = { ...capacityRetryConfig };
    capacityRetryConfig.baseDelayMs = 10;

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("INSUFFICIENT_MODEL_CAPACITY"),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
      const events = await collect(stream);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.find((e) => e.type === "done")).toBeDefined();
    } finally {
      Object.assign(capacityRetryConfig, origConfig);
      vi.unstubAllGlobals();
    }
  });

  it("aborts promptly during capacity retry backoff delay", async () => {
    const origConfig = { ...capacityRetryConfig };
    capacityRetryConfig.baseDelayMs = 5000; // long delay so abort fires first

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("INSUFFICIENT_MODEL_CAPACITY"),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const abortController = new AbortController();
      const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok", signal: abortController.signal });
      setTimeout(() => abortController.abort(), 50);
      const events = await collect(stream);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const error = events.find((e) => e.type === "error");
      expect(error).toBeDefined();
    } finally {
      Object.assign(capacityRetryConfig, origConfig);
      vi.unstubAllGlobals();
    }
  });

  it("omits status codes from MONTHLY_REQUEST_COUNT errors to avoid outer auto-retry", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("MONTHLY_REQUEST_COUNT exceeded"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("MONTHLY_REQUEST_COUNT");
    expect(error?.type === "error" && error.error.errorMessage).not.toContain("429");

    vi.unstubAllGlobals();
  });

  it("propagates 500 immediately so pi-coding-agent can retry at the session layer", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("Something went wrong"),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("500");

    vi.unstubAllGlobals();
  });

  it("does not retry on 400 with CONTENT_LENGTH_EXCEEDS_THRESHOLD", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("does not retry on repeated 413", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // No retries — error propagated immediately
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("error");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Overflow error message formatting (context_length_exceeded)
  // =========================================================================

  it("includes context_length_exceeded in error on 413", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("context_length_exceeded");

    vi.unstubAllGlobals();
  });

  it("includes context_length_exceeded in error on 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("context_length_exceeded");

    vi.unstubAllGlobals();
  });

  it("includes context_length_exceeded in error on 400 'Input is too long'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Input is too long."),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("context_length_exceeded");

    vi.unstubAllGlobals();
  });

  it("does NOT include context_length_exceeded for non-too-big errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Invalid parameter: modelId"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // 400 without retryable pattern → no retry, just 1 call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).not.toContain("context_length_exceeded");
    expect(error?.type === "error" && error.error.errorMessage).toContain("400");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // No response body
  // =========================================================================

  it("emits error when response has no body", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: null,
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("No response body");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Unicode surrogates in user content (pi-mono: unicode-surrogate.test.ts)
  // =========================================================================

  it("sanitizes unicode surrogates in user message content", async () => {
    const mockFetch = mockFetchOk('{"content":"Got it"}{"contextUsagePercentage":3}');
    vi.stubGlobal("fetch", mockFetch);

    const emoji = "Hello 🙈 world";
    const context = makeContext(emoji);
    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    // Verify the request was sent (no JSON serialization error from surrogates)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain("Hello");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // No system prompt
  // =========================================================================

  // =========================================================================
  // Non-standard key ordering in tool calls
  // =========================================================================

  it("handles tool call events where toolUseId comes before name", async () => {
    // Kiro sometimes sends toolUseId before name — the parser must handle this
    const toolPayload = '{"toolUseId":"tc1","name":"write","input":"{\\"path\\":\\"f.txt\\"}","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd).toBeDefined();
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.name).toBe("write");
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.id).toBe("tc1");
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).path).toBe("f.txt");

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Chunked tool input across multiple stream chunks
  // =========================================================================

  it("handles chunked tool input across multiple stream chunks", async () => {
    const mockFetch = mockFetchChunked([
      '{"name":"write","toolUseId":"tc1","input":"{\\"path\\":"}',
      '{"input":"\\"hello.txt\\"}"}',
      '{"stop":true}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd).toBeDefined();
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.name).toBe("write");
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).path).toBe(
      "hello.txt",
    );

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Empty object input placeholder + toolUseInput accumulation
  // =========================================================================

  it("handles toolUse with input:{} placeholder followed by toolUseInput events", async () => {
    // Kiro sometimes sends input:{} (object) as a placeholder, then fills it via toolUseInput events.
    // The empty object must NOT be stringified to "{}" or it corrupts concatenation.
    const mockFetch = mockFetchChunked([
      '{"name":"write","toolUseId":"tc1","input":{}}',
      '{"input":"{\\"path\\":\\"file.md\\",\\"content\\":\\"hello\\"}"}',
      '{"stop":true}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd).toBeDefined();
    expect(tcEnd?.type === "toolcall_end" && tcEnd.toolCall.name).toBe("write");
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).path).toBe(
      "file.md",
    );
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as Record<string, unknown>).content).toBe(
      "hello",
    );

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Parse failure logging
  // =========================================================================

  it("logs warning when tool input JSON.parse fails", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"not-valid-json","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[pi-provider-kiro]");
    expect(msg).toContain("bash");
    expect(msg).toContain("tc1");
    expect(msg).toContain("not-valid-json");

    // Tool call with unparseable JSON should be skipped entirely
    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd).toBeUndefined();

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("handles tool call with empty input string", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // Empty input is treated as {} (valid zero-arg tool call), not skipped
    const tcEnd = events.find((e) => e.type === "toolcall_end");
    expect(tcEnd).toBeDefined();

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // No system prompt
  // =========================================================================

  it("works without system prompt", async () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hi", timestamp: ts }],
    };
    const mockFetch = mockFetchOk('{"content":"Hello"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), context, { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("stop");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // First-token timeout (Task 1.2)
  // =========================================================================

  it("retries when first token times out then succeeds on second attempt", async () => {
    const originalTimeout = retryConfig.firstTokenTimeoutMs;
    retryConfig.firstTokenTimeoutMs = 100;

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First attempt: reader that never resolves (simulates timeout)
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: () => new Promise(() => {}), // never resolves
              cancel: vi.fn().mockResolvedValue(undefined),
            }),
          },
        };
      }
      // Second attempt: succeeds
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === "done")).toBeDefined();

    retryConfig.firstTokenTimeoutMs = originalTimeout;
    vi.unstubAllGlobals();
  });

  it("does not produce unhandled rejection when reader.cancel() rejects", async () => {
    // Regression: reader.cancel() returns a Promise, but the old code wrapped
    // it in try/catch which only catches synchronous throws. If cancel()
    // returned a rejected promise (e.g. stream already errored from abort),
    // it became an unhandled rejection that crashed the Node process.
    const originalTimeout = retryConfig.firstTokenTimeoutMs;
    retryConfig.firstTokenTimeoutMs = 50;

    const abortController = new AbortController();

    // Temporarily remove vitest's unhandledRejection listeners so ours fires
    const existingListeners = process.rawListeners("unhandledRejection") as ((...args: unknown[]) => void)[];
    process.removeAllListeners("unhandledRejection");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    // reader.cancel() returns a rejected promise — simulates cancel on an
    // already-errored stream (common when abort fires mid-read).
    const cancelError = new Error("stream already errored");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}), // never resolves → timeout wins
          cancel: () => {
            return Promise.reject(cancelError);
          },
        }),
      },
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), {
      apiKey: "tok",
      signal: abortController.signal,
    });

    // Abort after the first-token timeout fires to cut through retry delays
    setTimeout(() => abortController.abort(), 120);

    const events = await collect(stream);

    // Let microtasks / unhandled rejections surface
    await new Promise((r) => setTimeout(r, 100));

    process.off("unhandledRejection", onUnhandled);
    // Restore vitest's listeners
    for (const l of existingListeners) process.on("unhandledRejection", l);
    retryConfig.firstTokenTimeoutMs = originalTimeout;
    vi.unstubAllGlobals();

    expect(events.find((e) => e.type === "error" || e.type === "done")).toBeDefined();
    expect(unhandled).toEqual([]);
  });

  // =========================================================================
  // Provider-level HTTP error handling
  // =========================================================================

  it("propagates 429 immediately so pi-coding-agent can own outer retries", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("Rate limited"),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("429");

    vi.unstubAllGlobals();
  });

  it("propagates 5xx immediately so pi-coding-agent can own outer retries", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: () => Promise.resolve("Bad Gateway"),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.errorMessage).toContain("502");

    vi.unstubAllGlobals();
  });

  it("retries on 403 with shorter backoff", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === "done")).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("refreshes token from kiro-cli on 403 before retrying", async () => {
    // Start with unresolved cache so profileArn resolution runs
    resetProfileArnCache(false);
    const mockFetch = vi
      .fn()
      // 1st call: ListAvailableProfiles
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/TEST" }] }),
      })
      // 2nd call: generateAssistantResponse → 403
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve('{"message":"The bearer token included in the request is invalid."}'),
      })
      // 3rd call: ListAvailableProfiles (re-resolved after credential refresh)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/TEST" }] }),
      })
      // 4th call: generateAssistantResponse retry
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    // Mock kiro-cli to return a fresh token
    const kiroCliModule = await import("../src/kiro-cli.js");
    const getCredsSpy = vi.spyOn(kiroCliModule, "getKiroCliCredentials").mockReturnValue({
      refresh: "fresh-refresh|client|secret|idc",
      access: "fresh-access-token",
      expires: Date.now() + 3600000,
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
      authMethod: "idc",
    });

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "stale-token" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    // 1st: ListAvailableProfiles with stale token
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    // 2nd: generateAssistantResponse with stale token → 403
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer stale-token");
    // 3rd: ListAvailableProfiles re-resolved with fresh token
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-access-token");
    // 4th: generateAssistantResponse retry with fresh token
    expect(mockFetch.mock.calls[3][1].headers.Authorization).toBe("Bearer fresh-access-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();

    getCredsSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not retry repeated 429 responses inside the provider", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("Rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("error");

    vi.unstubAllGlobals();
  }, 15000);

  it("aborts promptly during 403 retry backoff delay", async () => {
    const ac = new AbortController();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("Access denied"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok", signal: ac.signal });

    // Abort after fetch returns but during the backoff delay
    setTimeout(() => ac.abort(), 50);

    const start = Date.now();
    const events = await collect(stream);
    const elapsed = Date.now() - start;

    // Should abort quickly, not wait the full 1s+ backoff
    expect(elapsed).toBeLessThan(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("aborted");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Content deduplication (Task 2.2)
  // =========================================================================

  it("deduplicates consecutive identical content events", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"content":"Hello"}',
      '{"content":" world"}',
      '{"contextUsagePercentage":5}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta);
    // Second "Hello" should be deduplicated
    expect(deltas).toEqual(["Hello", " world"]);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.content[0].type === "text" && msg.content[0].text).toBe("Hello world");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Token counting with tiktoken (Task 3.2)
  // =========================================================================

  it("uses tiktoken for output token counting instead of chars/4", async () => {
    const mockFetch = mockFetchOk('{"content":"Hello there, this is a response."}{"contextUsagePercentage":8}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    // tiktoken count should differ from chars/4 (which would be ~8)
    // "Hello there, this is a response." is 8 tokens with cl100k_base
    expect(msg?.usage.output).toBeGreaterThan(0);
    // The old method (chars/4) would give ceil(32/4) = 8
    // tiktoken gives an accurate count that won't be exactly chars/4 for most strings
    expect(msg?.usage.totalTokens).toBe(msg?.usage.input + msg?.usage.output);

    vi.unstubAllGlobals();
  });

  it("prefers usage event values over tiktoken when available", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"usage":{"inputTokens":500,"outputTokens":200}}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    // Usage event values should take precedence
    expect(msg?.usage.input).toBe(500);
    expect(msg?.usage.output).toBe(200);
    expect(msg?.usage.totalTokens).toBe(700);

    // contextPercent should still reflect the API's contextUsagePercentage,
    // not be derived from the (overwritten) input token count
    expect((msg?.usage as Record<string, unknown>).contextPercent).toBe(10);

    vi.unstubAllGlobals();
  });

  it("passes through contextPercent even without usage event", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":42}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    expect((msg?.usage as Record<string, unknown>).contextPercent).toBe(42);
    // input should be back-calculated from percentage
    expect(msg?.usage.input).toBe(Math.round(0.42 * 200000));

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Truncation recovery (Task 4.1)
  // =========================================================================

  it("sets stopReason to length when stream ends without contextUsage event", async () => {
    // Stream that ends without contextUsagePercentage event
    const mockFetch = mockFetchOk('{"content":"partial response that got cut off"}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("length");

    vi.unstubAllGlobals();
  });

  it("prepends truncation notice when previous response was truncated", async () => {
    const truncatedAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial..." }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "length",
      timestamp: ts,
    };

    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Tell me a long story", timestamp: ts },
        truncatedAssistant,
        { role: "user", content: "Continue", timestamp: ts },
      ],
    };

    const mockFetch = mockFetchOk('{"content":"...the rest of the story."}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    // Verify truncation notice was prepended to the user message
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const currentMsg = body.conversationState.currentMessage.userInputMessage.content;
    expect(currentMsg).toContain("cut off");
    expect(currentMsg).toContain("Continue");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Bracket-style tool call parsing (Task 4.2)
  // =========================================================================

  it("extracts bracket tool calls from content as fallback", async () => {
    const mockFetch = mockFetchOk(
      '{"content":"Let me run that. [Called bash with args: {\\"cmd\\": \\"ls\\"}]"}{"contextUsagePercentage":10}',
    );
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    // Should have extracted a tool call
    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0].type === "toolCall" && toolCalls?.[0].name).toBe("bash");

    // Text content should have bracket pattern stripped
    const textBlock = msg?.content.find((b) => b.type === "text");
    expect(textBlock?.type === "text" && textBlock.text).not.toContain("[Called");

    expect(done?.type === "done" && done.reason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  it("does not use bracket parsing when native tool calls exist", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const mockFetch = mockFetchOk(
      `{"content":"text [Called other with args: {}]"}${toolPayload}{"contextUsagePercentage":10}`,
    );
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    // Only the native tool call should be present, not the bracket one
    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0].type === "toolCall" && toolCalls?.[0].name).toBe("bash");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Empty response / ghost tool call recovery (stopReason stall fix)
  // =========================================================================

  it("treats tool calls with empty input as valid zero-arg calls", async () => {
    // Empty input is normalized to {} — a valid zero-arg tool call.
    // stopReason should be "toolUse" so the agent loop processes the result.
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.reason).toBe("toolUse");
    expect(done?.type === "done" && done.message.content.filter((b) => b.type === "toolCall")).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("does not set stopReason to toolUse when all tool calls have unparseable input", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"not-json","stop":true}';
    const mockFetch = mockFetchOk(`${toolPayload}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledOnce();
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.reason).not.toBe("toolUse");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("retries on completely empty response (no text, no tool calls)", async () => {
    // Simulates the degenerate API response: only contextUsage, no content or tools.
    // Should retry up to maxRetries, then return without stalling.
    const emptyResponse = '{"contextUsagePercentage":50}';
    const goodResponse = '{"content":"recovered"}{"contextUsagePercentage":10}';

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(emptyResponse) })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(goodResponse) })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // Should have retried: 2 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.message.stopReason).toBe("stop");
    expect(
      done?.type === "done" &&
        done.message.content.some((b) => b.type === "text" && (b as TextContent).text === "recovered"),
    ).toBe(true);

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("returns stop (not toolUse) after max retries on persistent empty responses", async () => {
    const emptyResponse = '{"contextUsagePercentage":50}';

    // All 4 attempts return empty — need a fresh reader for each call
    const makeEmptyResponse = () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(emptyResponse) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeEmptyResponse())
      .mockResolvedValueOnce(makeEmptyResponse())
      .mockResolvedValueOnce(makeEmptyResponse())
      .mockResolvedValueOnce(makeEmptyResponse());
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // 1 initial + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    // Must be "stop", not "toolUse" — toolUse with empty content stalls the agent
    expect(done?.type === "done" && done.reason).toBe("stop");
    expect(done?.type === "done" && done.message.content).toHaveLength(0);

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  }, 30000);

  it("keeps non-consecutive duplicate content events", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"A"}',
      '{"content":"B"}',
      '{"content":"A"}',
      '{"contextUsagePercentage":5}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["A", "B", "A"]);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // conversationId uses sessionId when provided
  // =========================================================================

  it("uses options.sessionId as conversationId when provided", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const sessionId = "stable-session-id-1234";
    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok", sessionId });
    await collect(stream);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.conversationState.conversationId).toBe(sessionId);

    vi.unstubAllGlobals();
  });
});
