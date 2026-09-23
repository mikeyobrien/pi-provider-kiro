import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatKiroUsageFooter,
  type KiroFooterTheme,
  loadKiroFooterConfig,
  pickKiroUsageBucket,
  usagePercentUsed,
} from "../src/footer.js";
import type { KiroProviderUsage, KiroProviderUsageBucket } from "../src/usage.js";

describe("loadKiroFooterConfig", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "kiro-footer-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeSettings(settings: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  }

  it("is disabled when no settings file exists", () => {
    expect(loadKiroFooterConfig(agentDir)).toEqual({ showUsageInFooter: false });
  });

  it("is disabled when the flag is absent", () => {
    writeSettings({ "pi-provider-kiro": { usageTracking: { estimateDollarValue: true } } });
    expect(loadKiroFooterConfig(agentDir)).toEqual({ showUsageInFooter: false });
  });

  it("enables the footer when explicitly opted in", () => {
    writeSettings({ "pi-provider-kiro": { showUsageInFooter: true } });
    expect(loadKiroFooterConfig(agentDir)).toEqual({ showUsageInFooter: true });
  });

  it("stays disabled for a non-boolean flag", () => {
    writeSettings({ "pi-provider-kiro": { showUsageInFooter: "yes" } });
    expect(loadKiroFooterConfig(agentDir)).toEqual({ showUsageInFooter: false });
  });

  it("fails closed on unparseable settings without leaking contents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(agentDir, "settings.json"), '{"pi-provider-kiro": {');
    expect(loadKiroFooterConfig(agentDir)).toEqual({ showUsageInFooter: false });
    expect(warn.mock.calls[0]?.[0]).not.toContain('pi-provider-kiro":');
  });
});

describe("usagePercentUsed", () => {
  const bucket = (over: Partial<KiroProviderUsageBucket>): KiroProviderUsageBucket => ({
    id: "credit",
    label: "Credits",
    usedDisplay: "0",
    ...over,
  });

  it("computes the used percentage from numeric fields", () => {
    expect(usagePercentUsed(bucket({ used: 10.89, limit: 2000 }))).toBeCloseTo(0.5445, 4);
  });

  it("clamps to 100 when usage exceeds the limit", () => {
    expect(usagePercentUsed(bucket({ used: 2500, limit: 2000 }))).toBe(100);
  });

  it("reports 0 for a zero limit rather than dividing by zero", () => {
    expect(usagePercentUsed(bucket({ used: 5, limit: 0 }))).toBeUndefined();
  });

  it("returns undefined when the numeric fields are missing", () => {
    expect(usagePercentUsed(bucket({ usedDisplay: "10", limitDisplay: "2000" }))).toBeUndefined();
  });
});

describe("pickKiroUsageBucket", () => {
  const bucket = (id: string, over: Partial<KiroProviderUsageBucket> = {}): KiroProviderUsageBucket => ({
    id,
    label: id,
    usedDisplay: "0",
    ...over,
  });

  it("prefers the credit bucket when several are present", () => {
    const usage: KiroProviderUsage = {
      usageBuckets: [
        bucket("spend", { used: 1, limit: 2 }),
        bucket("CREDIT", { resourceType: "CREDIT", used: 5, limit: 10 }),
      ],
    };
    expect(pickKiroUsageBucket(usage)?.resourceType).toBe("CREDIT");
  });

  it("falls back to the first bucket with a computable percentage", () => {
    const usage: KiroProviderUsage = {
      usageBuckets: [bucket("a", { usedDisplay: "1" }), bucket("b", { used: 3, limit: 4 })],
    };
    expect(pickKiroUsageBucket(usage)?.id).toBe("b");
  });

  it("returns undefined when nothing is computable", () => {
    const usage: KiroProviderUsage = { usageBuckets: [bucket("a"), bucket("b")] };
    expect(pickKiroUsageBucket(usage)).toBeUndefined();
  });
});

describe("formatKiroUsageFooter", () => {
  // A theme that tags each segment so tests can assert both text and semantic color
  // without depending on ANSI escapes.
  const theme: KiroFooterTheme = {
    fg: (color, text) => `[${color}]${text}`,
  };

  const usage = (used: number, limit: number): KiroProviderUsage => ({
    usageBuckets: [{ id: "credit", label: "Credits", resourceType: "CREDIT", usedDisplay: "x", used, limit }],
  });

  it("renders a compact used-percent badge in the success color when low", () => {
    expect(formatKiroUsageFooter(usage(10.89, 2000), theme)).toBe("[success]◆ Kiro 0.5%");
  });

  it("drops the decimal for whole-number percentages", () => {
    expect(formatKiroUsageFooter(usage(500, 1000), theme)).toBe("[success]◆ Kiro 50%");
  });

  it("uses the warning color at the 70% threshold", () => {
    expect(formatKiroUsageFooter(usage(700, 1000), theme)).toBe("[warning]◆ Kiro 70%");
  });

  it("uses the error color at the 90% threshold", () => {
    expect(formatKiroUsageFooter(usage(900, 1000), theme)).toBe("[error]◆ Kiro 90%");
  });

  it("returns undefined when no bucket yields a percentage", () => {
    expect(formatKiroUsageFooter({ usageBuckets: [{ id: "c", label: "c", usedDisplay: "1" }] }, theme)).toBeUndefined();
  });

  it("returns undefined for empty usage", () => {
    expect(formatKiroUsageFooter({}, theme)).toBeUndefined();
  });
});
