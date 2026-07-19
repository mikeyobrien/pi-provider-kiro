import { getSupportedThinkingLevels, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { filterModelsByRegion, KIRO_MODEL_IDS, kiroModels, resolveApiRegion, resolveKiroModel } from "../src/models.js";

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it.each([
      // Claude models - dash to dot conversion
      ["claude-opus-4-8", "claude-opus-4.8"],
      ["claude-opus-4-7", "claude-opus-4.7"],
      ["claude-opus-4-6", "claude-opus-4.6"],
      ["claude-sonnet-5", "claude-sonnet-5"],
      ["claude-sonnet-4-6", "claude-sonnet-4.6"],
      ["claude-sonnet-4-5", "claude-sonnet-4.5"],
      ["claude-sonnet-4", "claude-sonnet-4"],
      ["claude-haiku-4-5", "claude-haiku-4.5"],
      ["claude-fable-5", "claude-fable-5"],
      // Non-Claude models
      ["deepseek-3-2", "deepseek-3.2"],
      ["minimax-m2-1", "minimax-m2.1"],
      ["glm-5", "glm-5"],
      ["qwen3-coder-next", "qwen3-coder-next"],
    ])("maps %s → %s", (piId, kiroId) => {
      expect(resolveKiroModel(piId)).toBe(kiroId);
    });

    it("throws on unknown model ID", () => {
      expect(() => resolveKiroModel("nonexistent")).toThrow("Unknown Kiro model ID");
    });
  });

  describe("KIRO_MODEL_IDS", () => {
    it("contains 15 model IDs", () => {
      expect(KIRO_MODEL_IDS.size).toBe(15);
    });
  });

  describe("resolveApiRegion", () => {
    it("maps us-east-2 to us-east-1", () => {
      expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
    });

    it("maps eu-west-1 to eu-central-1", () => {
      expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    });

    it("maps ap-southeast-2 to us-east-1", () => {
      expect(resolveApiRegion("ap-southeast-2")).toBe("us-east-1");
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
      expect(filterModelsByRegion(kiroModels, "af-south-1")).toHaveLength(0);
    });
  });

  describe("model catalog", () => {
    it("defines 15 models", () => {
      expect(kiroModels).toHaveLength(15);
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

    it("Claude models support text and image input", () => {
      const claudeModels = kiroModels.filter((m) => m.id.startsWith("claude-"));
      expect(claudeModels.every((m) => m.input.includes("text") && m.input.includes("image"))).toBe(true);
    });

    it("non-Claude models (except auto) support text only", () => {
      const textOnlyModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && m.id !== "auto");
      expect(textOnlyModels.every((m) => m.input.includes("text") && !m.input.includes("image"))).toBe(true);
    });

    it("all models have zero cost", () => {
      expect(kiroModels.every((m) => m.cost.input === 0 && m.cost.output === 0)).toBe(true);
    });

    it("opus models have expected max tokens", () => {
      const opusModels = kiroModels.filter((m) => m.id.includes("opus"));
      expect(opusModels.every((m) => m.maxTokens === 32768 || m.maxTokens === 128000)).toBe(true);
    });

    it("non-Claude models (except auto) have 8K max tokens", () => {
      const nonClaudeModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && m.id !== "auto");
      expect(nonClaudeModels.every((m) => m.maxTokens === 8192)).toBe(true);
    });
  });

  describe("thinkingLevelMap — pi UI exposes extended levels", () => {
    const THROUGH_HIGH = ["off", "minimal", "low", "medium", "high"] satisfies ModelThinkingLevel[];
    const THROUGH_XHIGH = [...THROUGH_HIGH, "xhigh"] satisfies ModelThinkingLevel[];
    const THROUGH_MAX = [...THROUGH_XHIGH, "max"] satisfies ModelThinkingLevel[];
    const XHIGH_MODELS = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"];

    it("Opus 4.8/4.7/4.6 models offer xhigh but not max", () => {
      for (const model of kiroModels.filter((candidate) => XHIGH_MODELS.includes(candidate.id))) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(THROUGH_XHIGH);
      }
    });

    it("other reasoning models offer up to high (no xhigh or max)", () => {
      for (const model of kiroModels.filter(
        (candidate) => candidate.reasoning && !XHIGH_MODELS.includes(candidate.id),
      )) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(THROUGH_HIGH);
      }
    });

    it("recognizes max as a first-class level when explicitly mapped", () => {
      const model = {
        ...kiroModels[0],
        thinkingLevelMap: { xhigh: "xhigh", max: "max" } satisfies ThinkingLevelMap,
      };

      expect(getSupportedThinkingLevels(model)).toEqual(THROUGH_MAX);
    });

    it("non-reasoning models still collapse to ['off']", () => {
      for (const model of kiroModels.filter((candidate) => !candidate.reasoning)) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(["off"]);
      }
    });
  });
});
