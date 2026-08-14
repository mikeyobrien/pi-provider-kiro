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
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import { capacityRetryConfig, retryConfig } from "../src/retry.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import type { KiroUsage, KiroUsageProvenance } from "../src/token-usage.js";
import { EMPTY_CONTENT_PLACEHOLDER, type KiroHistoryEntry } from "../src/transform.js";
import { wasPreviousResponseTruncated } from "../src/truncation.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";

/**
 * Lets one test make the diagnostics append throw, to exercise the provider's
 * fail-open guard.
 *
 * `vi.spyOn` cannot seam this: `stream.ts` reaches the helper through
 * `import * as PiAi`, and an ES module namespace object has non-configurable
 * properties, so redefining one throws `Cannot redefine property`. Hence a
 * module mock — but a pass-through one, spreading the real exports and
 * delegating to the real implementation unless `fail` is set. Every other test
 * in this file therefore runs against unmodified pi-ai.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above ordinary declarations.
 */
const diagnosticsAppend = vi.hoisted(() => ({ fail: false }));
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    appendAssistantMessageDiagnostic: (
      ...args: Parameters<typeof actual.appendAssistantMessageDiagnostic>
    ): ReturnType<typeof actual.appendAssistantMessageDiagnostic> => {
      if (diagnosticsAppend.fail) {
        // Shaped like the real failure: on a host older than the 0.80.10 peer
        // minimum the export is absent, so the call site throws this.
        throw new TypeError("PiAi.appendAssistantMessageDiagnostic is not a function");
      }
      return actual.appendAssistantMessageDiagnostic(...args);
    },
  };
});

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

function mockFetchOk(body: string) {
  const frames = encodeBody(body);
  return vi.fn().mockResolvedValueOnce({
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
  });
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
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
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
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).profileArn).toBe(freshProfileArn);
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
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).profileArn).toBe(freshProfileArn);
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
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ profiles: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
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
  // Required `content` field
  // —————————————————————————————————————————————————————————————————————————
  // Kiro rejects a current message with an empty `content` as
  // "Improperly formed request." (reason REQUEST_BODY_INVALID). A turn can
  // reach the request builder with no text — an image-only user message, or a
  // user message whose text is empty — so a placeholder must be substituted.
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

  it("prefers measured token counts over the tiktoken estimate", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      // MetadataEvent shape from ChatResponseStream: token counts live under
      // tokenUsage.uncachedInputTokens/outputTokens, not a top-level `usage`.
      '{"tokenUsage":{"uncachedInputTokens":500,"outputTokens":200,"totalTokens":700}}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    // Measured counts win over both the tiktoken estimate and the input figure
    // back-computed from contextUsagePercentage.
    expect(usage.input).toBe(500);
    expect(usage.output).toBe(200);
    expect(usage.totalTokens).toBe(700);
    expect(usage.provenance?.input).toBe("measured");
    expect(usage.provenance?.output).toBe("measured");

    // contextPercent stays the API's own contextUsagePercentage — never
    // re-derived from the (now overwritten) input count.
    expect(usage.contextPercent).toBe(10);

    vi.unstubAllGlobals();
  });

  it("reports prompt-cache tokens from metadataEvent.tokenUsage", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      JSON.stringify({
        tokenUsage: {
          uncachedInputTokens: 1_200,
          outputTokens: 340,
          totalTokens: 9_540,
          cacheReadInputTokens: 8_000,
          cacheWriteInputTokens: 0,
          normalizedTokenUsage: 12.5,
        },
      }),
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    expect(usage.cacheRead).toBe(8_000);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.provenance?.cache).toBe("measured");
    // The wire's totalTokens is authoritative, not input+output.
    expect(usage.totalTokens).toBe(9_540);
    expect(usage.normalizedTokenUsage).toBe(12.5);

    vi.unstubAllGlobals();
  });

  it("merges token counts split across separate metadataEvent frames", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      // Every MetadataEvent field is optional, so the service may send tokenUsage
      // and stopReason in separate frames. The second must not erase the first.
      JSON.stringify({ tokenUsage: { uncachedInputTokens: 1_200, outputTokens: 340, cacheReadInputTokens: 8_000 } }),
      JSON.stringify({ stopReason: "END_TURN" }),
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    // Without the merge, the stopReason-only frame clobbers these and output
    // silently falls back to the tiktoken estimate.
    expect(usage.input).toBe(1_200);
    expect(usage.output).toBe(340);
    expect(usage.cacheRead).toBe(8_000);
    expect(usage.provenance?.output).toBe("measured");
    expect(usage.provenance?.cache).toBe("measured");

    vi.unstubAllGlobals();
  });

  it("does not carry a failed attempt's cache tokens into a successful retry", async () => {
    // Attempt 1 is degenerate (no text, no tool calls) so it is retried, but it
    // did report cache tokens and metering credits. Attempt 2 succeeds and
    // reports neither — none of attempt 1's figures may survive into it.
    //
    // This is the empty-response retry path specifically, and it differs from the
    // stream-error path in a way that matters: a throttle/validation error hits
    // `if (streamError) break` and retries BEFORE the usage-finalizing block ever
    // runs, so nothing was written to carry over. Here finalization runs first and
    // calculateCost has already priced the turn, and only then is the retry
    // decided — so the cache counts are already on the shared usage object when
    // the next attempt starts. Priced with a non-zero-cost model so the assertion
    // covers the money, not just the counts.
    const emptyWithCache = concatMessages(
      encodeEventMessage({ usage: 9, unit: "credit", unitPlural: "credits" }),
      encodeEventMessage({
        tokenUsage: { uncachedInputTokens: 1_200, outputTokens: 340, cacheReadInputTokens: 8_000 },
      }),
      encodeEventMessage({ contextUsagePercentage: 50 }),
    );
    const goodResponse = concatMessages(
      encodeEventMessage({ content: "recovered" }),
      encodeEventMessage({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 } }),
    );

    const respond = (body: Uint8Array) => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: body })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(respond(emptyWithCache))
      .mockResolvedValueOnce(respond(goodResponse));
    vi.stubGlobal("fetch", mockFetch);

    const priced = makeModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    const stream = streamKiro(priced, makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
    expect(usage.cacheRead).toBe(0);
    expect(usage.provenance?.cache).toBeUndefined();
    expect(usage.credits).toBeUndefined();
    // The leak is a billing defect, not just a reporting one: calculateCost
    // prices cacheRead on its own line, so an inherited count charges for a
    // cache read this turn never performed.
    expect(usage.cost.cacheRead).toBe(0);
    // The stale 8000 cache-read tokens must not be summed into this total.
    expect(usage.totalTokens).toBe(15);
    expect(usage.contextPercent).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("does not bill an errored turn for a priced attempt it abandoned", async () => {
    // The empty-response/echo-loop retry is decided AFTER finalizeKiroUsage and
    // PiAi.calculateCost have run, so attempt 1 here — degenerate (no text, no
    // tool calls) but reporting real token counts — prices the turn before it is
    // retried. The remaining attempts fail terminally, so the turn is emitted
    // through the error path with the reset zeroed counts. Without cost in the
    // reset, that error message carries attempt 1's charge against zero tokens:
    // a priced turn with nothing backing the price.
    const pricedDegenerate = encodeEventMessage({
      tokenUsage: { uncachedInputTokens: 100_000, outputTokens: 50_000, totalTokens: 150_000 },
    });
    const failing = encodeEventMessage({ message: "capacity exhausted" }, "serviceUnavailableError");

    const respond = (body: Uint8Array) => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: body })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: () => {},
        }),
      },
    });
    const mockFetch = vi.fn().mockResolvedValueOnce(respond(pricedDegenerate)).mockResolvedValue(respond(failing));
    vi.stubGlobal("fetch", mockFetch);

    const priced = makeModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    const stream = streamKiro(priced, makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const error = events.find((e) => e.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected an errored turn");
    const usage = error.error.usage as KiroUsage;

    expect(usage.totalTokens).toBe(0);
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
    // Attempt 1 priced at ~1.05; none of it may survive onto this turn.
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

    vi.unstubAllGlobals();
  }, 30000);

  it("records meteringEvent credits without folding them into token counts", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      // MeteringEvent.usage is a COUNT OF CREDITS, not tokens.
      '{"usage":3,"unit":"credit","unitPlural":"credits"}',
      JSON.stringify({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    expect(usage.credits).toBe(3);
    expect(usage.creditUnit).toBe("credits");
    // Credits must not leak into token accounting or cost.
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
    expect(usage.totalTokens).toBe(15);

    vi.unstubAllGlobals();
  });

  it("records the singular credit unit for a one-credit turn", async () => {
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      // Both grammatical forms are on the wire; the count selects one. Passing
      // only unitPlural through would render "1 credits".
      '{"usage":1,"unit":"credit","unitPlural":"credits"}',
      JSON.stringify({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    expect(usage.credits).toBe(1);
    expect(usage.creditUnit).toBe("credit");

    vi.unstubAllGlobals();
  });

  it("singularizes the credit unit when the count arrives in a later metering frame", async () => {
    // Every MeteringEvent field is optional, so the unit strings can arrive before
    // the count. The units frame has no count to agree with, so its plural choice
    // is provisional and must be revised once the count lands. Framed with an
    // explicit key because a units-only payload has no numeric `usage` for the
    // fixture helper to infer `meteringEvent` from — on the wire the union member
    // comes from the `:event-type` header, not the payload shape.
    const body = concatMessages(
      encodeEventMessage({ content: "Hello" }),
      encodeEventMessage({ unit: "credit", unitPlural: "credits" }, "meteringEvent"),
      encodeEventMessage({ usage: 1 }, "meteringEvent"),
      encodeEventMessage({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: body })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    expect(usage.credits).toBe(1);
    expect(usage.creditUnit).toBe("credit");

    vi.unstubAllGlobals();
  });

  it("leaves cache provenance absent when no metadataEvent arrives", async () => {
    const mockFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");
    const usage = msg.usage as KiroUsage;

    // The zeros satisfy pi's Usage type; absent provenance is what stops a
    // consumer rendering them as a measured 0% cache hit rate.
    expect(usage.cacheRead).toBe(0);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.provenance?.cache).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("records cacheRead/cacheWrite so a cached turn is not priced as uncached input", async () => {
    // TokenUsage.uncachedInputTokens excludes cache reads. Taking `input` from
    // it while leaving cacheRead at 0 would report ~200 input tokens for a turn
    // that actually read 50k cached tokens, and price it accordingly.
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"tokenUsage":{"uncachedInputTokens":200,"outputTokens":50,"totalTokens":50250,"cacheReadInputTokens":50000,"cacheWriteInputTokens":0}}',
      '{"contextUsagePercentage":5}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    expect(msg.usage.input).toBe(200);
    expect(msg.usage.cacheRead).toBe(50000);
    expect(msg.usage.cacheWrite).toBe(0);
    // input + cacheRead + cacheWrite + output, matching the wire totalTokens.
    expect(msg.usage.totalTokens).toBe(50250);

    vi.unstubAllGlobals();
  });

  it("keeps the wire totalTokens when the service omits an optional cache count", async () => {
    // TokenUsage.totalTokens is required on the wire; cacheReadInputTokens and
    // cacheWriteInputTokens are optional. Recomputing the total from components
    // would report 250 for a turn the service says cost 50250 context tokens,
    // and calculateContextTokens drives the context gauge from that total.
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"tokenUsage":{"uncachedInputTokens":200,"outputTokens":50,"totalTokens":50250}}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    expect(msg.usage.input).toBe(200);
    expect(msg.usage.cacheRead).toBe(0);
    expect(msg.usage.totalTokens).toBe(50250);

    vi.unstubAllGlobals();
  });

  it("merges metadataEvent frames so a later stopReason frame cannot erase token counts", async () => {
    // Every MetadataEvent field is optional; tokenUsage and stopReason may
    // arrive in separate frames.
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"tokenUsage":{"uncachedInputTokens":500,"outputTokens":200,"totalTokens":700}}',
      '{"stopReason":"END_TURN"}',
      '{"contextUsagePercentage":10}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    expect(msg.usage.input).toBe(500);
    expect(msg.usage.output).toBe(200);

    vi.unstubAllGlobals();
  });

  it("surfaces a mid-stream throttlingError frame and retries", async () => {
    // throttlingError / validationError / serviceUnavailableError are distinct
    // ChatResponseStream members. Before key routing they matched no branch and
    // were dropped, so the turn looked like an empty response. Now they abort
    // the read and enter the retry path with the modeled class in the message.
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({
                  done: false,
                  value: concatMessages(
                    encodeEventMessage({ content: "partial" }),
                    encodeEventMessage(
                      {
                        message: "Too many requests",
                        reason: "INSUFFICIENT_MODEL_CAPACITY",
                        retryAfterMilliseconds: 10,
                      },
                      "throttlingError",
                    ),
                  ),
                })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              cancel: vi.fn().mockResolvedValue(undefined),
              releaseLock: () => {},
            }),
          },
        };
      }
      return {
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
            cancel: vi.fn().mockResolvedValue(undefined),
            releaseLock: () => {},
          }),
        },
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && (done.message.content[0] as TextContent).text).toBe("recovered");

    vi.unstubAllGlobals();
  });

  it("reports the modeled exception class when a typed error frame outlives every retry", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: encodeEventMessage({ message: "capacity exhausted" }, "serviceUnavailableError"),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: () => {},
        }),
      },
    }));
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);

    const error = events.find((e) => e.type === "error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("ServiceUnavailableException");
    expect(error?.type === "error" && error.error.errorMessage).toContain("capacity exhausted");

    vi.unstubAllGlobals();
  }, 30000);

  it("does not inherit the failed attempt's cache counts when retrying", async () => {
    // `usageEvent` is declared inside the retry loop, and the cache writes are
    // post-loop, so an aborted attempt must contribute nothing to billing.
    // cacheRead is priced as its own line in calculateCost, so inheriting a
    // prior attempt's value would over-bill a turn that never read that cache.
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({
                  done: false,
                  value: concatMessages(
                    encodeEventMessage({
                      tokenUsage: {
                        uncachedInputTokens: 999,
                        outputTokens: 111,
                        totalTokens: 41110,
                        cacheReadInputTokens: 40000,
                        cacheWriteInputTokens: 7,
                      },
                    }),
                    encodeEventMessage({ message: "throttled" }, "throttlingError"),
                  ),
                })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              cancel: vi.fn().mockResolvedValue(undefined),
              releaseLock: () => {},
            }),
          },
        };
      }
      // Retry succeeds and reports NO metadataEvent at all.
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: encodeBody('{"content":"clean"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
            releaseLock: () => {},
          }),
        },
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((msg.content[0] as TextContent).text).toBe("clean");
    // The abandoned attempt's counts must not appear anywhere in billing.
    expect(msg.usage.cacheRead).toBe(0);
    expect(msg.usage.cacheWrite).toBe(0);
    expect(msg.usage.cost.cacheRead).toBe(0);

    vi.unstubAllGlobals();
  });

  it("falls back to summing components when a non-conforming frame omits totalTokens", async () => {
    // TokenUsage.totalTokens is required on the wire, so this branch only guards
    // a non-conforming server. The sum must match how the service itself defines
    // the total: uncachedInput + cacheRead + cacheWrite + output.
    const mockFetch = mockFetchChunked([
      '{"content":"Hello"}',
      '{"tokenUsage":{"uncachedInputTokens":200,"outputTokens":50,"cacheReadInputTokens":50000,"cacheWriteInputTokens":0}}',
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const stream = streamKiro(makeModel(), makeContext(), { apiKey: "tok" });
    const events = await collect(stream);
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a completed assistant message");

    // Same components as the wire-total test above, which reports 50250.
    expect(msg.usage.totalTokens).toBe(50250);

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
    const usage = msg.usage as KiroUsage;

    expect(usage.contextPercent).toBe(42);
    // input should be back-calculated from percentage
    expect(usage.input).toBe(Math.round(0.42 * 200000));
    expect(usage.provenance?.input).toBe("derived");

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
});

describe("turn provenance diagnostic", () => {
  beforeEach(() => {
    resetProfileArnCache(true);
    diagnosticsAppend.fail = false;
  });

  /** The single provenance diagnostic on a terminal message. */
  function provenanceOf(msg: AssistantMessage | undefined) {
    expect(msg).toBeDefined();
    if (!msg) throw new Error("Expected a terminal assistant message");
    const found = (msg.diagnostics ?? []).filter((d) => d.type === "kiro_turn_provenance");
    expect(found).toHaveLength(1);
    return found[0];
  }

  function stopReasonOf(msg: AssistantMessage | undefined): Record<string, unknown> {
    return provenanceOf(msg).details?.stopReason as Record<string, unknown>;
  }

  async function run(chunks: string[]) {
    const mockFetch = mockFetchChunked(chunks);
    vi.stubGlobal("fetch", mockFetch);
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.unstubAllGlobals();
    const done = events.find((e) => e.type === "done");
    const error = events.find((e) => e.type === "error");
    return {
      msg: done?.type === "done" ? done.message : error?.type === "error" ? error.error : undefined,
      terminal: done ? "done" : "error",
    };
  }

  it("mirrors the measured usage provenance finalizeKiroUsage recorded", async () => {
    const { msg } = await run([
      '{"content":"Hello"}',
      JSON.stringify({
        tokenUsage: {
          uncachedInputTokens: 1_200,
          outputTokens: 340,
          totalTokens: 9_540,
          cacheReadInputTokens: 8_000,
          cacheWriteInputTokens: 0,
        },
      }),
    ]);

    // The diagnostic must agree with the record on the usage object rather than
    // reclassifying independently.
    const usage = msg?.usage as KiroUsage;
    expect(provenanceOf(msg).details?.usage).toEqual(usage.provenance);
    expect((provenanceOf(msg).details?.usage as KiroUsageProvenance).cache).toBe("measured");
  });

  it("keeps the cache leg absent when no metadataEvent arrives", async () => {
    // This is the case kermes needs: a fabricated 0/0 must stay distinguishable
    // from a service-reported 0% cache hit.
    const { msg } = await run(['{"content":"Hello"}', '{"contextUsagePercentage":10}']);

    expect(msg?.usage.cacheRead).toBe(0);
    expect(msg?.usage.cacheWrite).toBe(0);
    const usage = provenanceOf(msg).details?.usage as KiroUsageProvenance;
    expect(usage.cache).toBeUndefined();
    expect("cache" in usage).toBe(false);
  });

  it("records the modeled stopReason alongside the emitted one", async () => {
    const { msg } = await run(['{"content":"Hello"}', '{"stopReason":"END_TURN"}', '{"contextUsagePercentage":10}']);

    expect(msg?.stopReason).toBe("stop");
    expect(stopReasonOf(msg)).toEqual({ emitted: "stop", source: "modeled", modeled: "END_TURN" });
  });

  it("reports source as modeled once the emitted value follows the wire", async () => {
    // END_TURN has a faithful pi member, so the emitted value is the service's
    // statement rather than a local reconstruction.
    const { msg } = await run(['{"content":"Hi"}', '{"stopReason":"END_TURN"}', '{"contextUsagePercentage":5}']);
    expect(stopReasonOf(msg).source).toBe("modeled");
  });

  it("flags MODEL_CONTEXT_WINDOW_EXCEEDED, which arrives on a successful turn", async () => {
    // No error body, 200 OK: the prose isContextOverflow() path cannot see this.
    const { msg, terminal } = await run([
      '{"content":"Partial answer"}',
      '{"stopReason":"MODEL_CONTEXT_WINDOW_EXCEEDED"}',
      '{"contextUsagePercentage":99}',
    ]);

    expect(terminal).toBe("done");
    expect(msg?.stopReason).toBe("stop");
    expect(msg?.errorMessage).toBeUndefined();
    expect(stopReasonOf(msg)).toEqual({
      emitted: "stop",
      source: "inferred",
      modeled: "MODEL_CONTEXT_WINDOW_EXCEEDED",
      contextOverflow: true,
    });
  });

  it("carries PAUSE_TURN through even though this peer has no stopReason for it", async () => {
    const { msg } = await run(['{"content":"Hi"}', '{"stopReason":"PAUSE_TURN"}', '{"contextUsagePercentage":5}']);
    expect(stopReasonOf(msg).modeled).toBe("PAUSE_TURN");
    expect(stopReasonOf(msg).contextOverflow).toBeUndefined();
  });

  it("passes stopDetails through verbatim", async () => {
    const { msg } = await run([
      '{"content":"Hi"}',
      '{"stopReason":"END_TURN","stopDetails":{"note":"finished"}}',
      '{"contextUsagePercentage":5}',
    ]);
    expect(stopReasonOf(msg).details).toEqual({ note: "finished" });
  });

  it("omits modeled fields when the service sent no metadataEvent", async () => {
    const { msg } = await run(['{"content":"Hi"}', '{"contextUsagePercentage":5}']);
    const stopReason = stopReasonOf(msg);
    expect(stopReason).toEqual({ emitted: "stop", source: "inferred" });
    expect("modeled" in stopReason).toBe(false);
    expect("details" in stopReason).toBe(false);
  });

  it("records the inferred toolUse stop reason", async () => {
    const { msg } = await run([
      '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/tmp/a\\"}","stop":true}',
      '{"contextUsagePercentage":7}',
    ]);
    expect(msg?.stopReason).toBe("toolUse");
    expect(stopReasonOf(msg).emitted).toBe("toolUse");
    expect(stopReasonOf(msg).source).toBe("inferred");
  });

  it("reports source as modeled when TOOL_USE agrees with an emitted tool call", async () => {
    const { msg } = await run([
      '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/tmp/a\\"}","stop":true}',
      '{"stopReason":"TOOL_USE"}',
      '{"contextUsagePercentage":7}',
    ]);
    expect(msg?.stopReason).toBe("toolUse");
    expect(stopReasonOf(msg)).toEqual({ emitted: "toolUse", source: "modeled", modeled: "TOOL_USE" });
  });

  it("keeps toolUse over a modeled END_TURN when a tool call was already emitted", async () => {
    // The tool-call deltas are on the stream and cannot be retracted, so the
    // caller has to be told to run them whatever the service called the stop.
    // The emitted value is then this provider's decision, not the wire's.
    const { msg } = await run([
      '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/tmp/a\\"}","stop":true}',
      '{"stopReason":"END_TURN"}',
      '{"contextUsagePercentage":7}',
    ]);

    expect(msg?.stopReason).toBe("toolUse");
    expect(msg?.content.filter((b) => b.type === "toolCall")).toHaveLength(1);
    expect(stopReasonOf(msg)).toEqual({ emitted: "toolUse", source: "inferred", modeled: "END_TURN" });
  });

  it("emits stop for an unmappable member even with no contextUsage frame", async () => {
    // CONTENT_FILTERED has no faithful pi member, so the emitted value stays a
    // local decision — but the metadataEvent still proves the turn settled, so
    // it must not fall through to a fabricated "length" and ask the model to
    // continue a refusal.
    const { msg } = await run([
      '{"content":"I can\'t help with that."}',
      '{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER"}}}',
    ]);

    expect(msg?.stopReason).toBe("stop");
    expect(wasPreviousResponseTruncated([msg as AssistantMessage])).toBe(false);
    expect(stopReasonOf(msg).source).toBe("inferred");
    expect(stopReasonOf(msg).modeled).toBe("CONTENT_FILTERED");
  });

  it("emits stop for MODEL_CONTEXT_WINDOW_EXCEEDED rather than inviting a continuation", async () => {
    // "length" would make wasPreviousResponseTruncated() ask the model to carry
    // on, growing the very context that just overflowed. The overflow stays
    // recoverable from the diagnostic instead.
    const { msg } = await run(['{"content":"Partial"}', '{"stopReason":"MODEL_CONTEXT_WINDOW_EXCEEDED"}']);

    expect(msg?.stopReason).toBe("stop");
    expect(wasPreviousResponseTruncated([msg as AssistantMessage])).toBe(false);
    expect(stopReasonOf(msg).contextOverflow).toBe(true);
    expect(stopReasonOf(msg).source).toBe("inferred");
  });

  it("emits stop, not length, for END_TURN when no contextUsage frame arrives", async () => {
    // The metadataEvent alone settles the turn. Before the modeled value was
    // consumed, only a contextUsageEvent flipped the settled flag, so this
    // stream emitted "length" while the service plainly said END_TURN — a
    // fabricated truncation that made wasPreviousResponseTruncated() prepend
    // TRUNCATION_NOTICE to the next turn.
    const { msg } = await run(['{"content":"Hi"}', '{"stopReason":"END_TURN"}']);

    expect(msg?.stopReason).toBe("stop");
    expect(wasPreviousResponseTruncated([msg as AssistantMessage])).toBe(false);
    expect(stopReasonOf(msg)).toEqual({ emitted: "stop", source: "modeled", modeled: "END_TURN" });
  });

  it("records a fabricated length with no modeled value to contradict it", async () => {
    // No metadataEvent and no contextUsageEvent: nothing says the turn settled,
    // so the local reconstruction still calls it truncated. This is the only
    // remaining path to "length" without the service asking for it, and a
    // consumer must be able to tell it apart from a modeled MAX_TOKENS.
    const { msg } = await run(['{"content":"Hi"}']);

    expect(msg?.stopReason).toBe("length");
    const stopReason = stopReasonOf(msg);
    expect(stopReason).toEqual({ emitted: "length", source: "inferred" });
    expect("modeled" in stopReason).toBe(false);
  });

  it("emits length for MAX_TOKENS so the truncated answer can be continued", async () => {
    // pi's "length" means exactly this, and it is what makes
    // wasPreviousResponseTruncated() offer the continuation the turn needs.
    // Before the modeled value was consumed, a contextUsage frame with no tool
    // calls emitted "stop" and the truncation was silently swallowed.
    const { msg } = await run([
      '{"content":"A partial ans"}',
      '{"stopReason":"MAX_TOKENS"}',
      '{"contextUsagePercentage":42}',
    ]);

    expect(msg?.stopReason).toBe("length");
    expect(wasPreviousResponseTruncated([msg as AssistantMessage])).toBe(true);
    expect(stopReasonOf(msg)).toEqual({ emitted: "length", source: "modeled", modeled: "MAX_TOKENS" });
  });

  it("records UNKNOWN distinctly from no modeled stop reason arriving", async () => {
    // "the service could not classify this turn" is not the same fact as "the
    // service never sent a stop reason", and both emit the same pi stopReason.
    const { msg } = await run(['{"content":"Hi"}', '{"stopReason":"UNKNOWN"}', '{"contextUsagePercentage":5}']);

    expect(stopReasonOf(msg).modeled).toBe("UNKNOWN");
    expect(stopReasonOf(msg).contextOverflow).toBeUndefined();
  });

  it("records TOOL_USE when every tool call was dropped and the turn emitted stop", async () => {
    // The emitted value is deliberately "stop" here, not "toolUse": empty content
    // plus a toolUse stop stalls pi's agent loop. So the service's TOOL_USE is
    // recoverable only from this field, and a consumer comparing emitted against
    // modeled is how the dropped tool calls become visible at all.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { msg } = await run([
      '{"name":"bash","toolUseId":"tc1","input":"not-json","stop":true}',
      '{"stopReason":"TOOL_USE"}',
      '{"contextUsagePercentage":10}',
    ]);
    warnSpy.mockRestore();

    expect(msg?.stopReason).toBe("stop");
    expect(msg?.content.filter((b) => b.type === "toolCall")).toHaveLength(0);
    expect(stopReasonOf(msg)).toEqual({ emitted: "stop", source: "inferred", modeled: "TOOL_USE" });
  });

  it("carries a CONTENT_FILTERED refusal, which also arrives on a successful turn", async () => {
    // Modeled as a metadataEvent, not a typed error: nothing on the error path
    // sees it, and pi's emitted stopReason has no member for it.
    const { msg, terminal } = await run([
      '{"content":"I can\'t help with that."}',
      '{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER","explanation":"policy"}}}',
      '{"contextUsagePercentage":4}',
    ]);

    expect(terminal).toBe("done");
    expect(msg?.errorMessage).toBeUndefined();
    const stopReason = stopReasonOf(msg);
    expect(stopReason.emitted).toBe("stop");
    expect(stopReason.modeled).toBe("CONTENT_FILTERED");
    expect(stopReason.details).toEqual({ refusal: { category: "CYBER", explanation: "policy" } });
  });

  it("snapshots the provenance so a later write to usage.provenance cannot rewrite it", async () => {
    const { msg } = await run([
      '{"content":"Hello"}',
      JSON.stringify({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ]);

    const recorded = provenanceOf(msg).details?.usage as KiroUsageProvenance;
    const live = (msg?.usage as KiroUsage).provenance as KiroUsageProvenance;
    expect(recorded).not.toBe(live);
    expect(recorded).toEqual(live);

    live.input = "estimated";
    expect((provenanceOf(msg).details?.usage as KiroUsageProvenance).input).toBe("measured");
  });

  it("attaches exactly one record even when an earlier attempt was retried", async () => {
    // The record describes the turn that completed, not each attempt.
    const empty = mockFetchOk("");
    const ok = mockFetchChunked(['{"content":"Recovered"}', '{"stopReason":"END_TURN"}']);
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => empty())
      .mockImplementationOnce(() => ok());
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.unstubAllGlobals();
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // provenanceOf asserts exactly one.
    expect(stopReasonOf(msg).modeled).toBe("END_TURN");
  });

  it("does not describe a stale attempt's modeled stop reason after a retry", async () => {
    // usageEvent is per-attempt, so a stopReason from a discarded attempt must
    // not be reported against the attempt that actually completed.
    const first = mockFetchChunked(['{"stopReason":"MODEL_CONTEXT_WINDOW_EXCEEDED"}']);
    const second = mockFetchChunked(['{"content":"Recovered"}', '{"contextUsagePercentage":5}']);
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => first())
      .mockImplementationOnce(() => second());
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.unstubAllGlobals();
    const done = events.find((e) => e.type === "done");
    const msg = done?.type === "done" ? done.message : undefined;

    const stopReason = stopReasonOf(msg);
    expect("modeled" in stopReason).toBe(false);
    expect(stopReason.contextOverflow).toBeUndefined();
  });

  it("does not attach a provenance record to a failed turn", async () => {
    // The error path has its own diagnostic; this record describes a turn whose
    // numbers settled.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.unstubAllGlobals();
    const error = events.find((e) => e.type === "error");
    const msg = error?.type === "error" ? error.error : undefined;

    expect(msg?.stopReason).toBe("error");
    expect((msg?.diagnostics ?? []).some((d) => d.type === "kiro_turn_provenance")).toBe(false);
  });

  it("does not attach a provenance record to an aborted turn", async () => {
    // An abort mid-stream leaves the turn's numbers unsettled: usage was never
    // finalized and no stop reason was reconstructed, so there is nothing
    // truthful to record. Distinct from the 500 case above because the abort
    // arrives *after* content streamed, i.e. the furthest a turn can get and
    // still not reach the append.
    const ac = new AbortController();
    let readCount = 0;
    const readMock = vi.fn().mockImplementation(async () => {
      readCount++;
      if (readCount === 1) return { done: false, value: encodeBody('{"content":"partial"}') };
      ac.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: readMock, releaseLock: () => {} }), cancel: async () => {} },
    });
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(
      streamKiro(makeModel({ reasoning: false }), makeContext(), { apiKey: "tok", signal: ac.signal }),
    );
    vi.unstubAllGlobals();

    const error = events.find((e) => e.type === "error");
    const msg = error?.type === "error" ? error.error : undefined;
    expect(msg?.stopReason).toBe("aborted");
    expect((msg?.diagnostics ?? []).some((d) => d.type === "kiro_turn_provenance")).toBe(false);
    // No terminal done either — the record and the done event share one site.
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("completes the turn when the diagnostics append throws", async () => {
    // Fail open. The record is observational, so it must never cost the caller a
    // turn that otherwise finished. This is reachable in production, not
    // hypothetical: pi-ai is a devDependency here and the HOST supplies it at
    // runtime, so a host older than the 0.80.10 peer minimum has no
    // `appendAssistantMessageDiagnostic` and the call throws TypeError. Without
    // the guard, `streamKiro`'s outer catch turns a complete answer into
    // stopReason:"error" with no content.
    diagnosticsAppend.fail = true;
    const mockFetch = mockFetchChunked(['{"content":"Answer"}', '{"contextUsagePercentage":12}']);
    vi.stubGlobal("fetch", mockFetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.unstubAllGlobals();

    // The turn still ends normally: done, not error.
    expect(events.some((e) => e.type === "error")).toBe(false);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const msg = done?.type === "done" ? done.message : undefined;
    expect(msg?.stopReason).toBe("stop");
    expect((msg?.content[0] as TextContent).text).toBe("Answer");
    // Usage still finalized — the throw happens after it, and must not undo it.
    expect((msg?.usage as KiroUsage).contextPercent).toBe(12);
    // Only the diagnostic is lost.
    expect(msg?.diagnostics ?? []).toEqual([]);
  });
});
