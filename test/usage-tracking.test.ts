import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USD_PER_CREDIT,
  estimateKiroCreditCost,
  getPiAgentDir,
  type KiroUsageTracking,
  loadKiroUsageTracking,
} from "../src/usage-tracking.js";

describe("Kiro usage tracking config", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "kiro-usage-tracking-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.PI_CODING_AGENT_DIR;
  });

  function writeSettings(settings: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  }

  describe("loadKiroUsageTracking", () => {
    it("is disabled when no settings file exists", () => {
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
    });

    it("is disabled when the provider section is absent", () => {
      writeSettings({ packages: ["npm:pi-provider-kiro"] });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
    });

    it("is disabled when enabled is false", () => {
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: false, usdPerCredit: 1 } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
    });

    it("defaults to Kiro's published add-on rate when only enabled is set", () => {
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: true } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: true, usdPerCredit: DEFAULT_USD_PER_CREDIT });
    });

    it("honors a custom rate", () => {
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: true, usdPerCredit: 0.025 } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: true, usdPerCredit: 0.025 });
    });

    it("accepts a zero rate so credits can be tracked without implying spend", () => {
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: true, usdPerCredit: 0 } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: true, usdPerCredit: 0 });
    });

    it.each([
      ["a negative rate", -0.04],
      ["a non-numeric rate", "0.04"],
      ["a NaN rate", Number.NaN],
      ["an infinite rate", Number.POSITIVE_INFINITY],
    ])("fails closed on %s", (_label, usdPerCredit) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: true, usdPerCredit } } });

      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
      expect(warn).toHaveBeenCalledOnce();
    });

    it("fails closed on unparseable settings without leaking the file contents", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeFileSync(join(agentDir, "settings.json"), '{"pi-provider-kiro": {');

      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
      const warning = warn.mock.calls[0]?.[0] as string;
      expect(warning).toContain("stays disabled");
      expect(warning).not.toContain('pi-provider-kiro":');
    });

    it.each([
      ["a non-object section", { "pi-provider-kiro": { usageTracking: true } }],
      ["an array section", { "pi-provider-kiro": { usageTracking: [] } }],
      ["a non-object provider entry", { "pi-provider-kiro": "enabled" }],
      ["a truthy non-boolean enabled", { "pi-provider-kiro": { usageTracking: { enabled: "yes" } } }],
    ])("is disabled for %s", (_label, settings) => {
      writeSettings(settings);
      expect(loadKiroUsageTracking(agentDir)).toEqual({ enabled: false });
    });

    it("reads the directory named by PI_CODING_AGENT_DIR", () => {
      writeSettings({ "pi-provider-kiro": { usageTracking: { enabled: true } } });
      process.env.PI_CODING_AGENT_DIR = agentDir;

      expect(getPiAgentDir()).toBe(agentDir);
      expect(loadKiroUsageTracking()).toEqual({ enabled: true, usdPerCredit: DEFAULT_USD_PER_CREDIT });
    });
  });

  describe("estimateKiroCreditCost", () => {
    const enabled: KiroUsageTracking = { enabled: true, usdPerCredit: DEFAULT_USD_PER_CREDIT };

    it("converts credits at the configured rate", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 3, unit: "credit" })).toBeCloseTo(0.12, 10);
    });

    it("accepts the plural and mixed-case unit the service also emits", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 2, unit: "Credits" })).toBeCloseTo(0.08, 10);
    });

    it("rejects a metering record that omits its unit", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 1 })).toBeUndefined();
    });

    it("converts zero credits to zero cost", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 0, unit: "credit" })).toBe(0);
    });

    it("returns undefined when tracking is disabled", () => {
      expect(estimateKiroCreditCost({ enabled: false }, { credits: 3, unit: "credit" })).toBeUndefined();
    });

    it.each([
      ["a token unit", { credits: 3, unit: "token" }],
      ["a missing credit count", { unit: "credit" }],
      ["a negative count", { credits: -1, unit: "credit" }],
      ["a NaN count", { credits: Number.NaN, unit: "credit" }],
      ["an infinite count", { credits: Number.POSITIVE_INFINITY, unit: "credit" }],
    ])("returns undefined for %s", (_label, metering) => {
      expect(estimateKiroCreditCost(enabled, metering)).toBeUndefined();
    });

    it("returns undefined when no metering event was seen", () => {
      expect(estimateKiroCreditCost(enabled, null)).toBeUndefined();
      expect(estimateKiroCreditCost(enabled, undefined)).toBeUndefined();
    });
  });
});
