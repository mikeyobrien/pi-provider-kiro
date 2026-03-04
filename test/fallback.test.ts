import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock streamKiro and streamSimpleBedrock before importing fallback
const mockStreamKiro = vi.fn();
const mockStreamSimpleBedrock = vi.fn();

vi.mock("../src/stream.js", () => ({
  streamKiro: (...args: unknown[]) => mockStreamKiro(...args),
}));

vi.mock("@mariozechner/pi-ai/dist/providers/amazon-bedrock.js", () => ({
  streamBedrock: (...args: unknown[]) => mockStreamSimpleBedrock(...args),
}));

vi.mock("@mariozechner/pi-ai/dist/providers/simple-options.js", () => ({
  buildBaseOptions: (_model: unknown, options: unknown) => options || {},
  adjustMaxTokensForThinking: (maxTokens: number, _modelMax: number) => ({ maxTokens, thinkingBudget: 8192 }),
  clampReasoning: (level: string) => (level === "xhigh" ? "high" : level),
}));

vi.mock("@mariozechner/pi-ai/dist/models.generated.js", () => ({
  MODELS: {
    "amazon-bedrock": {
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
        id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5 (Bedrock)",
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 65536,
      },
    },
  },
}));

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { streamWithFallback } from "../src/fallback.js";

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

function makeSuccessStream(text: string) {
  const stream = createAssistantMessageEventStream();
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "kiro-api",
    provider: "kiro",
    model: "claude-sonnet-4-5",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  setTimeout(() => {
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
  }, 0);
  return stream;
}

function makeErrorStream(errorMsg: string) {
  const stream = createAssistantMessageEventStream();
  const errOutput: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "kiro-api",
    provider: "kiro",
    model: "claude-sonnet-4-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: errorMsg,
    timestamp: Date.now(),
  };
  setTimeout(() => {
    stream.push({ type: "error", reason: "error", error: errOutput });
    stream.end();
  }, 0);
  return stream;
}

function makeBedrockSuccessStream(text: string) {
  const stream = createAssistantMessageEventStream();
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "bedrock-converse-stream" as Api,
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  setTimeout(() => {
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
  }, 0);
  return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

function makeThrowingStream(errorMsg: string) {
  // Simulates streamKiro throwing an exception (e.g., auth failure)
  // rather than emitting an error event on the stream.
  const stream = createAssistantMessageEventStream();
  setTimeout(() => {
    // Push nothing — just throw during iteration by ending with an error
    // Actually, to simulate a throw from streamKiro, we make the async
    // iterator throw when iterated.
  }, 0);
  // Return an async iterable that throws on first iteration
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(new Error(errorMsg));
        },
        return() {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
    push() {},
    end() {},
  };
}

function makeBedrockErrorStream(errorMsg: string) {
  const stream = createAssistantMessageEventStream();
  const errOutput: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "bedrock-converse-stream" as Api,
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: errorMsg,
    timestamp: Date.now(),
  };
  setTimeout(() => {
    stream.push({ type: "error", reason: "error", error: errOutput });
    stream.end();
  }, 0);
  return stream;
}

describe("Fallback: Kiro → Bedrock", () => {
  beforeEach(() => {
    mockStreamKiro.mockReset();
    mockStreamSimpleBedrock.mockReset();
  });
  it("passes through Kiro events when Kiro succeeds", async () => {
    mockStreamKiro.mockReturnValueOnce(makeSuccessStream("Hello from Kiro"));

    const events = await collect(streamWithFallback(makeModel(), makeContext()));

    expect(events.some((e) => e.type === "done")).toBe(true);
    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta?.type === "text_delta") {
      expect(textDelta.delta).toBe("Hello from Kiro");
    }
    expect(mockStreamSimpleBedrock).not.toHaveBeenCalled();
  });

  it("falls back to Bedrock when Kiro errors", async () => {
    mockStreamKiro.mockReturnValueOnce(makeErrorStream("Kiro API error: 500"));
    mockStreamSimpleBedrock.mockReturnValueOnce(makeBedrockSuccessStream("Hello from Bedrock"));

    const events = await collect(streamWithFallback(makeModel(), makeContext()));

    expect(events.some((e) => e.type === "done")).toBe(true);
    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta?.type === "text_delta") {
      expect(textDelta.delta).toBe("Hello from Bedrock");
    }
    // Verify fallback events are tagged with bedrock provider
    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type === "done") {
      expect(doneEvent.message.provider).toBe("bedrock");
      expect(doneEvent.message.model).toBe("claude-sonnet-4-5 (bedrock)");
    }
    expect(mockStreamSimpleBedrock).toHaveBeenCalledTimes(1);
  });

  it("emits error when Kiro fails and no Bedrock mapping exists", async () => {
    mockStreamKiro.mockReturnValueOnce(makeErrorStream("Kiro API error: 500"));

    const model = makeModel({ id: "nonexistent-model" });
    const events = await collect(streamWithFallback(model, makeContext()));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(mockStreamSimpleBedrock).not.toHaveBeenCalled();
  });

  it("does not call Bedrock when Kiro succeeds with tool calls", async () => {
    const stream = createAssistantMessageEventStream();
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "foo.ts" } }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    setTimeout(() => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"foo.ts"}', partial: msg });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: msg.content[0] as any, partial: msg });
      stream.push({ type: "done", reason: "toolUse", message: msg });
      stream.end();
    }, 0);

    mockStreamKiro.mockReturnValueOnce(stream);

    const events = await collect(streamWithFallback(makeModel(), makeContext()));

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(mockStreamSimpleBedrock).not.toHaveBeenCalled();
  });

  it("passes profile and region to Bedrock on fallback", async () => {
    const origProfile = process.env.PI_BEDROCK_PROFILE;
    const origRegion = process.env.PI_BEDROCK_REGION;
    const origAwsProfile = process.env.AWS_PROFILE;
    const origAwsRegion = process.env.AWS_REGION;

    try {
      process.env.PI_BEDROCK_PROFILE = "test-profile";
      process.env.PI_BEDROCK_REGION = "eu-west-1";
      delete process.env.AWS_PROFILE;
      delete process.env.AWS_REGION;

      mockStreamKiro.mockReturnValueOnce(makeErrorStream("Kiro API error: 500"));
      mockStreamSimpleBedrock.mockReturnValueOnce(makeBedrockSuccessStream("Hello from Bedrock"));

      await collect(streamWithFallback(makeModel(), makeContext()));

      expect(mockStreamSimpleBedrock).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamSimpleBedrock.mock.calls[0];
      const bedrockOpts = callArgs[2];
      expect(bedrockOpts.profile).toBe("test-profile");
      expect(bedrockOpts.region).toBe("eu-west-1");
    } finally {
      if (origProfile !== undefined) process.env.PI_BEDROCK_PROFILE = origProfile;
      else delete process.env.PI_BEDROCK_PROFILE;
      if (origRegion !== undefined) process.env.PI_BEDROCK_REGION = origRegion;
      else delete process.env.PI_BEDROCK_REGION;
      if (origAwsProfile !== undefined) process.env.AWS_PROFILE = origAwsProfile;
      else delete process.env.AWS_PROFILE;
      if (origAwsRegion !== undefined) process.env.AWS_REGION = origAwsRegion;
      else delete process.env.AWS_REGION;
    }
  });

  it("falls back to AWS_PROFILE when PI_BEDROCK_PROFILE is not set", async () => {
    const origPiProfile = process.env.PI_BEDROCK_PROFILE;
    const origAwsProfile = process.env.AWS_PROFILE;

    try {
      delete process.env.PI_BEDROCK_PROFILE;
      process.env.AWS_PROFILE = "my-aws-profile";

      mockStreamKiro.mockReturnValueOnce(makeErrorStream("Kiro API error: 500"));
      mockStreamSimpleBedrock.mockReturnValueOnce(makeBedrockSuccessStream("Hello from Bedrock"));

      await collect(streamWithFallback(makeModel(), makeContext()));

      const bedrockOpts = mockStreamSimpleBedrock.mock.calls[0][2];
      expect(bedrockOpts.profile).toBe("my-aws-profile");
    } finally {
      if (origPiProfile !== undefined) process.env.PI_BEDROCK_PROFILE = origPiProfile;
      else delete process.env.PI_BEDROCK_PROFILE;
      if (origAwsProfile !== undefined) process.env.AWS_PROFILE = origAwsProfile;
      else delete process.env.AWS_PROFILE;
    }
  });

  it("falls back to Bedrock when streamKiro throws an exception (auth failure)", async () => {
    mockStreamKiro.mockReturnValueOnce(makeThrowingStream("Kiro credentials not set. Run /login kiro or install kiro-cli."));
    mockStreamSimpleBedrock.mockReturnValueOnce(makeBedrockSuccessStream("Hello from Bedrock"));

    const events = await collect(streamWithFallback(makeModel(), makeContext()));

    expect(events.some((e) => e.type === "done")).toBe(true);
    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta?.type === "text_delta") {
      expect(textDelta.delta).toBe("Hello from Bedrock");
    }
    expect(mockStreamSimpleBedrock).toHaveBeenCalledTimes(1);
  });

  it("emits error when streamKiro throws and no Bedrock mapping exists", async () => {
    mockStreamKiro.mockReturnValueOnce(makeThrowingStream("Kiro credentials not set."));

    const model = makeModel({ id: "nonexistent-model" });
    const events = await collect(streamWithFallback(model, makeContext()));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error?.errorMessage).toContain("Kiro credentials not set.");
    }
    expect(mockStreamSimpleBedrock).not.toHaveBeenCalled();
  });

  it("reports both errors when streamKiro throws and Bedrock also fails", async () => {
    mockStreamKiro.mockReturnValueOnce(makeThrowingStream("Kiro auth expired"));
    mockStreamSimpleBedrock.mockImplementationOnce(() => {
      throw new Error("Bedrock credentials not configured");
    });

    const events = await collect(streamWithFallback(makeModel(), makeContext()));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error?.errorMessage).toContain("Kiro auth expired");
      expect(errorEvent.error?.errorMessage).toContain("Bedrock fallback also failed");
    }
  });

  it("does not attempt Bedrock fallback on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    mockStreamKiro.mockReturnValueOnce(makeThrowingStream("The operation was aborted"));

    const events = await collect(streamWithFallback(makeModel(), makeContext(), { signal: controller.signal }));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.reason).toBe("aborted");
    }
    expect(mockStreamSimpleBedrock).not.toHaveBeenCalled();
  });
});
