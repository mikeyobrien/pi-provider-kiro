import { describe, expect, it } from "vitest";
import { filterModelsByRegion, KIRO_MODEL_IDS, kiroModels, resolveApiRegion, resolveKiroModel } from "../src/models.js";

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it.each([
      // Claude models - dash to dot conversion
      ["claude-opus-4-6", "claude-opus-4.6"],
      ["claude-opus-4-6-1m", "claude-opus-4.6-1m"],
      ["claude-sonnet-4-6", "claude-sonnet-4.6"],
      ["claude-sonnet-4-6-1m", "claude-sonnet-4.6-1m"],
      ["claude-opus-4-5", "claude-opus-4.5"],
      ["claude-sonnet-4-5", "claude-sonnet-4.5"],
      ["claude-sonnet-4-5-1m", "claude-sonnet-4.5-1m"],
      ["claude-sonnet-4", "claude-sonnet-4"],
      ["claude-haiku-4-5", "claude-haiku-4.5"],
      // Non-Claude models
      ["deepseek-3-2", "deepseek-3.2"],
      ["kimi-k2-5", "kimi-k2.5"],
      ["minimax-m2-1", "minimax-m2.1"],
      ["glm-4-7", "glm-4.7"],
      ["glm-4-7-flash", "glm-4.7-flash"],
      ["qwen3-coder-next", "qwen3-coder-next"],
      ["agi-nova-beta-1m", "agi-nova-beta-1m"],
      ["qwen3-coder-480b", "qwen3-coder-480b"],
    ])("maps %s → %s", (piId, kiroId) => {
      expect(resolveKiroModel(piId)).toBe(kiroId);
    });

    it("throws on unknown model ID", () => {
      expect(() => resolveKiroModel("nonexistent")).toThrow("Unknown Kiro model ID");
    });
  });

  describe("KIRO_MODEL_IDS", () => {
    it("contains 18 model IDs", () => {
      expect(KIRO_MODEL_IDS.size).toBe(18);
    });
  });

  describe("resolveApiRegion", () => {
    it("maps us-east-2 to us-east-1", () => {
      expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
    });

    it("maps eu-west-1 to eu-central-1", () => {
      expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    });

    it("passes through us-east-1 unchanged", () => {
      expect(resolveApiRegion("us-east-1")).toBe("us-east-1");
    });

    it("defaults to us-east-1 when undefined", () => {
      expect(resolveApiRegion(undefined)).toBe("us-east-1");
    });
  });

  describe("filterModelsByRegion", () => {
    it("us-east-1 returns all models", () => {
      expect(filterModelsByRegion(kiroModels, "us-east-1")).toHaveLength(kiroModels.length);
    });

    it("eu-central-1 includes Claude + documented OSS, excludes DeepSeek and undocumented models", () => {
      const ids = filterModelsByRegion(kiroModels, "eu-central-1").map((m) => m.id);
      expect(ids).toContain("claude-sonnet-4-6");
      expect(ids).toContain("minimax-m2-1");
      expect(ids).not.toContain("deepseek-3-2");
      expect(ids).not.toContain("agi-nova-beta-1m");
    });

    it("unknown region returns no models", () => {
      expect(filterModelsByRegion(kiroModels, "ap-southeast-1")).toHaveLength(0);
    });
  });

  describe("model catalog", () => {
    it("defines 18 models", () => {
      expect(kiroModels).toHaveLength(18);
    });

    it("claude-haiku-4-5 has reasoning=false", () => {
      expect(kiroModels.find((m) => m.id === "claude-haiku-4-5")?.reasoning).toBe(false);
    });

    it("flash models have reasoning=false", () => {
      const flashModels = kiroModels.filter((m) => m.id.includes("flash"));
      expect(flashModels.every((m) => m.reasoning === false)).toBe(true);
    });

    it("minimax has reasoning=false", () => {
      expect(kiroModels.find((m) => m.id === "minimax-m2-1")?.reasoning).toBe(false);
    });

    it("1M context models have 1M context window", () => {
      const oneMillionModels = kiroModels.filter((m) => m.id.includes("1m"));
      expect(oneMillionModels.every((m) => m.contextWindow === 1000000)).toBe(true);
    });

    it("Claude models support text and image input", () => {
      const claudeModels = kiroModels.filter((m) => m.id.startsWith("claude-"));
      expect(claudeModels.every((m) => m.input.includes("text") && m.input.includes("image"))).toBe(true);
    });

    it("non-Claude models (except agi-nova) support text only", () => {
      const textOnlyModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && !m.id.startsWith("agi-nova"));
      expect(textOnlyModels.every((m) => m.input.includes("text") && !m.input.includes("image"))).toBe(true);
    });

    it("agi-nova supports text and image", () => {
      const agiNova = kiroModels.find((m) => m.id === "agi-nova-beta-1m");
      expect(agiNova?.input).toContain("text");
      expect(agiNova?.input).toContain("image");
    });

    it("all models have zero cost", () => {
      expect(kiroModels.every((m) => m.cost.input === 0 && m.cost.output === 0)).toBe(true);
    });

    it("opus models have 32K max tokens", () => {
      const opusModels = kiroModels.filter((m) => m.id.includes("opus"));
      expect(opusModels.every((m) => m.maxTokens === 32768)).toBe(true);
    });

    it("non-Claude models have 8K max tokens", () => {
      const nonClaudeModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && !m.id.startsWith("agi-nova"));
      expect(nonClaudeModels.every((m) => m.maxTokens === 8192)).toBe(true);
    });
  });
});
