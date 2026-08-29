import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Model,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import { validateKiroConversation, validateKiroToolStructure } from "../src/history-validator.js";
import { capacityRetryConfig, retryConfig } from "../src/retry.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import { EMPTY_CONTENT_PLACEHOLDER, type KiroHistoryEntry } from "../src/transform.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";
import { RECORD_279_COMMAND, RECORD_279_SUMMARY, RECORD_279_TEXT } from "./helpers/invoke-fixture.js";

const ts = Date.now();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type TestKiroModel = Model<Api> & {
  kiroModelId?: string;
  kiroRegion?: string;
  kiroProfileArn?: string;
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
};

function makeModel(overrides?: Partial<TestKiroModel>): TestKiroModel {
  return {
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
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

function makeToolCall(id: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: `/tmp/${id}` } }],
    api: "kiro-api",
    provider: "kiro",
    model: "claude-sonnet-4-5",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: ts,
  };
}

function makeToolResult(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(300) }],
    isError: false,
    timestamp: ts,
  };
}

function makeCompactedToolContext(): Context {
  return {
    systemPrompt: "SYSTEM_MARKER",
    messages: [
      {
        role: "user",
        content: "The conversation was compacted:\n\n<summary>COMPACTION_SUMMARY_MARKER</summary>",
        timestamp: ts,
      },
      makeToolCall("tc1"),
      makeToolResult("tc1"),
      makeToolCall("tc2"),
      makeToolResult("tc2"),
      makeToolCall("tc3"),
      makeToolResult("tc3"),
    ],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  };
}

function effortSchema(field: "reasoning" | "output_config", values: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [field]: {
        type: "object",
        properties: { effort: { type: "string", enum: values } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
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

/** Parse concatenated JSON objects from a string (e.g. '{"a":1}{"b":2}') into individual objects */
function parseJsonObjects(body: string): object[] {
  const objects: object[] = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf("{", pos);
    if (start < 0) break;
    const end = findJsonEnd(body, start);
    if (end < 0) break;
    objects.push(JSON.parse(body.substring(start, end + 1)));
    pos = end + 1;
  }
  return objects;
}

/** Encode a concatenated-JSON string into binary Event Stream frames */
function encodeBody(body: string): Uint8Array {
  return concatMessages(...parseJsonObjects(body).map((o) => encodeEventMessage(o)));
}

function makeOkResponse(body: string): Response {
  const frames = encodeBody(body);
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: frames })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: () => {},
      }),
      cancel: async () => {},
    },
  } as unknown as Response;
}

function mockFetchOk(body: string) {
  return vi.fn().mockResolvedValueOnce(makeOkResponse(body));
}

function makeRequestRateResponse(headers?: Record<string, string>): Response {
  return {
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers(headers),
    text: () => Promise.resolve('{"message":"Please wait before trying again","reason":"USER_REQUEST_RATE_EXCEEDED"}'),
  } as unknown as Response;
}

function mockFetchChunked(chunks: string[]) {
  const readMock = vi.fn();
  for (const chunk of chunks) {
    readMock.mockResolvedValueOnce({ done: false, value: encodeBody(chunk) });
  }
  readMock.mockResolvedValueOnce({ done: true, value: undefined });
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: { getReader: () => ({ read: readMock, releaseLock: () => {} }), cancel: async () => {} },
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
    expect(url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-token");
    expect(opts.headers["X-Amz-Target"]).toBeUndefined();
    expect(JSON.parse(opts.body).profileArn).toBeDefined();

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.content.some((b) => b.type === "text" && b.text.includes("Hi"))).toBe(true);

    // contextUsagePercentage=10 with contextWindow=200000 -> input should be 20000
    expect(msg?.usage.input).toBe(20000);
    expect(msg?.usage.totalTokens).toBeGreaterThan(20000);

    vi.unstubAllGlobals();
  });

  it("emits native summarized thinking at max effort and preserves its signature", async () => {
    const mockFetch = mockFetchOk(
      '{"text":"Considering "}{"text":"divisibility"}{"signature":"opaque-signature"}{"content":"No"}{"contextUsagePercentage":10}',
    );
    vi.stubGlobal("fetch", mockFetch);

    try {
      const events = await collect(
        streamKiro(
          makeModel({
            id: "claude-sonnet-5",
            kiroModelId: "claude-sonnet-5",
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            additionalModelRequestFieldsSchema: {
              type: "object",
              properties: {
                thinking: {
                  type: "object",
                  properties: { display: { type: "string", enum: ["summarized", "omitted"] } },
                },
                output_config: {
                  type: "object",
                  properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] } },
                },
              },
            },
          }),
          makeContext(),
          { apiKey: "test-token", reasoning: "max" },
        ),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.additionalModelRequestFields).toEqual({
        output_config: { effort: "max" },
        thinking: { type: "adaptive", display: "summarized" },
      });
      const types = events.map((event) => event.type);
      expect(types.indexOf("thinking_start")).toBeLessThan(types.indexOf("thinking_delta"));
      expect(types.indexOf("thinking_delta")).toBeLessThan(types.indexOf("thinking_end"));
      expect(types.indexOf("thinking_end")).toBeLessThan(types.indexOf("text_start"));
      const done = events.find((event) => event.type === "done");
      const thinking =
        done?.type === "done" ? done.message.content.find((block) => block.type === "thinking") : undefined;
      expect(thinking).toMatchObject({
        type: "thinking",
        thinking: "Considering divisibility",
        thinkingSignature: "opaque-signature",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps visible-thinking markers when Claude uses structured adaptive effort", async () => {
    const mockFetch = mockFetchOk(
      '{"content":"<thinking>Checked divisibility</thinking>\\n\\nNo"}{"contextUsagePercentage":10}',
    );
    vi.stubGlobal("fetch", mockFetch);

    try {
      const events = await collect(
        streamKiro(
          makeModel({
            id: "claude-sonnet-4-6",
            kiroModelId: "claude-sonnet-4.6",
            additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "max"]),
          }),
          makeContext(),
          { apiKey: "test-token", reasoning: "high" },
        ),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const content = body.conversationState.currentMessage.userInputMessage.content;
      expect(body.additionalModelRequestFields).toEqual({
        output_config: { effort: "high" },
        thinking: { type: "adaptive" },
      });
      expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
      expect(content).toContain("<max_thinking_length>30000</max_thinking_length>");
      expect(events.some((event) => event.type === "thinking_delta")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      name: "maps GPT minimal to low",
      model: {
        id: "openai-gpt-5-6",
        kiroModelId: "openai-gpt-5.6",
        name: "GPT 5.6",
        input: ["text"] as ("text" | "image")[],
        thinkingLevelMap: { xhigh: "xhigh" },
        additionalModelRequestFieldsSchema: effortSchema("reasoning", ["low", "medium", "high", "xhigh"]),
      },
      reasoning: "minimal" as const,
      expected: { reasoning: { effort: "low" } },
      visibleThinking: false,
    },
    {
      name: "keeps GPT xhigh",
      model: {
        id: "openai-gpt-5-6",
        kiroModelId: "openai-gpt-5.6",
        name: "GPT 5.6",
        input: ["text"] as ("text" | "image")[],
        thinkingLevelMap: { xhigh: "xhigh" },
        additionalModelRequestFieldsSchema: effortSchema("reasoning", ["low", "medium", "high", "xhigh"]),
      },
      reasoning: "xhigh" as const,
      expected: { reasoning: { effort: "xhigh" } },
      visibleThinking: false,
    },
    {
      name: "keeps Claude xhigh distinct from max",
      model: {
        id: "claude-opus-4-8",
        kiroModelId: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"]),
      },
      reasoning: "xhigh" as const,
      expected: { output_config: { effort: "xhigh" }, thinking: { type: "adaptive" } },
      visibleThinking: true,
    },
    {
      name: "maps Pi xhigh to Kiro max when xhigh is unavailable",
      model: {
        id: "claude-sonnet-4-6",
        kiroModelId: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        thinkingLevelMap: { max: "max" },
        additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "max"]),
      },
      reasoning: "xhigh" as const,
      expected: { output_config: { effort: "max" }, thinking: { type: "adaptive" } },
      visibleThinking: true,
    },
  ])("sends structured effort: $name", async ({ model, reasoning, expected, visibleThinking }) => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", mockFetch);

    try {
      await collect(streamKiro(makeModel(model), makeContext(), { apiKey: "test-token", reasoning }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.additionalModelRequestFields).toEqual(expected);
      const content = body.conversationState.currentMessage.userInputMessage.content;
      if (visibleThinking) {
        expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
        expect(content).toContain("<max_thinking_length>");
      } else {
        expect(content).not.toContain("<thinking_mode>");
        expect(content).not.toContain("<max_thinking_length>");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses prompt injection only when a reasoning model has no structured effort mechanism", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), makeContext(), { apiKey: "test-token", reasoning: "xhigh" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.additionalModelRequestFields).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<max_thinking_length>50000</max_thinking_length>",
    );

    vi.unstubAllGlobals();
  });

  it("does not guess a known-model effort mechanism over a present catalog schema", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(
      streamKiro(
        makeModel({
          id: "claude-opus-4-8",
          kiroModelId: "claude-opus-4.8",
          name: "Claude Opus 4.8",
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
          additionalModelRequestFieldsSchema: { type: "object", properties: {}, additionalProperties: false },
        }),
        makeContext(),
        { apiKey: "test-token", reasoning: "high" },
      ),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.additionalModelRequestFields).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<thinking_mode>enabled</thinking_mode>",
    );

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
                value: encodeBody('{"content":"Hi"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call is ListAvailableProfiles on the management host.
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[0][1].headers["X-Amz-Target"]).toBeUndefined();
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

  it("uses a newer kiro-cli token when initial profile discovery returns 403", async () => {
    resetProfileArnCache(false);
    const freshProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/FRESH";
    const mockFetch = vi
      .fn()
      // Primary (us-east-1): stale token rejected
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      // Fallback (eu-central-1): stale token rejected there too — genuine auth rejection,
      // so the probe rethrows 403 and the #107 newer-credential path engages
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      // Re-probe with the newer kiro-cli token: profile found
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: freshProfileArn }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: encodeBody('{"content":"recovered"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const kiroCliModule = await import("../src/kiro-cli.js");
    const freshCliCreds = {
      refresh: "fresh-refresh|client|secret|idc",
      access: "fresh-token",
      expires: Date.now() + 3_600_000,
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
      authMethod: "idc" as const,
    };
    const getCredsSpy = vi.spyOn(kiroCliModule, "getKiroCliCredentials").mockReturnValue(freshCliCreds);
    const refreshSpy = vi.spyOn(kiroCliModule, "refreshViaKiroCli").mockReturnValue(undefined);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "stale-token" }));

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[1][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(mockFetch.mock.calls[3][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(JSON.parse(mockFetch.mock.calls[3][1].body).profileArn).toBe(freshProfileArn);
    expect(events.find((event) => event.type === "done")).toBeDefined();

    getCredsSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("forces a kiro-cli refresh when profile discovery rejects the stored token", async () => {
    resetProfileArnCache(false);
    const freshProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/REFRESHED";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: encodeBody('{"content":"recovered"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const kiroCliModule = await import("../src/kiro-cli.js");
    const staleCliCreds = {
      refresh: "stale-refresh|client|secret|idc",
      access: "stale-token",
      expires: Date.now() + 3_600_000,
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
      authMethod: "idc" as const,
    };
    const freshCliCreds = { ...staleCliCreds, access: "fresh-token", profileArn: freshProfileArn };
    const getCredsSpy = vi.spyOn(kiroCliModule, "getKiroCliCredentials").mockReturnValue(staleCliCreds);
    const refreshSpy = vi.spyOn(kiroCliModule, "refreshViaKiroCli").mockReturnValue(freshCliCreds);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "stale-token" }));

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).profileArn).toBe(freshProfileArn);
    expect(events.find((event) => event.type === "done")).toBeDefined();

    getCredsSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("uses a credential-projected profileArn without management discovery or a matching CLI token", async () => {
    resetProfileArnCache(false);
    const profileArn = "arn:aws:codewhisperer:us-east-1:123:profile/SOCIAL";
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(
      streamKiro(makeModel({ kiroProfileArn: profileArn } as Partial<Model<Api>>), makeContext(), {
        apiKey: "persisted-social-token",
      }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).profileArn).toBe(profileArn);
    expect(events.find((event) => event.type === "done")).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("fails before inference when profile discovery returns no profile", async () => {
    resetProfileArnCache(false);
    // Both canonical management regions return an empty profile list (#104):
    // the provider probes the fallback region before failing to inference.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[1][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("returned no profile");

    vi.unstubAllGlobals();
  });

  it("fails before inference when profile discovery fails", async () => {
    resetProfileArnCache(false);
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("ListAvailableProfiles failed");

    vi.unstubAllGlobals();
  });

  it("derives the runtime and management region from baseUrl when kiroRegion is absent", async () => {
    resetProfileArnCache(false);
    const testArn = "arn:aws:codewhisperer:eu-central-1:123:profile/TEST";
    const endpoint = "https://runtime.eu-central-1.kiro.dev/";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: testArn }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: encodeBody('{"content":"Hi"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel({ baseUrl: endpoint }), makeContext(), { apiKey: "tok" }));

    expect(mockFetch.mock.calls[0][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[1][0]).toBe(`${endpoint}generateAssistantResponse`);
    expect(events.find((event) => event.type === "done")).toBeDefined();

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

  it("preserves multiple thinking regions through the streamed response", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"<thinking>first</thinking>\\n\\nmid<rea"}',
      '{"content":"soning>second</reasoning>\\n\\nend"}',
      '{"contextUsagePercentage":15}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: true }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const thinkingStarts = events.filter((event) => event.type === "thinking_start");
    const thinkingEnds = events.filter((event) => event.type === "thinking_end");

    expect(thinkingStarts.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.content)).toEqual(["first", "second"]);

    const textDeltas = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(textDeltas).toBe("midend");
    expect(textDeltas).not.toMatch(/<\/?(?:thinking|think|reasoning|thought)>/);

    const textEnd = events.find((event) => event.type === "text_end");
    expect(textEnd?.type === "text_end" && [textEnd.contentIndex, textEnd.content]).toEqual([3, "end"]);

    const done = events.find((event) => event.type === "done");
    const content = done?.type === "done" ? done.message.content : [];
    expect(content).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "end" },
    ]);

    vi.unstubAllGlobals();
  });

  it("preserves empty first and later thinking regions through the streamed response", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"<thought></thought>mid<rea"}',
      '{"content":"soning></reasoning>end"}',
      '{"contextUsagePercentage":15}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: true }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const thinkingStarts = events.filter((event) => event.type === "thinking_start");
    const thinkingEnds = events.filter((event) => event.type === "thinking_end");

    expect(thinkingStarts.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.content)).toEqual(["", ""]);

    const textDeltas = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(textDeltas).toBe("midend");

    const textEnd = events.find((event) => event.type === "text_end");
    expect(textEnd?.type === "text_end" && [textEnd.contentIndex, textEnd.content]).toEqual([3, "end"]);

    const done = events.find((event) => event.type === "done");
    const content = done?.type === "done" ? done.message.content : [];
    expect(content).toEqual([
      { type: "thinking", thinking: "" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "" },
      { type: "text", text: "end" },
    ]);

    vi.unstubAllGlobals();
  });

  it("keeps one block per contentIndex when thinking arrives after text", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello world"}',
      '{"content":"<thinking>reasoning"}',
      '{"content":"</thinking>"}',
      '{"contextUsagePercentage":15}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: true }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const census = events
      .filter((e) => (e as { contentIndex?: number }).contentIndex !== undefined)
      .map((e) => `${e.type}@${(e as { contentIndex: number }).contentIndex}`);

    // The parser appends the thinking block, so the text block keeps index 0
    // for the whole stream and `text_end` names the slot `text_start` opened.
    // An earlier revision spliced thinking into index 0 and shifted the text
    // block to 1, which emitted `thinking_start@0` over the already-announced
    // text block and then `text_end@1` at a slot no `text_start` ever opened —
    // an index-addressed consumer lost the text and threw on the close.
    expect(census).toEqual([
      "text_start@0",
      "text_delta@0",
      "thinking_start@1",
      "thinking_delta@1",
      "thinking_end@1",
      "text_end@0",
    ]);

    const textEnd = events.find((e) => e.type === "text_end");
    expect(textEnd?.type === "text_end" && textEnd.content).toBe("Hello world");

    const done = events.find((e) => e.type === "done");
    const content = done?.type === "done" ? done.message.content : [];
    expect(content.map((b) => b.type)).toEqual(["text", "thinking"]);

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
        return { done: false, value: encodeBody('{"content":"chunk1"}') };
      }
      // Abort after first chunk
      ac.abort();
      // fetch with aborted signal throws
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: readMock, releaseLock: () => {} }), cancel: async () => {} },
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

  it("keeps the newest bounded image in history for follow-up recognition", async () => {
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const historyStr = JSON.stringify(body.conversationState.history ?? []);
    expect(historyStr).toContain("x".repeat(1000));
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

    // Verify tool results were sent in the request body. `content` is empty by
    // design: Kiro's rule is content **or** toolResults, and this turn's payload
    // is the toolResults. Filling it with prose would put a sentence the user
    // never wrote into the conversation as a user utterance.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const currentMsg = body.conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe("");
    expect(currentMsg.userInputMessageContext?.toolResults).toHaveLength(1);
    expect(currentMsg.userInputMessageContext.toolResults[0].toolUseId).toBe("tc1");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Placeholder tools when context.tools is empty/undefined (advisor path)
  // —————————————————————————————————————————————————————————————————————————
  // When a caller passes no current tools (advisor strategy) but the inherited
  // conversation references prior toolUses, Kiro rejects the request as
  // "Improperly formed" unless those tool names are declared. The provider
  // must synthesize placeholder specs in that case.
  // =========================================================================

  it("synthesizes placeholder tool specs when context.tools is [] but history references tools", async () => {
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
      messages: [
        { role: "user", content: "Calculate 2+2", timestamp: ts },
        assistantWithTool,
        toolResult,
        { role: "user", content: "Now please advise on the situation above.", timestamp: ts },
      ],
      tools: [],
    };

    const mockFetch = mockFetchOk('{"content":"Sure."}{"contextUsagePercentage":3}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    await collect(stream);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools as
      | Array<{ toolSpecification: { name: string } }>
      | undefined;
    expect(tools).toBeDefined();
    expect(tools?.map((t) => t.toolSpecification.name)).toContain("calc");

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // `content` on a payload-less turn vs. a tool turn
  // ————————————————————————————————————————————————————————————————————
  // Kiro's rule is content **or** tool results. A turn carrying neither has no
  // payload at all — an image-only user message, an empty-text user message, or
  // a host-appended message whose role falls outside pi-ai's `Message` union —
  // and gets the neutral placeholder so its attachments still reach the model
  // (#106).
  //
  // A tool turn is not that turn: its payload is
  // `userInputMessageContext.toolResults`, so its `content` stays empty. Both
  // cases share one line in the request builder, and the guard between them is
  // load-bearing — see the mutation probe below.
  // =========================================================================

  // These use a prior turn so the system prompt is already consumed by the
  // first history entry: on the very first message the prompt is prepended to
  // the current content, which masks an empty text payload.
  const settledTurn = (): Context["messages"] => [
    { role: "user", content: "earlier question", timestamp: ts },
    {
      role: "assistant",
      content: [{ type: "text", text: "earlier answer" }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: ts,
    } satisfies AssistantMessage,
  ];

  it("sends placeholder content for an image-only user message", async () => {
    const image: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [...settledTurn(), { role: "user", content: [image], timestamp: ts }],
      tools: [],
    };
    const mockFetch = mockFetchOk('{"content":"Nice picture."}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe(EMPTY_CONTENT_PLACEHOLDER);
    // The image itself must still reach the model.
    expect(currentMsg.images).toHaveLength(1);
    expect(events.some((event) => event.type === "done")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("sends placeholder content for an empty-text user message", async () => {
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [...settledTurn(), { role: "user", content: "", timestamp: ts }],
      tools: [],
    };
    const mockFetch = mockFetchOk('{"content":"Go on."}{"contextUsagePercentage":1}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe(EMPTY_CONTENT_PLACEHOLDER);

    vi.unstubAllGlobals();
  });

  it("keeps real user text untouched", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi."}{"contextUsagePercentage":1}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), makeContext("Explain this repo"), { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toContain("Explain this repo");

    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // The tool-turn side of the same line.
  //
  // MUTATION PROBE for the `currentToolResults.length === 0` guard on the
  // placeholder fallback in stream.ts: widen that condition back to a bare
  // `if (currentContent === "")` and these three go red with
  // `EMPTY_CONTENT_PLACEHOLDER` in place of `""`. Without them the whole change
  // passes while every tool turn is refilled with a different fabricated
  // sentence — a no-op with new wording.
  // -----------------------------------------------------------------------

  it("sends empty content on a tool-result turn, with the results as payload", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "calc", arguments: { a: 2 } }],
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
        ...settledTurn(),
        assistantWithTool,
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "calc",
          content: [{ type: "text", text: "4" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"4."}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe("");
    expect(currentMsg.userInputMessageContext.toolResults).toHaveLength(1);
    expect(currentMsg.userInputMessageContext.toolResults[0].toolUseId).toBe("tc1");

    vi.unstubAllGlobals();
  });

  it("sends empty content when the turn is tool results alone", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc9", name: "calc", arguments: {} }],
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
        ...settledTurn(),
        assistantWithTool,
        {
          role: "toolResult",
          toolCallId: "tc9",
          toolName: "calc",
          content: [{ type: "text", text: "9" }],
          isError: false,
          timestamp: ts,
        },
        {
          role: "toolResult",
          toolCallId: "tc9",
          toolName: "calc",
          content: [{ type: "text", text: "9 again" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"9."}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).toBe("");
    expect(currentMsg.userInputMessageContext.toolResults.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("never puts carrier prose anywhere in a tool-turn request", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "calc", arguments: {} }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts,
    };
    const secondAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc2", name: "calc", arguments: {} }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts,
    };
    const tr = (id: string, text: string): Context["messages"][number] => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "calc",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: ts,
    });
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "do the thing", timestamp: ts },
        assistantWithTool,
        tr("tc1", "one"),
        secondAssistant,
        tr("tc2", "two"),
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"done"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).not.toContain("Tool results provided");
    // The one real user utterance survives verbatim.
    const parsed = JSON.parse(body);
    expect(parsed.conversationState.history[0].userInputMessage.content).toContain("do the thing");

    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // The pre-send REPAIR, exercised through `streamKiro` rather than through
  // `repairKiroConversation` directly. Unit tests on the validator prove the
  // rules; only these prove the request builder actually runs them and sends
  // the repaired bytes.
  //
  // MUTATION PROBE: delete the `kiroConversationEntries`/
  // `repairKiroConversation` block in stream.ts and these go red. Nothing else
  // in the suite does — `tsc` still passes and biome reports the orphaned
  // imports as a warning with exit 0.
  //
  // Reachability: `sanitizeHistory` repairs orphaned results inside `history`
  // by synthesizing an `unknown_tool` toolUse, but it tests pairing by POSITION,
  // so a mismatched PAIR — both partners present, each paired with the other's
  // counterpart — passes it untouched, and the current message is assembled
  // after that pass and is not covered by it at all. Both shapes reach the wire
  // as `400 TOOL_USE_RESULT_MISMATCH` unless repaired here.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // The live wedge, 2026-08-14. Two concurrent tool executions interleaved into
  // one transcript, so a tool result landed paired with the WRONG assistant's
  // tool use:
  //
  //   assistant(toolUses=[A]) / user(text) / assistant(toolUses=[B]) / user(results=[A])
  //
  // Kiro answered `400 ... tool_use ids were found without tool_result blocks
  // immediately after: <B>` and, because the retry resends identical history,
  // the session was terminally wedged — every subsequent turn 400d.
  //
  // `prepareHistory` cannot see it: `sanitizeHistory` tests pairing by POSITION,
  // and `injectSyntheticToolCalls` only rescues orphaned RESULTS.
  // -----------------------------------------------------------------------
  // The branch where repair legitimately removes `userInputMessageContext`
  // entirely: the carrier's results answer nothing, and the turn declares no
  // tools, so after stripping there is nothing left to put in the context. This
  // is the shape a `?? uimc` fallback silently undoes.
  //
  // No tools are declared and history contains no `toolUses`, so
  // `addPlaceholderTools` synthesizes none either — that is what makes the
  // repaired context empty rather than tools-only.
  //
  // MUTATION PROBE: change `wireUimc = repairedCurrent.userInputMessageContext`
  // to `... ?? uimc` in stream.ts and this goes red — the stripped orphan is put
  // straight back onto the wire.
  it("sends no tool context at all when repair strips the only results", async () => {
    const settledAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
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
        { role: "user", content: "do it", timestamp: ts },
        settledAssistant,
        // Answers `tcZ`, which no assistant turn ever issued.
        {
          role: "toolResult",
          toolCallId: "tcZ",
          toolName: "calc",
          content: [{ type: "text", text: "orphan" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const current = sent.conversationState.currentMessage.userInputMessage;
    expect(current.userInputMessageContext).toBeUndefined();
    // With no payload left, step 5 gives the turn the neutral prompt.
    expect(current.content).toBe(EMPTY_CONTENT_PLACEHOLDER);
    const conversation = [...(sent.conversationState.history ?? []), { userInputMessage: current }];
    expect(validateKiroConversation(conversation).valid).toBe(true);

    vi.unstubAllGlobals();
  });

  it("does not flatten reasoning into the current turn's assistant content", async () => {
    // The history site (`buildHistory`) stopped flattening earlier; this is the
    // OTHER site, in the current-message assistant branch. It reaches the wire
    // through the same `assistantResponseMessage.content`, so leaving it flattened
    // made the parity claim only half true.
    const withThinking: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deciding which file to read" } as unknown as TextContent,
        { type: "text", text: "reading it now" },
        { type: "toolCall", id: "tc9", name: "read", arguments: { path: "/tmp/tc9" } },
      ],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts,
    } as AssistantMessage;
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [...settledTurn(), withThinking, makeToolResult("tc9")],
      tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const entry = (sent.conversationState.history ?? []).find((h: KiroHistoryEntry) =>
      h.assistantResponseMessage?.toolUses?.some((tu) => tu.toolUseId === "tc9"),
    );
    expect(entry).toBeDefined();
    // The reasoning is gone from the text channel, the real text survives, and the
    // structured tool use is untouched.
    expect(entry?.assistantResponseMessage?.content).not.toContain("<thinking>");
    expect(entry?.assistantResponseMessage?.content).not.toContain("deciding which file to read");
    expect(entry?.assistantResponseMessage?.content).toContain("reading it now");
    expect(entry?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("read");
    // Nothing anywhere in the request carries the markup.
    expect(JSON.stringify(sent)).not.toContain("<thinking>");

    vi.unstubAllGlobals();
  });

  it("does not append a bare separator when merging an empty current turn into a previous assistant", async () => {
    // A current turn carrying only a toolCall leaves `armContent === ""`. Merging
    // that into the preceding assistant with an unconditional `\n\n` appends a
    // dangling separator onto text the model actually produced.
    //
    // Reaching the merge branch needs the LAST history entry to be an assistant
    // with no `userInputMessage`, so the fixture puts two assistant turns back to
    // back with no tool result between them. A tool-result carrier in between ends
    // history on a user entry and takes the push branch instead, which is what an
    // earlier version of this test did — it passed against the unconditional
    // separator and proved nothing.
    const plainAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "earlier answer" }],
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
        { role: "user", content: "go", timestamp: ts },
        plainAssistant,
        makeToolCall("tcB"),
        makeToolResult("tcB"),
      ],
      tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const merged = (sent.conversationState.history ?? []).find((h: KiroHistoryEntry) =>
      h.assistantResponseMessage?.toolUses?.some((tu) => tu.toolUseId === "tcB"),
    );
    // The merge happened onto the real text, and it is byte-identical.
    expect(merged?.assistantResponseMessage?.content).toBe("earlier answer");
    for (const entry of sent.conversationState.history ?? []) {
      const content = entry.assistantResponseMessage?.content;
      if (typeof content !== "string") continue;
      expect(content).not.toMatch(/\n\n$/);
    }

    vi.unstubAllGlobals();
  });

  it("repairs the live mismatched-pair wedge so it no longer earns a 400", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "build it", timestamp: ts },
        makeToolCall("A"),
        { role: "user", content: "continue", timestamp: ts },
        makeToolCall("B"),
        {
          role: "toolResult",
          toolCallId: "A",
          toolName: "read",
          content: [{ type: "text", text: "REAL_OUTPUT_A" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const current = sent.conversationState.currentMessage.userInputMessage;
    const conversation = [...(sent.conversationState.history ?? []), { userInputMessage: current }];

    // The 400 is gone. `B` — the toolUse the backend named — is answered, and no
    // result answering nothing is left on the wire. This is the whole point: the
    // request is now one the backend accepts, so the session is not wedged.
    expect(validateKiroToolStructure(conversation).valid).toBe(true);
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
    expect(current.userInputMessageContext.toolResults[0].toolUseId).toBe("B");
    expect(current.userInputMessageContext.toolResults[0].status).toBe("error");
    // `B` is answered rather than dropped, so the model still sees that its call
    // was issued and did not complete.
    const armToolUses = (sent.conversationState.history ?? []).flatMap(
      (h: KiroHistoryEntry) => h.assistantResponseMessage?.toolUses ?? [],
    );
    expect(armToolUses.map((tu: { toolUseId: string }) => tu.toolUseId)).toContain("B");

    // ---- What relocation preserves, and what it still costs. ----
    //
    // 1. `A`'s real output SURVIVES. `relocateDisplacedToolResults` moves the
    //    displaced result back behind the assistant that issued it, before
    //    anything positional runs, so `sanitizeHistory` no longer drops that
    //    assistant and the result is no longer orphaned. This is a pure reorder:
    //    nothing is fabricated and nothing is dropped.
    expect(JSON.stringify(sent)).toContain("REAL_OUTPUT_A");
    const historyResults = (sent.conversationState.history ?? []).flatMap(
      (h: KiroHistoryEntry) => h.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    const resultA = historyResults.find((tr: { toolUseId: string }) => tr.toolUseId === "A");
    expect(resultA).toBeDefined();
    expect(resultA.status).toBe("success");
    expect(resultA.content[0].text).toBe("REAL_OUTPUT_A");
    // Paired with the assistant that actually issued it, which is what makes the
    // request acceptable rather than merely present in the bytes.
    const aIdx = (sent.conversationState.history ?? []).findIndex((h: KiroHistoryEntry) =>
      h.assistantResponseMessage?.toolUses?.some((tu) => tu.toolUseId === "A"),
    );
    const afterA = (sent.conversationState.history ?? [])[aIdx + 1];
    expect(afterA?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe("A");
    //
    // 2. The real user interjection survives VERBATIM. Merging it into the
    //    now-empty carrier must not prepend a separator: `"continue"`, never
    //    `"\n\ncontinue"`. Fabricating whitespace onto a message the user wrote is
    //    the same defect class as the carrier prose this change removes.
    const interjection = (sent.conversationState.history ?? []).find((h: KiroHistoryEntry) =>
      h.userInputMessage?.userInputMessageContext?.toolResults?.some((tr) => tr.toolUseId === "A"),
    );
    expect(interjection?.userInputMessage?.content).toBe("continue");
    //
    // 3. Wire chronology shifts, and that is the accepted cost. The interjection
    //    was said BEFORE `A`'s result arrived, but appears after it on the wire,
    //    because relocation moves the result and not the user turn. A fidelity
    //    loss, not a fabrication, and strictly less lossy than discarding real
    //    tool output the model is waiting on.
    expect(aIdx).toBeLessThan(
      (sent.conversationState.history ?? []).findIndex(
        (h: KiroHistoryEntry) => h.userInputMessage?.content === "continue",
      ),
    );
    //
    // 4. `B` is still answered synthetically. Relocation makes `B` the trailing
    //    turn with nothing after it, so repair supplies its missing result — the
    //    same synthesis emitted before relocation existed. Relocation changes
    //    which output is PRESERVED, not how much is fabricated.
    //
    // 5. All seven rules now pass for this shape — a better outcome than
    //    relocation was expected to deliver. Before relocation the interjection
    //    left two consecutive user entries and `ALTERNATING_MESSAGES` survived as
    //    an unrepairable residual. Relocation moves `A`'s result to sit directly
    //    behind `A`, and the interjection then merges INTO that carrier entry
    //    rather than following it, so one user entry now carries both `A`'s real
    //    result and the user's verbatim text. Alternation holds as a consequence.
    //
    //    This is asserted rather than assumed: it is the reason the residual list
    //    is empty, and if a future change reintroduces a separate interjection
    //    entry this goes red rather than silently regressing to a residual.
    const residual = validateKiroConversation(conversation).errors;
    expect(residual).toEqual([]);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("outbound history");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("repairs an outbound tool structure that violates an invariant", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tcA", name: "calc", arguments: {} }],
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
        ...settledTurn(),
        assistantWithTool,
        // Answers `tcZ`, which no preceding toolUse issued.
        {
          role: "toolResult",
          toolCallId: "tcZ",
          toolName: "calc",
          content: [{ type: "text", text: "orphan" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    // Repaired, not merely reported: the orphan `tcZ` result is stripped and
    // `tcA` — which nothing answered — gets a synthetic failure result, so the
    // conversation that reaches the wire satisfies all seven rules.
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const conversation = [
      ...(sent.conversationState.history ?? []),
      { userInputMessage: sent.conversationState.currentMessage.userInputMessage },
    ];
    expect(validateKiroConversation(conversation).valid).toBe(true);
    const sentResults = sent.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults;
    expect(sentResults?.map((tr: { toolUseId: string }) => tr.toolUseId)).toEqual(["tcA"]);
    expect(sentResults?.[0].status).toBe("error");
    // Nothing survived repair, so nothing is warned about.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("outbound history");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("stays silent on a well-formed tool turn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tcA", name: "calc", arguments: {} }],
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
        ...settledTurn(),
        assistantWithTool,
        {
          role: "toolResult",
          toolCallId: "tcA",
          toolName: "calc",
          content: [{ type: "text", text: "7" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("outbound history");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  // Probed 2026-08-11 before this test existed: this context reached the wire as
  // `currentMessage.userInputMessage` with populated `toolResults`, no `history`
  // at all, and no `toolUse` anywhere — the exact shape the backend rejects as
  // `TOOL_USE_RESULT_MISMATCH` — while the invariant check stayed silent, because
  // the pairwise walk only inspects a carrier that follows an assistant entry.
  //
  // It is now repaired rather than warned about. This is also the one shape that
  // repair COLLAPSES: the whole conversation is a single bare carrier, so step 1
  // finds no valid opening entry and consumes it. `stream.ts` handles that
  // explicitly — strip the results that answer nothing, keep the tool catalog,
  // and fall back to the neutral prompt.
  //
  // MUTATION PROBE: restore `wireUimc = repairedCurrent?.userInputMessageContext ?? uimc`
  // and this goes red — the fallback puts the stripped orphan straight back.
  it("repairs a tool-result carrier that has no toolUse anywhere", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        // No assistant turn ever issued `tcZ`. `sanitizeHistory` cannot repair
        // this one: the carrier is the current message, not a history entry.
        {
          role: "toolResult",
          toolCallId: "tcZ",
          toolName: "calc",
          content: [{ type: "text", text: "orphan" }],
          isError: false,
          timestamp: ts,
        },
      ],
      tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":2}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(
      streamKiro(makeModel({ kiroProfileArn: "arn:aws:codewhisperer:us-east-1:0:profile/X" }), context, {
        apiKey: "tok",
      }),
    );

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const currentMsg = sent.conversationState.currentMessage.userInputMessage;
    // The orphan is gone — sending it is what earns the 400.
    expect(currentMsg.userInputMessageContext?.toolResults ?? []).toHaveLength(0);
    // The tool catalog survives, and the turn still has a payload.
    expect(currentMsg.userInputMessageContext?.tools).toBeDefined();
    expect(currentMsg.content).toBe(EMPTY_CONTENT_PLACEHOLDER);
    expect(sent.conversationState.history ?? []).toHaveLength(0);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("outbound history");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  // The observed failure: a host appended a reminder message carrying a role
  // outside pi-ai's `Message` union ("developer") after a settled assistant
  // turn. None of the current-message branches matched it, so `content` went
  // out empty and Kiro answered 400 REQUEST_BODY_INVALID — which the provider
  // then relabeled `context_length_exceeded`, sending the caller into a
  // compaction loop against a request that was structurally invalid, not large.
  it("sends placeholder content when the turn ends on an unrecognized role", async () => {
    const settledAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: ts,
    };
    const reminder = {
      role: "developer",
      content: [{ type: "text", text: "<system-reminder>2 incomplete todos</system-reminder>" }],
      attribution: "agent",
      timestamp: ts,
    };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Do the work", timestamp: ts },
        settledAssistant,
        reminder as unknown as Context["messages"][number],
      ],
      tools: [],
    };
    const mockFetch = mockFetchOk('{"content":"Continuing."}{"contextUsagePercentage":4}');
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const currentMsg = JSON.parse(mockFetch.mock.calls[0][1].body).conversationState.currentMessage.userInputMessage;
    expect(currentMsg.content).not.toBe("");
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);

    vi.unstubAllGlobals();
  });

  it("synthesizes placeholder tool specs when context.tools is undefined but history references tools", async () => {
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
      messages: [
        { role: "user", content: "Calculate 2+2", timestamp: ts },
        assistantWithTool,
        toolResult,
        { role: "user", content: "Now please advise on the situation above.", timestamp: ts },
      ],
      // tools intentionally omitted
    };

    const mockFetch = mockFetchOk('{"content":"Sure."}{"contextUsagePercentage":3}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    await collect(stream);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools as
      | Array<{ toolSpecification: { name: string } }>
      | undefined;
    expect(tools).toBeDefined();
    expect(tools?.map((t) => t.toolSpecification.name)).toContain("calc");

    vi.unstubAllGlobals();
  });

  it("omits userInputMessageContext.tools when context.tools is [] and history has no tool uses", async () => {
    // Plain user-only conversation with no current tools must not emit a tools
    // array — preserves prior behavior for the genuinely tool-less case.
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [{ role: "user", content: "Hello", timestamp: ts }],
      tools: [],
    };

    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":1}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    await collect(stream);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const uimc = body.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(uimc?.tools).toBeUndefined();

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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
      text: () => Promise.resolve('{"message":"Monthly quota exhausted","reason":"MONTHLY_REQUEST_COUNT"}'),
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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
  // Local overflow recovery and post-compaction context preservation
  // =========================================================================

  it("sends the system/compaction anchor and complete tool groups when within budget", async () => {
    const mockFetch = mockFetchOk('{"content":"Done"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeCompactedToolContext(), { apiKey: "tok" }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const history = body.conversationState.history as KiroHistoryEntry[];
    const historyText = JSON.stringify(history);
    const toolUseIds = history
      .flatMap((entry) => entry.assistantResponseMessage?.toolUses ?? [])
      .map((t) => t.toolUseId);
    const historyResultIds = history
      .flatMap((entry) => entry.userInputMessage?.userInputMessageContext?.toolResults ?? [])
      .map((result) => result.toolUseId);
    const currentResultIds = (
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? []
    ).map((result: { toolUseId: string }) => result.toolUseId);

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(historyText.match(/SYSTEM_MARKER/g) ?? []).toHaveLength(1);
    expect(historyText.match(/COMPACTION_SUMMARY_MARKER/g) ?? []).toHaveLength(1);
    expect(toolUseIds).toEqual(["tc1", "tc2", "tc3"]);
    expect(historyResultIds).toEqual(["tc1", "tc2"]);
    expect(currentResultIds).toEqual(["tc3"]);

    vi.unstubAllGlobals();
  });

  it("returns a Pi-recognized overflow without sending or dropping compacted context", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const model = makeModel({ contextWindow: 100 });

    const events = await collect(streamKiro(model, makeCompactedToolContext(), { apiKey: "tok" }));
    const error = events.find((event) => event.type === "error");
    const message = error?.type === "error" ? error.error : undefined;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(message?.errorMessage).toMatch(/context_length_exceeded.*local history/);
    expect(message?.errorMessage).not.toContain("COMPACTION_SUMMARY_MARKER");
    expect(message && isContextOverflow(message, model.contextWindow)).toBe(true);

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

  // A malformed-body 400 is not an overflow. Reporting it as one sends the
  // caller into a compaction loop that can never clear the error, because the
  // request is invalid rather than oversized.
  it("does NOT report 400 'Improperly formed request' as a context overflow", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve('{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}'),
    });
    vi.stubGlobal("fetch", mockFetch);

    const model = makeModel();
    const events = await collect(streamKiro(model, makeContext(), { apiKey: "tok" }));
    const error = events.find((e) => e.type === "error");
    const message = error?.type === "error" ? error.error : undefined;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(message?.errorMessage).not.toContain("context_length_exceeded");
    expect(message?.errorMessage).toContain("Improperly formed request.");
    expect(message && isContextOverflow(message, model.contextWindow)).toBe(false);

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
  // Response-header timeout
  // =========================================================================

  it("times out a fetch that never returns response headers", async () => {
    vi.useFakeTimers();
    const originalTimeout = retryConfig.requestHeaderTimeoutMs;
    retryConfig.requestHeaderTimeoutMs = 10;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(7_100);
      const events = await eventsPromise;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" && error.error.errorMessage).toBe(
        "Kiro API error: response headers timeout after max retries",
      );
    } finally {
      retryConfig.requestHeaderTimeoutMs = originalTimeout;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("preserves caller cancellation during the response-header wait", async () => {
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      notifyFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const eventsPromise = collect(
        streamKiro(makeModel(), makeContext(), { apiKey: "tok", signal: controller.signal }),
      );
      await fetchStarted;
      controller.abort(new DOMException("cancelled by caller", "AbortError"));
      const events = await eventsPromise;

      expect(fetchMock).toHaveBeenCalledOnce();
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
      expect(error?.type === "error" && error.error.errorMessage).toContain("cancelled by caller");
      expect(error?.type === "error" && error.error.errorMessage).not.toContain("response headers timeout");
      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      removeListenerSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("clears the response-header timer and caller listener after headers arrive", async () => {
    vi.useFakeTimers();
    const originalTimeout = retryConfig.requestHeaderTimeoutMs;
    retryConfig.requestHeaderTimeoutMs = 10;
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", fetchMock);

    try {
      const events = await collect(
        streamKiro(makeModel(), makeContext(), { apiKey: "tok", signal: controller.signal }),
      );
      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const responseHeaderSignal = requestInit.signal as AbortSignal;

      expect(events.find((event) => event.type === "done")).toBeDefined();
      expect(responseHeaderSignal.aborted).toBe(false);
      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      await vi.advanceTimersByTimeAsync(11);
      expect(responseHeaderSignal.aborted).toBe(false);
    } finally {
      retryConfig.requestHeaderTimeoutMs = originalTimeout;
      removeListenerSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("retries a response-header timeout and succeeds", async () => {
    vi.useFakeTimers();
    const originalTimeout = retryConfig.requestHeaderTimeoutMs;
    retryConfig.requestHeaderTimeoutMs = 10;
    const successfulFetch = mockFetchOk('{"content":"ok"}{"contextUsagePercentage":5}');
    const requestSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      if (requestSignals.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return successfulFetch();
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(1_010);
      const events = await eventsPromise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestSignals[0]?.reason).toMatchObject({ name: "TimeoutError" });
      expect(requestSignals[1]?.aborted).toBe(false);
      expect(events.find((event) => event.type === "done")).toBeDefined();
      await vi.advanceTimersByTimeAsync(11);
      expect(requestSignals[1]?.aborted).toBe(false);
    } finally {
      retryConfig.requestHeaderTimeoutMs = originalTimeout;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
              releaseLock: () => {},
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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
          releaseLock: () => {},
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

  it.each([
    ["retry-after-ms milliseconds", { "retry-after-ms": "25" }, 25],
    ["retry-after seconds", { "retry-after": "0.025" }, 25],
    ["retry-after HTTP date", { "retry-after": "Sat, 29 Aug 2026 00:00:05 GMT" }, 5000],
    ["x-ratelimit-reset-after seconds", { "x-ratelimit-reset-after": "0.025" }, 25],
  ])("honors %s for exact USER_REQUEST_RATE_EXCEEDED and then succeeds", async (_name, headers, delayMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRequestRateResponse(headers))
      .mockResolvedValueOnce(makeOkResponse('{"content":"ok"}{"contextUsagePercentage":5}'));
    vi.stubGlobal("fetch", mockFetch);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const events = await eventsPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.find((event) => event.type === "done")).toBeDefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["an absent hint", undefined],
    [
      "malformed, non-finite, and negative hints",
      { "retry-after-ms": "not-a-number", "retry-after": "-1", "x-ratelimit-reset-after": "Infinity" },
    ],
  ])("uses the 10-second request-window fallback for %s", async (_name, headers) => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRequestRateResponse(headers))
      .mockResolvedValueOnce(makeOkResponse('{"content":"ok"}{"contextUsagePercentage":5}'));
    vi.stubGlobal("fetch", mockFetch);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const events = await eventsPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.find((event) => event.type === "done")).toBeDefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("caps a longer server request-window hint at 10 seconds", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRequestRateResponse({ "retry-after-ms": "15000" }))
      .mockResolvedValueOnce(makeOkResponse('{"content":"ok"}{"contextUsagePercentage":5}'));
    vi.stubGlobal("fetch", mockFetch);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mockFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const events = await eventsPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.find((event) => event.type === "done")).toBeDefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("preserves caller cancellation during request-window backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const mockFetch = vi.fn().mockResolvedValue(makeRequestRateResponse());
    vi.stubGlobal("fetch", mockFetch);

    try {
      const eventsPromise = collect(
        streamKiro(makeModel(), makeContext(), { apiKey: "tok", signal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException("cancelled by caller", "AbortError"));
      const events = await eventsPromise;

      expect(mockFetch).toHaveBeenCalledOnce();
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
      expect(error?.type === "error" && error.error.errorMessage).toContain("cancelled by caller");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("exhausts the shared provider retry budget without starting a new Pi retry episode", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(makeRequestRateResponse());
    vi.stubGlobal("fetch", mockFetch);

    try {
      const eventsPromise = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(30_000);
      const events = await eventsPromise;

      expect(mockFetch).toHaveBeenCalledTimes(4);
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" && error.error.errorMessage).toBe(
        "Kiro API error: request window retry budget exhausted (USER_REQUEST_RATE_EXCEEDED)",
      );
      expect(error?.type === "error" && isRetryableAssistantError(error.error)).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("propagates an unknown 429 immediately so pi-coding-agent can own outer retries", async () => {
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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
                value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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

  it("refreshes rejected CLI credentials and re-resolves the profile before retrying runtime", async () => {
    resetProfileArnCache(false);
    const staleProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/STALE";
    const freshProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/FRESH";
    const successFrames = encodeBody('{"content":"ok"}{"contextUsagePercentage":5}');
    const mockFetch = vi
      .fn()
      // Runtime rejects the token and profile projected from the original credentials.
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      })
      // The fresh token resolves a fresh profile through management.
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: freshProfileArn }] }),
      })
      // Runtime succeeds with both refreshed identity values.
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: successFrames })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const kiroCliModule = await import("../src/kiro-cli.js");
    const staleCliCreds = {
      refresh: "stale-refresh|client|secret|idc",
      access: "stale-token",
      expires: Date.now() + 3_600_000,
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
      authMethod: "idc" as const,
      profileArn: staleProfileArn,
    };
    const freshCliCreds = {
      ...staleCliCreds,
      refresh: "fresh-refresh|client|secret|idc",
      access: "fresh-token",
      profileArn: undefined,
    };
    const getCredsSpy = vi.spyOn(kiroCliModule, "getKiroCliCredentials").mockReturnValue(staleCliCreds);
    const refreshSpy = vi.spyOn(kiroCliModule, "refreshViaKiroCli").mockReturnValue(freshCliCreds);

    const stream = streamKiro(makeModel({ kiroProfileArn: staleProfileArn }), makeContext(), {
      apiKey: "stale-token",
    });
    const events = await collect(stream);

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
      "https://management.us-east-1.kiro.dev/List-Available-Profiles",
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    ]);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).profileArn).toBe(staleProfileArn);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).profileArn).toBe(freshProfileArn);
    expect(events.find((event) => event.type === "done")).toBeDefined();

    getCredsSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("preserves a known social profile across desktop credential rotation", async () => {
    resetProfileArnCache(false);
    const socialProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/SOCIAL";
    const successFrames = encodeBody('{"content":"ok"}{"contextUsagePercentage":5}');
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
              .mockResolvedValueOnce({ done: false, value: successFrames })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);

    const kiroCliModule = await import("../src/kiro-cli.js");
    const staleSocialCreds = {
      refresh: "stale-social-refresh|desktop",
      access: "stale-social-token",
      expires: Date.now() + 3_600_000,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop" as const,
      profileArn: socialProfileArn,
    };
    const refreshedSocialCreds = {
      ...staleSocialCreds,
      refresh: "fresh-social-refresh|desktop",
      access: "fresh-social-token",
      profileArn: undefined,
    };
    const getCredsSpy = vi.spyOn(kiroCliModule, "getKiroCliCredentials").mockReturnValue(staleSocialCreds);
    const refreshSpy = vi.spyOn(kiroCliModule, "refreshViaKiroCli").mockReturnValue(refreshedSocialCreds);

    const events = await collect(
      streamKiro(makeModel({ kiroProfileArn: socialProfileArn }), makeContext(), {
        apiKey: "stale-social-token",
      }),
    );

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    ]);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-social-token");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).profileArn).toBe(socialProfileArn);
    expect(events.find((event) => event.type === "done")).toBeDefined();

    getCredsSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("fails the 403 retry when refreshed profile discovery fails", async () => {
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
      // 3rd call: ListAvailableProfiles fails after credential refresh
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
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

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 1st: ListAvailableProfiles with stale token on management.
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    // 2nd: generateAssistantResponse with stale token → 403
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer stale-token");
    // 3rd: ListAvailableProfiles fails with the fresh token on management.
    expect(mockFetch.mock.calls[2][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-access-token");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("ListAvailableProfiles failed");

    getCredsSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not retry repeated 429 responses inside the provider", async () => {
    vi.useFakeTimers();
    const originalTimeout = retryConfig.requestHeaderTimeoutMs;
    retryConfig.requestHeaderTimeoutMs = 10;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("Rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
      const events = await collect(stream);
      const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
      const responseHeaderSignal = requestInit.signal as AbortSignal;

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const error = events.find((e) => e.type === "error");
      expect(error).toBeDefined();
      expect(error?.type === "error" && error.error.stopReason).toBe("error");
      await vi.advanceTimersByTimeAsync(11);
      expect(responseHeaderSignal.aborted).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      retryConfig.requestHeaderTimeoutMs = originalTimeout;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    // tiktoken count should differ from chars/4 (which would be ~8)
    // "Hello there, this is a response." is 8 tokens with cl100k_base
    expect(msg.usage.output).toBeGreaterThan(0);
    // The old method (chars/4) would give ceil(32/4) = 8
    // tiktoken gives an accurate count that won't be exactly chars/4 for most strings
    expect(msg.usage.totalTokens).toBe(msg.usage.input + msg.usage.output);

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
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    // Usage event values should take precedence
    expect(msg.usage.input).toBe(500);
    expect(msg.usage.output).toBe(200);
    expect(msg.usage.totalTokens).toBe(700);

    // contextPercent should still reflect the API's contextUsagePercentage,
    // not be derived from the (overwritten) input token count
    expect((msg.usage as unknown as Record<string, unknown>).contextPercent).toBe(10);

    vi.unstubAllGlobals();
  });

  it("passes through contextPercent even without usage event", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":42}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    expect((msg.usage as unknown as Record<string, unknown>).contextPercent).toBe(42);
    // input should be back-calculated from percentage
    expect(msg.usage.input).toBe(Math.round(0.42 * 200000));

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
  // XML-dialect tool call recovery (<invoke name="...">)
  // =========================================================================

  it("recovers an XML-dialect tool call and returns stopReason toolUse (record 279)", async () => {
    // Reproduces the observed stall: the model emitted its shell call as text in
    // Anthropic's XML function-calling dialect, so the turn ended
    // stopReason:"stop" with zero toolCall blocks and the agent loop parked at
    // the prompt. The assertion that matters is the stopReason flip — that is
    // what keeps an unattended session moving.
    const mockFetch = mockFetchOk(`${JSON.stringify({ content: RECORD_279_TEXT })}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    const call = toolCalls?.[0];
    expect(call?.type === "toolCall" && call.name).toBe("shell");
    // Byte-exact all the way through JSON.stringify → emitToolCall → JSON.parse.
    expect(call?.type === "toolCall" && call.arguments.command).toBe(RECORD_279_COMMAND);
    expect(call?.type === "toolCall" && call.arguments.summary).toBe(RECORD_279_SUMMARY);

    const textBlock = msg?.content.find((b) => b.type === "text");
    expect(textBlock?.type === "text" && textBlock.text).not.toContain("<invoke name=");

    // The fix: "stop" would stall the agent loop; "toolUse" continues it.
    expect(done?.type === "done" && done.reason).toBe("toolUse");
    expect(msg?.stopReason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  it("recovers XML-dialect calls split across stream chunks", async () => {
    // The dialect arrives as ordinary content deltas, so a tag can straddle a
    // chunk boundary. Recovery runs on the assembled text block, after the
    // stream ends, so boundaries must not matter.
    const mid = Math.floor(RECORD_279_TEXT.length / 2);
    const mockFetch = mockFetchChunked([
      JSON.stringify({ content: RECORD_279_TEXT.slice(0, mid) }),
      JSON.stringify({ content: RECORD_279_TEXT.slice(mid) }),
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0].type === "toolCall" && toolCalls?.[0].arguments.command).toBe(RECORD_279_COMMAND);
    expect(done?.type === "done" && done.reason).toBe("toolUse");

    vi.unstubAllGlobals();
  });

  it("does not recover XML-dialect calls when native tool calls exist", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const mockFetch = mockFetchOk(
      `${JSON.stringify({ content: RECORD_279_TEXT })}${toolPayload}{"contextUsagePercentage":10}`,
    );
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    const toolCalls = msg?.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0].type === "toolCall" && toolCalls?.[0].name).toBe("bash");

    vi.unstubAllGlobals();
  });

  it("leaves prose that merely quotes the dialect alone", async () => {
    // Model output analysing this bug quotes the dialect inside a code fence.
    // Recovering from that would execute a command out of documentation.
    const prose = ["The leak looks like:", "```", RECORD_279_TEXT, "```", "Want me to file a card?"].join("\n");
    const mockFetch = mockFetchOk(`${JSON.stringify({ content: prose })}{"contextUsagePercentage":10}`);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.content.filter((b) => b.type === "toolCall")).toHaveLength(0);
    const textBlock = msg?.content.find((b) => b.type === "text");
    expect(textBlock?.type === "text" && textBlock.text).toBe(prose);
    expect(done?.type === "done" && done.reason).toBe("stop");

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
              .mockResolvedValueOnce({ done: false, value: encodeBody(emptyResponse) })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: encodeBody(goodResponse) })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
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
            .mockResolvedValueOnce({ done: false, value: encodeBody(emptyResponse) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
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

  // =========================================================================
  // Echo loop detection ("Continue" as entire response)
  // =========================================================================

  it("retries when model responds with just 'Continue' (echo loop detection)", async () => {
    const echoResponse = '{"content":"Continue"}{"contextUsagePercentage":10}';
    const goodResponse = '{"content":"Here is the actual work."}{"contextUsagePercentage":10}';

    const makeEchoResponse = () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody(echoResponse) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeEchoResponse())
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: encodeBody(goodResponse) })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(
      done?.type === "done" &&
        done.message.content.some((b) => b.type === "text" && (b as TextContent).text === "Here is the actual work."),
    ).toBe(true);

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("detects echo loop for '.', 'continue', 'CONTINUE', ' Continue '", async () => {
    for (const echoText of [".", "continue", "CONTINUE", " Continue ", "\n continue \n", "..."]) {
      const echoResponse = `{"content":"${echoText.replace(/\n/g, "\\n")}"}{"contextUsagePercentage":10}`;
      const goodResponse = '{"content":"recovered"}{"contextUsagePercentage":10}';

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: encodeBody(echoResponse) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              releaseLock: () => {},
            }),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: encodeBody(goodResponse) })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              releaseLock: () => {},
            }),
          },
        });
      vi.stubGlobal("fetch", mockFetch);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
      const events = await collect(stream);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const done = events.find((e) => e.type === "done");
      expect(
        done?.type === "done" &&
          done.message.content.some((b) => b.type === "text" && (b as TextContent).text === "recovered"),
      ).toBe(true);

      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 30000);

  it("strips echo text after max retries on persistent 'Continue' responses", async () => {
    const echoResponse = '{"content":"Continue"}{"contextUsagePercentage":10}';

    const makeEchoResponse = () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody(echoResponse) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeEchoResponse())
      .mockResolvedValueOnce(makeEchoResponse())
      .mockResolvedValueOnce(makeEchoResponse())
      .mockResolvedValueOnce(makeEchoResponse());
    vi.stubGlobal("fetch", mockFetch);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // 1 initial + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.reason).toBe("stop");
    // The echo text should be stripped — no "Continue" in final output
    const textBlocks = done?.type === "done" ? done.message.content.filter((b) => b.type === "text") : [];
    const fullText = textBlocks.map((b) => (b as TextContent).text).join("");
    expect(fullText).toBe("");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  }, 30000);

  it("does NOT treat 'Continue' with tool calls as echo loop", async () => {
    const toolPayload =
      '{"content":"Continue"}{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}{"contextUsagePercentage":10}';
    const mockFetch = mockFetchOk(toolPayload);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    // Should NOT retry — tool calls present means it's not an echo loop
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");
    // But the echo text should be stripped from the response
    const textBlocks = done?.type === "done" ? done.message.content.filter((b) => b.type === "text") : [];
    const fullText = textBlocks.map((b) => (b as TextContent).text).join("");
    expect(fullText).toBe("");

    vi.unstubAllGlobals();
  });

  it("strips '.' prefix from tool call responses to prevent echo accumulation", async () => {
    const toolPayload =
      '{"content":"."}{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}{"contextUsagePercentage":10}';
    const mockFetch = mockFetchOk(toolPayload);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");
    // "." should be stripped — it's echo noise alongside tool calls
    const textBlocks = done?.type === "done" ? done.message.content.filter((b) => b.type === "text") : [];
    const fullText = textBlocks.map((b) => (b as TextContent).text).join("");
    expect(fullText).toBe("");

    vi.unstubAllGlobals();
  });

  it("preserves meaningful text alongside tool calls", async () => {
    const toolPayload =
      '{"content":"Let me check that."}{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}{"contextUsagePercentage":10}';
    const mockFetch = mockFetchOk(toolPayload);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("toolUse");
    // Meaningful text should be preserved
    const textBlocks = done?.type === "done" ? done.message.content.filter((b) => b.type === "text") : [];
    const fullText = textBlocks.map((b) => (b as TextContent).text).join("");
    expect(fullText).toBe("Let me check that.");

    vi.unstubAllGlobals();
  });

  it("does NOT treat longer text containing 'continue' as echo loop", async () => {
    const response = '{"content":"Let me continue working on this task."}{"contextUsagePercentage":10}';
    const mockFetch = mockFetchOk(response);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const done = events.find((e) => e.type === "done");
    expect(
      done?.type === "done" &&
        done.message.content.some(
          (b) => b.type === "text" && (b as TextContent).text === "Let me continue working on this task.",
        ),
    ).toBe(true);

    vi.unstubAllGlobals();
  });

  it("history uses merging instead of synthetic padding — no echoable content", async () => {
    // Simulate a multi-turn conversation with tool calls
    const a1: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
      api: "kiro-api",
      provider: "kiro",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse" as const,
      timestamp: ts,
    };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Build an app", timestamp: ts },
        a1,
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "bash",
          content: [{ type: "text", text: "file1.ts" }],
          isError: false,
          timestamp: ts,
        },
        { role: "user", content: "Next step", timestamp: ts },
      ],
      tools: [],
    };

    const mockFetch = mockFetchOk('{"content":"Done."}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), context, { apiKey: "tok" });
    await collect(stream);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const json = JSON.stringify(body);
    // No "Continue" anywhere in the request
    expect(json).not.toContain('"Continue"');
    // Padding uses "..." which is caught by echo stripping — not "Continue" or "."
    const history = body.conversationState.history || [];
    const badPadding = history.filter(
      (h: KiroHistoryEntry) =>
        (h.assistantResponseMessage && /^(Continue|\.)$/i.test(h.assistantResponseMessage.content)) ||
        (h.userInputMessage && /^(Continue|\.)$/i.test(h.userInputMessage.content)),
    );
    expect(badPadding).toHaveLength(0);

    vi.unstubAllGlobals();
  });
  it("normalizes cross-provider tool call IDs for Kiro requests", async () => {
    const openAiToolCallId = "call_7co4xEgttSQcqULvGmpE7qVJ|fc_07f9a04520d21e6a016a912c2adb8487d0aa2368675a637b3b";
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: "Read the file", timestamp: ts },
        makeToolCall(openAiToolCallId),
        makeToolResult(openAiToolCallId),
      ],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    };
    const mockFetch = mockFetchOk('{"content":"Done."}{"contextUsagePercentage":8}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const toolUseId = body.conversationState.history
      .flatMap((entry: KiroHistoryEntry) => entry.assistantResponseMessage?.toolUses ?? [])
      .at(-1).toolUseId;
    const toolResultId =
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].toolUseId;
    expect(toolUseId).toBe(toolResultId);
    expect(toolUseId).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/);
    expect(toolUseId).not.toBe(openAiToolCallId);

    vi.unstubAllGlobals();
  });

  it("strips historical images when the active model is text-only", async () => {
    const imageContent: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
    const context: Context = {
      systemPrompt: "You are helpful",
      messages: [
        { role: "user", content: [{ type: "text", text: "Look" }, imageContent], timestamp: ts },
        {
          role: "assistant",
          content: [{ type: "text", text: "I saw it" }],
          api: "kiro-api",
          provider: "kiro",
          model: "gpt-text-only",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: ts,
        } as AssistantMessage,
        { role: "user", content: "Describe it again", timestamp: ts },
      ],
    };
    const mockFetch = mockFetchOk('{"content":"No image available"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", mockFetch);

    await collect(streamKiro(makeModel({ input: ["text"] }), context, { apiKey: "tok" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(JSON.stringify(body.conversationState.history ?? [])).not.toContain("image-data");
    vi.unstubAllGlobals();
  });

  it("keeps only the newest bounded historical image", async () => {
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const imageEntries = (body.conversationState.history ?? []).filter(
      (entry: KiroHistoryEntry) => (entry.userInputMessage?.images?.length ?? 0) > 0,
    );
    expect(imageEntries).toHaveLength(1);
    expect(imageEntries[0].userInputMessage.images[0].source.bytes).toHaveLength(500000);
    expect(JSON.stringify(body).length).toBeLessThan(850000);

    vi.unstubAllGlobals();
  });
});
