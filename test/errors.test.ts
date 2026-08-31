import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { extractKiroReasonCode, KiroApiError, parseRetryAfterMs } from "../src/errors.js";
import { capacityRetryConfig } from "../src/retry.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";

type TestKiroModel = Model<Api> & { kiroProfileArn?: string };

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

function makeContext(): Context {
  return {
    systemPrompt: "You are helpful",
    messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
    tools: [],
  };
}

async function collect(stream: ReturnType<typeof streamKiro>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

/** Drive one failed request and return the terminal error event's message. */
async function failedRequest(
  response: { status: number; statusText: string; body: string; headers?: Record<string, string> },
  model = makeModel(),
): Promise<AssistantMessage> {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: false,
    status: response.status,
    statusText: response.statusText,
    text: () => Promise.resolve(response.body),
    ...(response.headers ? { headers: new Headers(response.headers) } : {}),
  });
  vi.stubGlobal("fetch", mockFetch);
  // Mark profileArn as already resolved so the mock only sees the runtime call.
  resetProfileArnCache(true);
  try {
    const events = await collect(streamKiro(model, makeContext(), { apiKey: "tok" }));
    const error = events.find((e) => e.type === "error");
    if (!error || error.type !== "error") throw new Error("expected a terminal error event");
    return error.error;
  } finally {
    vi.unstubAllGlobals();
  }
}

function kiroDiagnostic(message: AssistantMessage) {
  return message.diagnostics?.find((d) => d.type === "kiro_api_error");
}

describe("KiroApiError", () => {
  it("keeps Error semantics for consumers that only read the string", () => {
    const error = new KiroApiError("Kiro API error: boom", 500);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(KiroApiError);
    expect(error.message).toBe("Kiro API error: boom");
    expect(error.name).toBe("KiroApiError");
    expect(String(error)).toBe("KiroApiError: Kiro API error: boom");
    expect(error.stack).toContain("Kiro API error: boom");
  });

  it("leaves optional classification undefined when the throw site had none", () => {
    const error = new KiroApiError("Kiro API error: boom", 500);

    expect(error.status).toBe(500);
    expect(error.reasonCode).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.providerAttempts).toBeUndefined();
  });
});

describe("extractKiroReasonCode", () => {
  it("prefers the parsed JSON reason field over text scanning", () => {
    expect(extractKiroReasonCode('{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}')).toBe(
      "REQUEST_BODY_INVALID",
    );
  });

  it("accepts the reasonCode spelling", () => {
    expect(extractKiroReasonCode('{"reasonCode":"MONTHLY_REQUEST_COUNT"}')).toBe("MONTHLY_REQUEST_COUNT");
  });

  it("passes through an unrecognized reason verbatim", () => {
    expect(extractKiroReasonCode('{"reason":"SOME_FUTURE_CODE"}')).toBe("SOME_FUTURE_CODE");
  });

  it("falls back to a marker scan for non-JSON and wrapped bodies", () => {
    expect(extractKiroReasonCode("CONTENT_LENGTH_EXCEEDS_THRESHOLD")).toBe("CONTENT_LENGTH_EXCEEDS_THRESHOLD");
    expect(extractKiroReasonCode("MONTHLY_REQUEST_COUNT exceeded")).toBe("MONTHLY_REQUEST_COUNT");
    expect(extractKiroReasonCode("INSUFFICIENT_MODEL_CAPACITY")).toBe("INSUFFICIENT_MODEL_CAPACITY");
    // Truncated JSON still classifies rather than throwing.
    expect(extractKiroReasonCode('{"reason":"REQUEST_BODY_INVALID"')).toBe("REQUEST_BODY_INVALID");
  });

  it("returns undefined rather than inventing a code", () => {
    expect(extractKiroReasonCode("")).toBeUndefined();
    expect(extractKiroReasonCode("Input is too long")).toBeUndefined();
    expect(extractKiroReasonCode("Improperly formed request")).toBeUndefined();
    expect(extractKiroReasonCode('{"reason":123}')).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  it("reads retry-after delay-seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "30" }))).toBe(30_000);
  });

  it("prefers millisecond precision when offered", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500", "retry-after": "30" }))).toBe(1500);
  });

  it("reads retry-after HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-07T10:00:00Z");
    const headers = new Headers({ "retry-after": "Fri, 07 Aug 2026 10:00:20 GMT" });

    expect(parseRetryAfterMs(headers, now)).toBe(20_000);
  });

  it("clamps a past HTTP-date to zero instead of returning a negative delay", () => {
    const now = Date.parse("2026-08-07T10:00:00Z");
    const headers = new Headers({ "retry-after": "Fri, 07 Aug 2026 09:59:00 GMT" });

    expect(parseRetryAfterMs(headers, now)).toBe(0);
  });

  it("falls back to x-ratelimit-reset-after", () => {
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-after": "12" }))).toBe(12_000);
  });

  it("lets a later header win when an earlier one is malformed", () => {
    // A garbage value in one header must not suppress a usable value in another.
    expect(parseRetryAfterMs(new Headers({ "retry-after": "-5", "x-ratelimit-reset-after": "12" }))).toBe(12_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "nope", "retry-after": "7" }))).toBe(7_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon", "x-ratelimit-reset-after": "3" }))).toBe(3_000);
  });

  it("treats an explicit zero as zero and an absent header as unknown", () => {
    // Number(null) is 0, so absence must not read as a legitimate 0ms delay.
    expect(parseRetryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "0" }))).toBe(0);
    expect(parseRetryAfterMs(new Headers({ "content-type": "application/json" }))).toBeUndefined();
  });

  it("tolerates absent, headerless, and unparseable inputs", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({} as unknown as Headers)).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({}))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "-5" }))).toBeUndefined();
  });
});

// =========================================================================
// Emitted `message` text is a cross-package contract.
//
// pi-ai's isContextOverflow(), pi-coding-agent's outer auto-retry, and
// downstream consumers all string-match these. Pinned byte-for-byte so a
// future refactor cannot silently break any of the three matchers. Valuable
// independently of the typed fields below.
// =========================================================================
describe("thrown message text (pinned)", () => {
  it("pins the quota/capacity message: body only, no status code", async () => {
    const message = await failedRequest({
      status: 429,
      statusText: "Too Many Requests",
      body: "MONTHLY_REQUEST_COUNT exceeded",
    });

    expect(message.errorMessage).toBe("Kiro API error: MONTHLY_REQUEST_COUNT exceeded");
  });

  it("pins the quota message when the marker arrives with other body text", async () => {
    // The `|| safeStatusText` fallback in this branch is unreachable in
    // practice: classification reads the *body*, so an empty body cannot
    // select the quota branch at all (see the 402 case below).
    const message = await failedRequest({
      status: 402,
      statusText: "Payment Required",
      body: '{"message":"Free tier limit reached","reason":"MONTHLY_REQUEST_COUNT"}',
    });

    expect(message.errorMessage).toBe(
      'Kiro API error: {"message":"Free tier limit reached","reason":"MONTHLY_REQUEST_COUNT"}',
    );
  });

  it("pins the generic message for an empty body, keeping the trailing space", async () => {
    const message = await failedRequest({ status: 402, statusText: "Payment Required", body: "" });

    // Trailing space is load-bearing only in the sense that it is what ships
    // today; pinned so a cosmetic cleanup is a deliberate contract decision.
    expect(message.errorMessage).toBe("Kiro API error: 402 Payment Required ");
  });

  it("pins the too-big message so isContextOverflow() keeps recognizing it", async () => {
    const model = makeModel();
    const message = await failedRequest(
      { status: 400, statusText: "Bad Request", body: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" },
      model,
    );

    expect(message.errorMessage).toBe("Kiro API error: context_length_exceeded (400 CONTENT_LENGTH_EXCEEDS_THRESHOLD)");
    expect(isContextOverflow(message, model.contextWindow)).toBe(true);
  });

  it("pins the generic message: status, statusText, body", async () => {
    const message = await failedRequest({
      status: 400,
      statusText: "Bad Request",
      body: "Invalid parameter: modelId",
    });

    expect(message.errorMessage).toBe("Kiro API error: 400 Bad Request Invalid parameter: modelId");
  });
});

// =========================================================================
// Typed classification, per reason code in src/retry.ts.
//
// streamKiro does not reject — per the pi-ai stream contract it encodes
// failures into the returned stream — so the typed fields surface on the
// terminal error event's `diagnostics` entry.
// =========================================================================
describe("typed classification per reason code", () => {
  it("classifies CONTENT_LENGTH_EXCEEDS_THRESHOLD as 400 too-big", async () => {
    const message = await failedRequest({
      status: 400,
      statusText: "Bad Request",
      body: '{"message":"Input too long","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}',
    });

    expect(kiroDiagnostic(message)?.details).toMatchObject({
      status: 400,
      reasonCode: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
      providerAttempts: { credentialRefresh: 0, capacity: 0 },
    });
  });

  it("classifies 'Input is too long' as 400 too-big with no reason code", async () => {
    const message = await failedRequest({
      status: 400,
      statusText: "Bad Request",
      body: "Input is too long.",
    });

    const details = kiroDiagnostic(message)?.details;
    expect(details).toMatchObject({ status: 400 });
    expect(details?.reasonCode).toBeUndefined();
    expect(message.errorMessage).toContain("context_length_exceeded");
  });

  it("classifies a plain 413 as too-big with no reason code", async () => {
    const message = await failedRequest({ status: 413, statusText: "Payload Too Large", body: "" });

    const details = kiroDiagnostic(message)?.details;
    expect(details).toMatchObject({ status: 413 });
    expect(details?.reasonCode).toBeUndefined();
    expect(message.errorMessage).toBe("Kiro API error: context_length_exceeded (413 )");
  });

  it("classifies MONTHLY_REQUEST_COUNT with its real status preserved", async () => {
    const message = await failedRequest({
      status: 429,
      statusText: "Too Many Requests",
      body: "MONTHLY_REQUEST_COUNT exceeded",
    });

    expect(kiroDiagnostic(message)?.details).toMatchObject({
      status: 429,
      reasonCode: "MONTHLY_REQUEST_COUNT",
    });
    // The status stays out of the *message* on purpose; it is only on the type.
    expect(message.errorMessage).not.toContain("429");
  });

  it("reports exhausted capacity retries in providerAttempts", async () => {
    const original = { ...capacityRetryConfig };
    capacityRetryConfig.baseDelayMs = 10;
    try {
      const message = await failedRequest({
        status: 429,
        statusText: "Too Many Requests",
        body: "INSUFFICIENT_MODEL_CAPACITY",
      });

      expect(kiroDiagnostic(message)?.details).toMatchObject({
        status: 429,
        reasonCode: "INSUFFICIENT_MODEL_CAPACITY",
        // A consumer can now tell a long stall was 3 capacity retries rather
        // than one slow call, instead of stacking a third backoff on top.
        providerAttempts: { credentialRefresh: 0, capacity: capacityRetryConfig.maxRetries },
      });
    } finally {
      Object.assign(capacityRetryConfig, original);
    }
  });

  it("reports consumed 403 credential-refresh retries in providerAttempts", async () => {
    // Two 403s each burn one credential-refresh retry, then a terminal 400
    // reaches a throw site. The tally must survive both outer-loop iterations:
    // `capacityRetryCount` is deliberately reset per iteration, so a
    // per-iteration counter would report 0 here.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve("Invalid parameter: modelId"),
      });
    vi.stubGlobal("fetch", mockFetch);
    resetProfileArnCache(true);
    try {
      const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      const error = events.find((e) => e.type === "error");
      if (!error || error.type !== "error") throw new Error("expected a terminal error event");

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(kiroDiagnostic(error.error)?.details).toMatchObject({
        status: 400,
        providerAttempts: { credentialRefresh: 2, capacity: 0 },
      });
      // The message stays the plain generic form — the retry accounting is
      // only ever on the type, never in the text.
      expect(error.error.errorMessage).toBe("Kiro API error: 400 Bad Request Invalid parameter: modelId");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies REQUEST_BODY_INVALID and does NOT call it too-big", async () => {
    const model = makeModel();
    const message = await failedRequest(
      {
        status: 400,
        statusText: "Bad Request",
        body: '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}',
      },
      model,
    );

    expect(kiroDiagnostic(message)?.details).toMatchObject({
      status: 400,
      reasonCode: "REQUEST_BODY_INVALID",
    });
    // Load-bearing negative control. Upstream already shipped this bug once:
    // labeling this 400 as context_length_exceeded sends the caller into a
    // compaction loop it can never satisfy — the request is invalid, not
    // oversized, so no amount of history reduction fixes it.
    expect(message.errorMessage).not.toContain("context_length_exceeded");
    expect(isContextOverflow(message, model.contextWindow)).toBe(false);
  });

  it("carries retryAfterMs when the response advertises one", async () => {
    const message = await failedRequest({
      status: 429,
      statusText: "Too Many Requests",
      body: "MONTHLY_REQUEST_COUNT exceeded",
      headers: { "retry-after": "42" },
    });

    expect(kiroDiagnostic(message)?.details).toMatchObject({ retryAfterMs: 42_000 });
  });

  it("omits retryAfterMs when the response advertises none", async () => {
    const message = await failedRequest({
      status: 400,
      statusText: "Bad Request",
      body: "Invalid parameter: modelId",
    });

    expect(kiroDiagnostic(message)?.details?.retryAfterMs).toBeUndefined();
  });

  it("mirrors the error message on the diagnostic", async () => {
    const message = await failedRequest({
      status: 400,
      statusText: "Bad Request",
      body: "Invalid parameter: modelId",
    });

    const diagnostic = kiroDiagnostic(message);
    expect(diagnostic?.error?.name).toBe("KiroApiError");
    expect(diagnostic?.error?.message).toBe(message.errorMessage);
  });

  it("adds no diagnostic when the request succeeds", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: concatMessages(
                encodeEventMessage({ content: "Hi" }),
                encodeEventMessage({ contextUsagePercentage: 5 }),
              ),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    });
    vi.stubGlobal("fetch", mockFetch);
    resetProfileArnCache(true);
    try {
      const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
      const done = events.find((e) => e.type === "done");

      expect(done?.type === "done" && done.message.diagnostics).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
