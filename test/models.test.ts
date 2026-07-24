import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KiroCatalogModel } from "../src/management.js";
import {
  getCachedModels,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  KIRO_MANAGEMENT_CACHE_SOURCE,
  KIRO_MANAGEMENT_CACHE_VERSION,
  KIRO_MODEL_IDS,
  kiroModels,
  mapKiroCatalogModels,
  resolveApiRegion,
  resolveKiroModel,
  updateKiroModelsCache,
} from "../src/models.js";

const LEGACY_CACHE_PATH = join(homedir(), ".kiro-models-cache.json");
const TEST_REGION = "test-region-1";
const PROFILE_ARN = "arn:aws:codewhisperer:test-region-1:123456789012:profile/test";

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

const catalogFixture: KiroCatalogModel[] = [
  {
    modelId: "openai-gpt-5.6",
    displayName: "GPT 5.6",
    tokenLimits: { maxInputTokens: 278_528, maxOutputTokens: 128_000 },
    additionalModelRequestFieldsSchema: effortSchema("reasoning", ["none", "low", "medium", "high", "xhigh", "max"]),
  },
  {
    modelId: "claude-opus-4.8",
    displayName: "Catalog Opus 4.8",
    tokenLimits: { maxInputTokens: 900_000, maxOutputTokens: 100_000 },
    additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"]),
  },
  {
    modelId: "claude-sonnet-4.6",
    additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "max"]),
  },
  { modelId: "qwen3-coder-next" },
  {
    modelId: "claude-fable-5",
    tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
    additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"]),
  },
];

beforeEach(() => {
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  rmSync(LEGACY_CACHE_PATH, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  rmSync(LEGACY_CACHE_PATH, { force: true });
});

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it.each([
      ["claude-opus-4-8", "claude-opus-4.8"],
      ["claude-sonnet-5", "claude-sonnet-5"],
      ["claude-haiku-4-5", "claude-haiku-4.5"],
      ["claude-fable-5", "claude-fable-5"],
      ["deepseek-3-2", "deepseek-3.2"],
      ["minimax-m2-1", "minimax-m2.1"],
      ["glm-5", "glm-5"],
      ["qwen3-coder-next", "qwen3-coder-next"],
    ])("maps bootstrap ID %s to exact service ID %s", (piId, kiroId) => {
      expect(resolveKiroModel(piId)).toBe(kiroId);
    });

    it("throws on an unknown model ID", () => {
      expect(() => resolveKiroModel("nonexistent")).toThrow("Unknown Kiro model ID");
    });

    it("tracks exact service IDs from the bootstrap catalog", () => {
      expect(KIRO_MODEL_IDS).toEqual(new Set(kiroModels.map((model) => model.kiroModelId)));
    });
  });

  describe("resolveApiRegion", () => {
    it.each([
      ["us-east-2", "us-east-1"],
      ["eu-west-1", "eu-central-1"],
      ["ap-southeast-2", "us-east-1"],
      ["us-east-1", "us-east-1"],
      [undefined, "us-east-1"],
    ])("maps %s to %s", (ssoRegion, apiRegion) => {
      expect(resolveApiRegion(ssoRegion)).toBe(apiRegion);
    });
  });

  describe("management catalog mapping", () => {
    const mapped = mapKiroCatalogModels(catalogFixture, TEST_REGION);

    it.each([
      {
        id: "openai-gpt-5-6",
        kiroModelId: "openai-gpt-5.6",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        contextWindow: 278_528,
        maxTokens: 128_000,
      },
      {
        id: "claude-opus-4-8",
        kiroModelId: "claude-opus-4.8",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        contextWindow: 900_000,
        maxTokens: 100_000,
      },
      {
        id: "claude-sonnet-4-6",
        kiroModelId: "claude-sonnet-4.6",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      {
        id: "qwen3-coder-next",
        kiroModelId: "qwen3-coder-next",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      {
        id: "claude-fable-5",
        kiroModelId: "claude-fable-5",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    ])("maps $id from authenticated metadata", (expected) => {
      expect(mapped.find((model) => model.id === expected.id)).toMatchObject(expected);
    });

    it("retains fresh schema and token metadata for a model also present in the bootstrap list", () => {
      const opus = mapped.find((model) => model.id === "claude-opus-4-8");
      expect(opus?.name).toBe("Catalog Opus 4.8");
      expect(opus?.additionalModelRequestFieldsSchema).toEqual(catalogFixture[1].additionalModelRequestFieldsSchema);
      expect(opus?.tokenLimits).toEqual(catalogFixture[1].tokenLimits);
      expect(opus?.contextWindow).not.toBe(kiroModels.find((model) => model.id === opus?.id)?.contextWindow);
    });

    it("treats a null schema as absent for auto", () => {
      const [auto] = mapKiroCatalogModels([{ modelId: "auto", additionalModelRequestFieldsSchema: null }], TEST_REGION);

      expect(auto).toMatchObject({ id: "auto", reasoning: true });
      expect(auto.additionalModelRequestFieldsSchema).toBeUndefined();
    });

    it("rejects malformed non-null schemas", () => {
      expect(() =>
        mapKiroCatalogModels(
          [{ modelId: "auto", additionalModelRequestFieldsSchema: "invalid" as never }],
          TEST_REGION,
        ),
      ).toThrow("invalid request-fields schema");
    });

    it("preserves the exact service ID for request-time model resolution", () => {
      const dynamicModel = mapped.find((model) => model.id === "openai-gpt-5-6");
      expect(dynamicModel).toBeDefined();
      expect(dynamicModel?.baseUrl).toBe(`https://runtime.${TEST_REGION}.kiro.dev/`);
      expect(resolveKiroModel(dynamicModel?.id ?? "", dynamicModel?.kiroModelId)).toBe("openai-gpt-5.6");
    });
  });

  describe("management model cache", () => {
    it("accepts the versioned cache and treats its regional catalog as authoritative", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: catalogFixture }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await updateKiroModelsCache("secret-access-token", TEST_REGION, PROFILE_ARN);

      const serialized = readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8");
      const cache = JSON.parse(serialized);
      expect(cache).toMatchObject({
        version: KIRO_MANAGEMENT_CACHE_VERSION,
        source: KIRO_MANAGEMENT_CACHE_SOURCE,
        regions: {
          [TEST_REGION]: {
            region: TEST_REGION,
            fetchedAt: expect.any(Number),
          },
        },
      });
      expect(serialized).not.toContain("secret-access-token");
      expect(serialized).not.toContain(PROFILE_ARN);

      const cachedModels = getCachedModels(TEST_REGION);
      expect(cachedModels.map((model) => model.id)).toEqual(
        catalogFixture.map((model) => model.modelId.replace(/(\d)\.(\d)/g, "$1-$2")),
      );
      expect(cachedModels.some((model) => model.id === "auto")).toBe(false);
      expect(resolveKiroModel("openai-gpt-5-6")).toBe("openai-gpt-5.6");
      expect(isCacheStale(TEST_REGION)).toBe(false);
    });

    it("ignores both the old Q cache path and an unversioned cache at the management path", () => {
      const legacyModels = [{ ...kiroModels[0], id: "legacy-only", kiroModelId: "legacy-only" }];
      const legacyCache = JSON.stringify({ [TEST_REGION]: legacyModels });
      writeFileSync(LEGACY_CACHE_PATH, legacyCache, "utf-8");

      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
      expect(getCachedModels(TEST_REGION).some((model) => model.id === "legacy-only")).toBe(false);

      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, legacyCache, "utf-8");
      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
      expect(isCacheStale(TEST_REGION)).toBe(true);
    });

    it("preserves the newest valid management cache when refresh fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ models: catalogFixture }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        });
      vi.stubGlobal("fetch", fetchMock);

      await updateKiroModelsCache("first-token", TEST_REGION, PROFILE_ARN);
      const validCache = readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8");

      await expect(updateKiroModelsCache("second-token", TEST_REGION, PROFILE_ARN)).rejects.toThrow(
        "Kiro management ListAvailableModels failed",
      );
      expect(readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8")).toBe(validCache);
      expect(getCachedModels(TEST_REGION).map((model) => model.id)).toEqual(
        catalogFixture.map((model) => model.modelId.replace(/(\d)\.(\d)/g, "$1-$2")),
      );
    });
  });

  describe("bootstrap model catalog", () => {
    it("keeps conservative, zero-cost bootstrap metadata", () => {
      expect(kiroModels).toHaveLength(15);
      expect(kiroModels.every((model) => model.baseUrl === "https://runtime.us-east-1.kiro.dev/")).toBe(true);
      expect(kiroModels.every((model) => model.cost.input === 0 && model.cost.output === 0)).toBe(true);
      expect(kiroModels.find((model) => model.id === "claude-haiku-4-5")?.reasoning).toBe(false);
      expect(kiroModels.find((model) => model.id === "minimax-m2-1")?.reasoning).toBe(false);
    });

    it("uses image input for Claude and text input for other concrete models", () => {
      const claudeModels = kiroModels.filter((model) => model.id.startsWith("claude-"));
      const nonClaudeModels = kiroModels.filter((model) => !model.id.startsWith("claude-") && model.id !== "auto");
      expect(claudeModels.every((model) => model.input.includes("text") && model.input.includes("image"))).toBe(true);
      expect(nonClaudeModels.every((model) => model.input.length === 1 && model.input[0] === "text")).toBe(true);
    });
  });

  describe("thinkingLevelMap", () => {
    const THROUGH_HIGH = ["off", "minimal", "low", "medium", "high"] satisfies ModelThinkingLevel[];
    const THROUGH_XHIGH_AND_MAX = [...THROUGH_HIGH, "xhigh", "max"] satisfies ModelThinkingLevel[];
    const THROUGH_HIGH_AND_MAX = [...THROUGH_HIGH, "max"] satisfies ModelThinkingLevel[];
    const XHIGH_AND_MAX_MODELS = ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-fable-5"];
    const MAX_WITHOUT_XHIGH_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

    it("advertises xhigh and max independently when both are supported", () => {
      for (const model of kiroModels.filter((candidate) => XHIGH_AND_MAX_MODELS.includes(candidate.id))) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(THROUGH_XHIGH_AND_MAX);
      }
    });

    it("preserves a max-without-xhigh capability hole", () => {
      for (const model of kiroModels.filter((candidate) => MAX_WITHOUT_XHIGH_MODELS.includes(candidate.id))) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(THROUGH_HIGH_AND_MAX);
      }
    });

    it("limits other reasoning models to standard levels", () => {
      for (const model of kiroModels.filter(
        (candidate) =>
          candidate.reasoning &&
          !XHIGH_AND_MAX_MODELS.includes(candidate.id) &&
          !MAX_WITHOUT_XHIGH_MODELS.includes(candidate.id),
      )) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(THROUGH_HIGH);
      }
    });

    it("collapses non-reasoning models to off", () => {
      for (const model of kiroModels.filter((candidate) => !candidate.reasoning)) {
        expect(getSupportedThinkingLevels(model), `${model.id} supported levels`).toEqual(["off"]);
      }
    });
  });
});
