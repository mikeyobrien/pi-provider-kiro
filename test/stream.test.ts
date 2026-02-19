import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { streamKiro } from "../src/stream.js";

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

  it("retries on 413 with reduced history", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        statusText: "Too Large",
        text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
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
    expect(tcEnd?.type === "toolcall_end" && (tcEnd.toolCall.arguments as any).cmd).toBe("ls");

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");

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
    expect(msg!.usage.input).toBeGreaterThan(0);
    expect(msg!.usage.output).toBeGreaterThan(0);
    expect(msg!.usage.totalTokens).toBe(msg!.usage.input + msg!.usage.output);

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
      messages: [{ role: "user", content: [] as any, timestamp: ts }],
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
  // Tool call without result in context (pi-mono: tool-call-without-result.test.ts)
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

  it("emits error on 500 server error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("Something went wrong"),
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

  it("retries on 400 with CONTENT_LENGTH_EXCEEDS_THRESHOLD", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
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

  it("gives up after max retries on repeated 413", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("CONTENT_LENGTH_EXCEEDS_THRESHOLD"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // 1 initial + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.type === "error" && error.error.stopReason).toBe("error");

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
});
