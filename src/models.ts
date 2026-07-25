// Feature 2: Model Definitions

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { deriveKiroEffort } from "./effort.js";
import { getKiroEndpoints } from "./endpoints.js";
import { fetchKiroModelCatalog, type KiroCatalogModel } from "./management.js";

export { resolveApiRegion } from "./endpoints.js";

export const KIRO_MANAGEMENT_CACHE_VERSION = 1;
export const KIRO_MANAGEMENT_CACHE_SOURCE = "kiro-management";
export const KIRO_MANAGEMENT_CACHE_PATH = join(homedir(), ".kiro-management-models-cache.json");

const CACHE_MAX_AGE_MS = 3600_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const BASE_URL = getKiroEndpoints("us-east-1").runtime;
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const REASONING_FAMILY_MARKERS = ["opus", "sonnet", "fable", "coder", "deepseek", "gpt", "glm", "qwen"];

type KiroTokenLimits = NonNullable<KiroCatalogModel["tokenLimits"]>;

export interface KiroModel extends Model<"kiro-api"> {
  /** Exact model ID returned by the Kiro management catalog. */
  kiroModelId: string;
  /** Catalog metadata consumed by request-time effort handling. */
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
  tokenLimits?: KiroTokenLimits;
  firstTokenTimeout?: number;
  kiroRegion?: string;
  /** Credential-scoped profile ARN attached only to the in-memory model projection. */
  kiroProfileArn?: string;
}

interface ManagementCacheRegion {
  region: string;
  fetchedAt: number;
  models: KiroModel[];
}

interface ManagementModelsCache {
  version: typeof KIRO_MANAGEMENT_CACHE_VERSION;
  source: typeof KIRO_MANAGEMENT_CACHE_SOURCE;
  regions: Record<string, ManagementCacheRegion>;
}

export const kiroModels: KiroModel[] = [
  {
    id: "claude-opus-4-8",
    kiroModelId: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
    firstTokenTimeout: 180_000,
  },
  {
    id: "claude-opus-4-7",
    kiroModelId: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
    firstTokenTimeout: 180_000,
  },
  {
    id: "claude-opus-4-6",
    kiroModelId: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "claude-sonnet-5",
    kiroModelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "claude-sonnet-4-6",
    kiroModelId: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "claude-sonnet-4-5",
    kiroModelId: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  {
    id: "claude-sonnet-4",
    kiroModelId: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  {
    id: "claude-haiku-4-5",
    kiroModelId: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  {
    id: "claude-fable-5",
    kiroModelId: "claude-fable-5",
    name: "Claude Fable 5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "deepseek-3-2",
    kiroModelId: "deepseek-3.2",
    name: "DeepSeek 3.2",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 164000,
    maxTokens: 8192,
  },
  {
    id: "minimax-m2-5",
    kiroModelId: "minimax-m2.5",
    name: "MiniMax M2.5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 196000,
    maxTokens: 8192,
  },
  {
    id: "minimax-m2-1",
    kiroModelId: "minimax-m2.1",
    name: "MiniMax M2.1",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 196000,
    maxTokens: 8192,
  },
  {
    id: "glm-5",
    kiroModelId: "glm-5",
    name: "GLM 5",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "qwen3-coder-next",
    kiroModelId: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 8192,
  },
  {
    id: "auto",
    kiroModelId: "auto",
    name: "Auto",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
];

const BOOTSTRAP_KIRO_MODEL_IDS = kiroModels.map((model) => model.kiroModelId);

/** Exact service IDs known from either the bootstrap list or a valid management cache. */
export const KIRO_MODEL_IDS = new Set(BOOTSTRAP_KIRO_MODEL_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isThinkingLevelMap(value: unknown): value is ThinkingLevelMap {
  return (
    isRecord(value) &&
    Object.values(value).every((mappedValue) => typeof mappedValue === "string" || mappedValue === null)
  );
}

function isCachedKiroModel(value: unknown): value is KiroModel {
  if (!isRecord(value)) return false;
  const cost = value.cost;
  const input = value.input;
  const schema = value.additionalModelRequestFieldsSchema;
  const tokenLimits = value.tokenLimits;

  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.kiroModelId === "string" &&
    value.kiroModelId.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.api === "kiro-api" &&
    value.provider === "kiro" &&
    typeof value.baseUrl === "string" &&
    typeof value.reasoning === "boolean" &&
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((modality) => modality === "text" || modality === "image") &&
    isRecord(cost) &&
    typeof cost.input === "number" &&
    typeof cost.output === "number" &&
    typeof cost.cacheRead === "number" &&
    typeof cost.cacheWrite === "number" &&
    isPositiveNumber(value.contextWindow) &&
    isPositiveNumber(value.maxTokens) &&
    (value.thinkingLevelMap === undefined || isThinkingLevelMap(value.thinkingLevelMap)) &&
    (schema === undefined || isRecord(schema)) &&
    (tokenLimits === undefined || isRecord(tokenLimits)) &&
    (value.firstTokenTimeout === undefined || isPositiveNumber(value.firstTokenTimeout))
  );
}

function parseManagementCache(raw: string): ManagementModelsCache | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== KIRO_MANAGEMENT_CACHE_VERSION ||
    value.source !== KIRO_MANAGEMENT_CACHE_SOURCE ||
    !isRecord(value.regions)
  ) {
    return undefined;
  }

  const regions: Record<string, ManagementCacheRegion> = {};
  for (const [region, rawEntry] of Object.entries(value.regions)) {
    if (
      !isRecord(rawEntry) ||
      rawEntry.region !== region ||
      !isPositiveNumber(rawEntry.fetchedAt) ||
      !Array.isArray(rawEntry.models) ||
      rawEntry.models.length === 0 ||
      !rawEntry.models.every(isCachedKiroModel)
    ) {
      return undefined;
    }
    const modelIds = new Set<string>();
    for (const model of rawEntry.models) {
      if (modelIds.has(model.id)) return undefined;
      modelIds.add(model.id);
    }
    regions[region] = rawEntry as unknown as ManagementCacheRegion;
  }

  return {
    version: KIRO_MANAGEMENT_CACHE_VERSION,
    source: KIRO_MANAGEMENT_CACHE_SOURCE,
    regions,
  };
}

function readManagementCache(): ManagementModelsCache | undefined {
  if (!existsSync(KIRO_MANAGEMENT_CACHE_PATH)) return undefined;
  try {
    return parseManagementCache(readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeManagementCache(cache: ManagementModelsCache): void {
  const temporaryPath = `${KIRO_MANAGEMENT_CACHE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(temporaryPath, KIRO_MANAGEMENT_CACHE_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function toPiModelId(kiroModelId: string): string {
  return kiroModelId.replace(/(\d)\.(\d)/g, "$1-$2");
}

function humanizeModelId(modelId: string): string {
  return modelId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function deriveThinkingLevelMap(effortValues: readonly string[] | undefined): ThinkingLevelMap | undefined {
  if (!effortValues) return undefined;
  const thinkingLevelMap: ThinkingLevelMap = {};
  if (effortValues.includes("xhigh")) thinkingLevelMap.xhigh = "xhigh";
  if (effortValues.includes("max")) thinkingLevelMap.max = "max";
  return Object.keys(thinkingLevelMap).length > 0 ? thinkingLevelMap : undefined;
}

function hasReasoningFamilyFallback(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return normalizedId === "auto" || REASONING_FAMILY_MARKERS.some((marker) => normalizedId.includes(marker));
}

function validateCatalogMetadata(model: KiroCatalogModel): {
  schema?: Record<string, unknown>;
  tokenLimits?: KiroTokenLimits;
} {
  const rawSchema = model.additionalModelRequestFieldsSchema;
  const schema = rawSchema ?? undefined;
  if (schema !== undefined && !isRecord(schema)) {
    throw new Error(`Kiro management catalog model ${model.modelId} has an invalid request-fields schema`);
  }

  const tokenLimits = model.tokenLimits;
  if (tokenLimits !== undefined && !isRecord(tokenLimits)) {
    throw new Error(`Kiro management catalog model ${model.modelId} has invalid token limits`);
  }
  if (
    tokenLimits &&
    ((tokenLimits.maxInputTokens !== undefined && !isPositiveNumber(tokenLimits.maxInputTokens)) ||
      (tokenLimits.maxOutputTokens !== undefined && !isPositiveNumber(tokenLimits.maxOutputTokens)))
  ) {
    throw new Error(`Kiro management catalog model ${model.modelId} has invalid token limits`);
  }

  return { schema, tokenLimits };
}

/** Map an authenticated management catalog into Pi models without discarding fresh metadata for bootstrap IDs. */
export function mapKiroCatalogModels(catalogModels: KiroCatalogModel[], region: string): KiroModel[] {
  if (catalogModels.length === 0) {
    throw new Error(`Kiro management catalog returned no models in ${region}`);
  }

  const seenPiIds = new Set<string>();
  return catalogModels.map((catalogModel) => {
    const kiroModelId = catalogModel.modelId;
    if (!kiroModelId || kiroModelId.trim() !== kiroModelId) {
      throw new Error(`Kiro management catalog returned an invalid model ID in ${region}`);
    }
    const id = toPiModelId(kiroModelId);
    if (seenPiIds.has(id)) {
      throw new Error(`Kiro management catalog contains conflicting model ID ${id} in ${region}`);
    }
    seenPiIds.add(id);

    const existing = kiroModels.find((model) => model.id === id);
    const { schema, tokenLimits } = validateCatalogMetadata(catalogModel);
    const effortValues = deriveKiroEffort(schema)?.values;
    const thinkingLevelMap = deriveThinkingLevelMap(effortValues);
    const catalogName =
      typeof catalogModel.displayName === "string" && catalogModel.displayName.length > 0
        ? catalogModel.displayName
        : undefined;
    const isClaude = id.startsWith("claude-");

    return {
      id,
      kiroModelId,
      name: catalogName ?? existing?.name ?? humanizeModelId(id),
      api: "kiro-api",
      provider: "kiro",
      baseUrl: getKiroEndpoints(region).runtime,
      reasoning: effortValues !== undefined || (schema === undefined && hasReasoningFamilyFallback(id)),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: existing ? [...existing.input] : isClaude ? ["text", "image"] : ["text"],
      cost: ZERO_COST,
      contextWindow: tokenLimits?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: tokenLimits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      ...(existing?.firstTokenTimeout ? { firstTokenTimeout: existing.firstTokenTimeout } : {}),
      ...(schema ? { additionalModelRequestFieldsSchema: schema } : {}),
      ...(tokenLimits ? { tokenLimits } : {}),
    };
  });
}

function refreshKnownModelIds(cache: ManagementModelsCache | undefined): void {
  KIRO_MODEL_IDS.clear();
  for (const modelId of BOOTSTRAP_KIRO_MODEL_IDS) KIRO_MODEL_IDS.add(modelId);
  if (!cache) return;
  for (const entry of Object.values(cache.regions)) {
    for (const model of entry.models) KIRO_MODEL_IDS.add(model.kiroModelId);
  }
}

export function loadCachedModelIds(): void {
  refreshKnownModelIds(readManagementCache());
}

/** Return the authenticated regional catalog, or the static list only as a pre-discovery bootstrap. */
export function getCachedModels(region: string): KiroModel[] {
  const cache = readManagementCache();
  refreshKnownModelIds(cache);
  return cache?.regions[region]?.models ?? kiroModels;
}

export function isCacheStale(region: string): boolean {
  const entry = readManagementCache()?.regions[region];
  return !entry || Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS;
}

export async function updateKiroModelsCache(accessToken: string, region: string, profileArn?: string): Promise<void> {
  const response = await fetchKiroModelCatalog({ accessToken, region }, profileArn);
  const models = mapKiroCatalogModels(response.models, region);
  const existingCache = readManagementCache();
  const cache: ManagementModelsCache = existingCache ?? {
    version: KIRO_MANAGEMENT_CACHE_VERSION,
    source: KIRO_MANAGEMENT_CACHE_SOURCE,
    regions: {},
  };

  cache.regions[region] = { region, fetchedAt: Date.now(), models };
  writeManagementCache(cache);
  refreshKnownModelIds(cache);
}

export function resolveKiroModel(modelId: string, exactKiroModelId?: string): string {
  if (exactKiroModelId) return exactKiroModelId;

  const cachedModel = Object.values(readManagementCache()?.regions ?? {})
    .flatMap((entry) => entry.models)
    .find((model) => model.id === modelId);
  if (cachedModel) {
    KIRO_MODEL_IDS.add(cachedModel.kiroModelId);
    return cachedModel.kiroModelId;
  }

  const bootstrapModel = kiroModels.find((model) => model.id === modelId);
  if (bootstrapModel) return bootstrapModel.kiroModelId;

  const normalizedId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  loadCachedModelIds();
  if (!KIRO_MODEL_IDS.has(normalizedId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return normalizedId;
}
