import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerKiroUsageFooter } from "../src/footer-lifecycle.js";
import type { KiroProviderUsage } from "../src/usage.js";

const STATUS_KEY = "kiro-usage";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makeHarness(
  overrides: {
    enabled?: boolean;
    usage?: () => Promise<KiroProviderUsage>;
    credential?: unknown;
    hasCredential?: boolean;
    now?: () => number;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const on = vi.fn((event: string, handler: Handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {};
  });
  const pi = { on } as unknown as ExtensionAPI;

  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    model: { provider: "kiro", id: "claude-sonnet-4-6" },
    ui: { setStatus, theme: { fg: (color: string, text: string) => `[${color}]${text}` } },
  };

  const fetchUsage =
    overrides.usage ??
    vi.fn(
      async (): Promise<KiroProviderUsage> => ({
        usageBuckets: [
          { id: "credit", label: "Credits", resourceType: "CREDIT", usedDisplay: "x", used: 700, limit: 1000 },
        ],
      }),
    );

  registerKiroUsageFooter(pi, {
    statusKey: STATUS_KEY,
    loadConfig: () => ({ showUsageInFooter: overrides.enabled ?? true }),
    resolveCredential: () =>
      (overrides.hasCredential === false
        ? undefined
        : (overrides.credential ?? { access: "tok", region: "us-east-1", profileArn: "arn" })) as never,
    fetchUsage: fetchUsage as never,
    now: overrides.now ?? (() => 0),
  });

  const emit = async (event: string, ctxOverride?: Record<string, unknown>) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({}, { ...ctx, ...ctxOverride });
    }
  };

  return { emit, setStatus, fetchUsage, ctx };
}

describe("registerKiroUsageFooter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers nothing when the footer is opted out", () => {
    const on = vi.fn();
    registerKiroUsageFooter({ on } as unknown as ExtensionAPI, {
      statusKey: STATUS_KEY,
      loadConfig: () => ({ showUsageInFooter: false }),
      resolveCredential: () => ({ access: "tok" }) as never,
      fetchUsage: vi.fn() as never,
      now: () => 0,
    });
    expect(on).not.toHaveBeenCalled();
  });

  it("renders the used-percent badge on session start", async () => {
    const { emit, setStatus } = makeHarness();
    await emit("session_start");
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, "[warning]◆ Kiro 70%");
  });

  it("clears the badge when a non-Kiro model is active", async () => {
    const { emit, setStatus } = makeHarness();
    await emit("model_select", { model: { provider: "openai", id: "gpt" } });
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("does not fetch usage for a non-Kiro model", async () => {
    const { emit, fetchUsage } = makeHarness();
    await emit("model_select", { model: { provider: "openai", id: "gpt" } });
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("throttles repeated refreshes within the cooldown window", async () => {
    let clock = 0;
    const { emit, fetchUsage } = makeHarness({ now: () => clock });
    await emit("session_start");
    clock = 1_000; // within the default cooldown
    await emit("agent_end");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it("refreshes again after the cooldown elapses", async () => {
    let clock = 0;
    const { emit, fetchUsage } = makeHarness({ now: () => clock });
    await emit("session_start");
    clock = 60_000; // past the default cooldown
    await emit("agent_end");
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("clears the badge and swallows the error when usage fetch fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const { emit, setStatus } = makeHarness({ usage: failing });
    await emit("session_start");
    expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });

  it("clears the badge when no local credential is available", async () => {
    const fetchUsage = vi.fn(async () => ({}) as KiroProviderUsage);
    const { emit, setStatus } = makeHarness({ hasCredential: false, usage: fetchUsage });
    await emit("session_start");
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("does nothing in non-interactive contexts", async () => {
    const { emit, setStatus, fetchUsage } = makeHarness();
    await emit("session_start", { hasUI: false });
    expect(setStatus).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("clears the badge on session shutdown", async () => {
    const { emit, setStatus } = makeHarness();
    await emit("session_shutdown");
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });
});
