import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKiroEffort } from "../src/effort.js";
import { type KiroCatalogModel, resetKiroProfileArnCache } from "../src/management.js";
import {
  deriveThinkingConfig,
  getCachedCatalogRegion,
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

function effortSchema(
  field: "reasoning" | "output_config",
  values: string[],
  summarizedThinking = false,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [field]: {
        type: "object",
        properties: { effort: { type: "string", enum: values } },
        additionalProperties: false,
      },
      ...(summarizedThinking
        ? { thinking: { type: "object", properties: { display: { enum: ["summarized", "omitted"] } } } }
        : {}),
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
    modelId: "gpt-5.6-luna",
    displayName: "GPT 5.6 Luna",
    tokenLimits: { maxInputTokens: 300_000, maxOutputTokens: 128_000 },
    additionalModelRequestFieldsSchema: effortSchema("reasoning", ["none", "low", "medium", "high", "xhigh", "max"]),
  },
  {
    modelId: "claude-opus-4.8",
    displayName: "Catalog Opus 4.8",
    tokenLimits: { maxInputTokens: 900_000, maxOutputTokens: 100_000 },
    additionalModelRequestFieldsSchema: effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"], true),
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

    it("advertises verified Luna vision without broadening other non-Claude models", () => {
      expect(mapped.find((model) => model.id === "gpt-5-6-luna")?.input).toEqual(["text", "image"]);
      expect(mapped.find((model) => model.id === "openai-gpt-5-6")?.input).toEqual(["text"]);
      expect(mapped.find((model) => model.id === "qwen3-coder-next")?.input).toEqual(["text"]);
    });

    it("retains fresh schema and token metadata for a model also present in the bootstrap list", () => {
      const opus = mapped.find((model) => model.id === "claude-opus-4-8");
      expect(opus?.name).toBe("Catalog Opus 4.8");
      const catalogOpus = catalogFixture.find((model) => model.modelId === "claude-opus-4.8");
      expect(opus?.additionalModelRequestFieldsSchema).toEqual(catalogOpus?.additionalModelRequestFieldsSchema);
      expect(opus?.tokenLimits).toEqual(catalogOpus?.tokenLimits);
      expect(opus?.contextWindow).not.toBe(kiroModels.find((model) => model.id === opus?.id)?.contextWindow);
    });

    it("disables text tool-call recovery only for Claude catalog models", () => {
      const claudeModels = mapped.filter((model) => model.id.startsWith("claude-"));
      const nonClaudeModels = mapped.filter((model) => !model.id.startsWith("claude-"));

      expect(claudeModels.length).toBeGreaterThan(0);
      expect(claudeModels.every((model) => model.recoverTextToolCalls === false)).toBe(true);
      expect(nonClaudeModels.every((model) => model.recoverTextToolCalls === undefined)).toBe(true);
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

    it("addresses cached models at the region that served the catalog (#104)", async () => {
      resetKiroProfileArnCache();
      const fetchMock = vi
        .fn()
        // Profile discovery: nothing in the SSO-derived region, found in the other canonical one.
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [] }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: PROFILE_ARN }] }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ models: catalogFixture }) });
      vi.stubGlobal("fetch", fetchMock);

      await updateKiroModelsCache("secret-access-token", "eu-central-1");

      // Still keyed by the region the caller derived, so the synchronous lookup
      // every model consumer does keeps hitting...
      expect(getCachedModels("eu-central-1").map((model) => model.id)).toEqual(
        catalogFixture.map((model) => model.modelId.replace(/(\d)\.(\d)/g, "$1-$2")),
      );
      // ...but pointed at the region that actually answered, which is the only
      // one where this profile can be used.
      expect(getCachedCatalogRegion("eu-central-1")).toBe("us-east-1");
      expect(getCachedModels("eu-central-1")[0]?.baseUrl).toBe("https://runtime.us-east-1.kiro.dev/");
      expect(fetchMock.mock.calls[2][0]).toContain("https://management.us-east-1.kiro.dev/List-Available-Models");

      resetKiroProfileArnCache();
    });

    it("repairs stale Luna image metadata in memory without rewriting the cache", () => {
      const [cachedLuna] = mapKiroCatalogModels([{ modelId: "gpt-5.6-luna" }], TEST_REGION);
      cachedLuna.input = ["text"];
      const serialized = JSON.stringify({
        version: KIRO_MANAGEMENT_CACHE_VERSION,
        source: KIRO_MANAGEMENT_CACHE_SOURCE,
        regions: {
          [TEST_REGION]: {
            region: TEST_REGION,
            fetchedAt: Date.now(),
            models: [cachedLuna],
          },
        },
      });
      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, serialized, "utf-8");

      expect(getCachedModels(TEST_REGION)[0]?.input).toEqual(["text", "image"]);
      expect(readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8")).toBe(serialized);
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

    it("uses image input for Claude and text input for other concrete bootstrap models", () => {
      const claudeModels = kiroModels.filter((model) => model.id.startsWith("claude-"));
      const nonClaudeModels = kiroModels.filter((model) => !model.id.startsWith("claude-") && model.id !== "auto");
      expect(claudeModels.every((model) => model.input.includes("text") && model.input.includes("image"))).toBe(true);
      expect(nonClaudeModels.every((model) => model.input.length === 1 && model.input[0] === "text")).toBe(true);
    });

    it("disables text tool-call recovery only for Claude bootstrap models", () => {
      const claudeModels = kiroModels.filter((model) => model.id.startsWith("claude-"));
      const nonClaudeModels = kiroModels.filter((model) => !model.id.startsWith("claude-"));

      expect(claudeModels.length).toBeGreaterThan(0);
      expect(claudeModels.every((model) => model.recoverTextToolCalls === false)).toBe(true);
      expect(nonClaudeModels.every((model) => model.recoverTextToolCalls === undefined)).toBe(true);
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

  describe("omp thinking config", () => {
    const OPUS_SCHEMA = effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"], true);

    function validCache(models: unknown[], version: number = KIRO_MANAGEMENT_CACHE_VERSION): string {
      return JSON.stringify({
        version,
        source: KIRO_MANAGEMENT_CACHE_SOURCE,
        regions: { [TEST_REGION]: { region: TEST_REGION, fetchedAt: Date.now(), models } },
      });
    }

    it("returns the full ladder and display capability from a catalog schema", () => {
      expect(deriveThinkingConfig(deriveKiroEffort(OPUS_SCHEMA))).toEqual({
        mode: "effort",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        supportsDisplay: true,
      });
    });

    it("returns undefined when no supported effort enum is present", () => {
      expect(deriveThinkingConfig(deriveKiroEffort({ type: "object", properties: {} }))).toBeUndefined();
      expect(deriveThinkingConfig({ field: "reasoning", values: [], summarizedThinking: false })).toBeUndefined();
    });

    it("filters values outside omp's effort enum", () => {
      expect(
        deriveThinkingConfig({
          field: "reasoning",
          values: ["none", "low", "turbo", "max"],
          summarizedThinking: false,
        }),
      ).toEqual({
        mode: "effort",
        efforts: ["low", "max"],
      });
    });

    it("orders efforts lowest-first regardless of schema order", () => {
      expect(
        deriveThinkingConfig({
          field: "reasoning",
          values: ["max", "low", "high"],
          summarizedThinking: false,
        })?.efforts,
      ).toEqual(["low", "high", "max"]);
    });

    it("emits both thinking and thinkingLevelMap for a schema-bearing catalog model", () => {
      const opus = mapKiroCatalogModels(catalogFixture, TEST_REGION).find((model) => model.id === "claude-opus-4-8");

      expect(opus?.thinking).toEqual({
        mode: "effort",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        supportsDisplay: true,
      });
      expect(opus?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    });

    it("declares a ladder for every bootstrap model that maps xhigh or max", () => {
      const laddered = kiroModels.filter((model) => model.thinkingLevelMap !== undefined);

      expect(laddered.length).toBeGreaterThan(0);
      expect(laddered.every((model) => (model.thinking?.efforts.length ?? 0) > 0)).toBe(true);
      expect(kiroModels.every((model) => model.reasoning || model.thinking === undefined)).toBe(true);
    });

    it("uses the request fallback only when catalog schema is absent", () => {
      const [schemaLess] = mapKiroCatalogModels([{ modelId: "claude-opus-4.8" }], TEST_REGION);
      const [schemaWithoutEffort] = mapKiroCatalogModels(
        [{ modelId: "claude-opus-4.8", additionalModelRequestFieldsSchema: { type: "object", properties: {} } }],
        TEST_REGION,
      );

      expect(schemaLess.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(schemaWithoutEffort.thinking).toBeUndefined();
    });

    it("keeps a cached entry that carries a thinking config", () => {
      const models = mapKiroCatalogModels(catalogFixture, TEST_REGION);
      expect(models.some((model) => model.thinking !== undefined)).toBe(true);
      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, validCache(models), "utf-8");

      expect(getCachedModels(TEST_REGION).map((model) => model.id)).toEqual(models.map((model) => model.id));
    });

    it.each([
      ["a non-effort mode", { mode: "budget", efforts: ["low"] }],
      ["an empty effort list", { mode: "effort", efforts: [] }],
      ["an effort outside the enum", { mode: "effort", efforts: ["turbo"] }],
      ["a non-array effort list", { mode: "effort", efforts: "low" }],
      ["a non-boolean display flag", { mode: "effort", efforts: ["low"], supportsDisplay: "yes" }],
    ])("discards the whole cache when an entry has %s", (_label, thinking) => {
      const [first, ...rest] = mapKiroCatalogModels(catalogFixture, TEST_REGION);
      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, validCache([{ ...first, thinking }, ...rest]), "utf-8");

      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
    });

    it("drops a v1 cache written before the thinking field existed", () => {
      const models = mapKiroCatalogModels(catalogFixture, TEST_REGION).map(
        ({ thinking: _thinking, ...model }) => model,
      );
      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, validCache(models, 1), "utf-8");

      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
      expect(isCacheStale(TEST_REGION)).toBe(true);
    });
  });
});
