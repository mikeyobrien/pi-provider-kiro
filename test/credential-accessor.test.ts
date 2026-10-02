// Credential-accessor contract for streamKiro.
//
// A host that owns Kiro auth can pass a mutable `credentialAccessor` on stream
// options so a token refreshed mid-call survives the call:
//   - `get()` seeds each call from the freshest token the host holds;
//   - `set(creds)` receives a credential the provider refreshed mid-call, so the
//     host can persist it for the NEXT call and for sibling processes;
//   - `ensureFresh()` is awaited before the token is read, so a host that knows
//     the expiry can rotate it ahead of time instead of waiting for a 403.
// All are optional and best-effort. The provider falls back to the static
// `apiKey`, never lets a `set` failure fail the turn, and never write-backs a
// token that did not actually change (an entitlement 403 refreshes to the same
// token). It also surfaces this call's refresh decisions onto a terminal error
// so an auth failure is decidable in the transcript instead of only on stderr.

import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";

type TestKiroModel = Model<Api> & { kiroModelId?: string; kiroRegion?: string; kiroProfileArn?: string };

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

function encodeBody(body: string): Uint8Array {
  return concatMessages(...parseJsonObjects(body).map((o) => encodeEventMessage(o)));
}

/** A fetch double that 403s the runtime `n` times, then streams a success. */
function mockFetch403ThenOk(n: number) {
  const fetch = vi.fn();
  for (let i = 0; i < n; i++) {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => '{"message":"The bearer included in the request is invalid.","reason":null}',
    });
  }
  fetch.mockResolvedValueOnce({
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"ok"}{"contextUsagePercentage":5}') })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: () => {},
      }),
      cancel: async () => {},
    },
  });
  return fetch;
}

/** A fetch double that always 403s the runtime (never recovers). */
function mockFetch403Always() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    text: async () => '{"message":"The bearer included in the request is invalid.","reason":null}',
  });
}

async function collect(stream: ReturnType<typeof streamKiro>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

const idcCreds = (access: string, profileArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test") => ({
  refresh: `${access}-refresh|client|secret|idc`,
  access,
  expires: Date.now() + 3_600_000,
  clientId: "client",
  clientSecret: "secret",
  region: "us-east-1",
  authMethod: "idc" as const,
  ...(profileArn ? { profileArn } : {}),
});

describe("streamKiro credential accessor", () => {
  beforeEach(() => {
    // Profile discovery already resolved — isolate the runtime-403 path.
    resetProfileArnCache(true);
  });

  it("seeds the access token from accessor.get() when present, ignoring options.apiKey", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"hi"}{"contextUsagePercentage":5}') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
        cancel: async () => {},
      },
    });
    vi.stubGlobal("fetch", fetch);

    const accessor = { get: vi.fn(() => "accessor-token"), set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "stale-option-token", credentialAccessor: accessor }),
    );

    expect(accessor.get).toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer accessor-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("falls back to options.apiKey when the accessor has no token", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"hi"}{"contextUsagePercentage":5}') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
        cancel: async () => {},
      },
    });
    vi.stubGlobal("fetch", fetch);

    const accessor = { get: vi.fn(() => undefined), set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "option-token", credentialAccessor: accessor }),
    );

    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer option-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("rejects runtime recovery with credentials from another profile", async () => {
    const fetch = mockFetch403ThenOk(1);
    vi.stubGlobal("fetch", fetch);
    const kiroCli = await import("../src/kiro-cli.js");
    const getSpy = vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue(idcCreds("stale-token"));
    const refreshSpy = vi.spyOn(kiroCli, "refreshViaKiroCli").mockReturnValue(idcCreds("other-token", "profile-other"));
    const accessor = { get: () => "stale-token", set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "stale-token", credentialAccessor: accessor }),
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.errorMessage).toContain("identity changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(accessor.set).not.toHaveBeenCalled();
    getSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("writes the refreshed credential back through accessor.set() exactly once on a runtime 403", async () => {
    const fetch = mockFetch403ThenOk(1);
    vi.stubGlobal("fetch", fetch);

    const kiroCli = await import("../src/kiro-cli.js");
    // Store still holds the rejected token → provider must force a refresh.
    const getSpy = vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue(idcCreds("stale-token"));
    const fresh = idcCreds("fresh-token");
    const refreshSpy = vi.spyOn(kiroCli, "refreshViaKiroCli").mockReturnValue(fresh);

    const accessor = { get: vi.fn(() => "stale-token"), set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "stale-token", credentialAccessor: accessor }),
    );

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(accessor.set).toHaveBeenCalledOnce();
    expect(accessor.set.mock.calls[0][0]).toMatchObject({ access: "fresh-token" });
    // Retry used the fresh token.
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();

    getSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does NOT write back when the refreshed token is identical (entitlement 403 negative control)", async () => {
    // Runtime 403 whose refresh yields the SAME token: a valid credential lacking
    // model access. Write-back must not fire — the token did not change.
    const fetch = mockFetch403Always();
    vi.stubGlobal("fetch", fetch);

    const kiroCli = await import("../src/kiro-cli.js");
    const same = idcCreds("valid-token");
    const getSpy = vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue(same);
    const refreshSpy = vi.spyOn(kiroCli, "refreshViaKiroCli").mockReturnValue(same);

    const accessor = { get: vi.fn(() => "valid-token"), set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "valid-token", credentialAccessor: accessor }),
    );

    expect(accessor.set).not.toHaveBeenCalled();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();

    getSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("surfaces the refresh trace on a terminal auth error", async () => {
    const fetch = mockFetch403Always();
    vi.stubGlobal("fetch", fetch);

    const kiroCli = await import("../src/kiro-cli.js");
    // Store keeps returning the rejected token → every retry forces a refresh
    // that yields nothing usable.
    const getSpy = vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue(idcCreds("stale-token"));
    const refreshSpy = vi.spyOn(kiroCli, "refreshViaKiroCli").mockReturnValue(undefined);

    const accessor = { get: vi.fn(() => "stale-token"), set: vi.fn() };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "stale-token", credentialAccessor: accessor }),
    );

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    const msg = error?.type === "error" ? (error.error.errorMessage ?? "") : "";
    // First line preserves the original error grammar for the auth-expiry marker.
    expect(msg.split("\n")[0]).toContain("Kiro API error");
    // Trace line makes the failure decidable.
    expect(msg).toContain("[auth-refresh]");
    expect(msg).toContain("runtime-403");

    getSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("never fails a turn when accessor.set() throws", async () => {
    const fetch = mockFetch403ThenOk(1);
    vi.stubGlobal("fetch", fetch);

    const kiroCli = await import("../src/kiro-cli.js");
    const getSpy = vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue(idcCreds("stale-token"));
    const refreshSpy = vi.spyOn(kiroCli, "refreshViaKiroCli").mockReturnValue(idcCreds("fresh-token"));

    const accessor = {
      get: vi.fn(() => "stale-token"),
      set: vi.fn(() => {
        throw new Error("persist failed");
      }),
    };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "stale-token", credentialAccessor: accessor }),
    );

    // The throw in set() is swallowed; the turn still recovers.
    expect(accessor.set).toHaveBeenCalled();
    expect(events.find((e) => e.type === "done")).toBeDefined();

    getSpy.mockRestore();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("awaits accessor.ensureFresh() before reading the token and before the first fetch", async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (..._args: unknown[]) => {
      order.push("fetch");
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"hi"}{"contextUsagePercentage":5}') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
          cancel: async () => {},
        },
      };
    });
    vi.stubGlobal("fetch", fetch);

    // The host holds a near-expiry token; ensureFresh rotates it asynchronously.
    let token = "about-to-expire";
    const accessor = {
      ensureFresh: vi.fn(async () => {
        order.push("ensureFresh:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        token = "proactively-refreshed";
        order.push("ensureFresh:end");
      }),
      get: vi.fn(() => {
        order.push("get");
        return token;
      }),
      set: vi.fn(),
    };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "about-to-expire", credentialAccessor: accessor }),
    );

    expect(accessor.ensureFresh).toHaveBeenCalledOnce();
    expect(order.slice(0, 3)).toEqual(["ensureFresh:start", "ensureFresh:end", "get"]);
    expect(order.indexOf("fetch")).toBeGreaterThan(order.indexOf("ensureFresh:end"));
    // The stale token never reached the wire, and no reactive write-back happened.
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer proactively-refreshed",
    );
    expect(accessor.set).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "done")).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("never fails a turn when accessor.ensureFresh() rejects", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"hi"}{"contextUsagePercentage":5}') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
        cancel: async () => {},
      },
    });
    vi.stubGlobal("fetch", fetch);

    const accessor = {
      ensureFresh: vi.fn(async () => {
        throw new Error("refresh helper unavailable");
      }),
      get: vi.fn(() => "current-token"),
      set: vi.fn(),
    };
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "current-token", credentialAccessor: accessor }),
    );

    expect(accessor.ensureFresh).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer current-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("works without any accessor (pure options.apiKey path unchanged)", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: encodeBody('{"content":"hi"}{"contextUsagePercentage":5}') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
        cancel: async () => {},
      },
    });
    vi.stubGlobal("fetch", fetch);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "plain-token" }));
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer plain-token");
    expect(events.find((e) => e.type === "done")).toBeDefined();
    vi.unstubAllGlobals();
  });
});
