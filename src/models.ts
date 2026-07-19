// Feature 2: Model Definitions

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchKiroModelCatalog } from "./management.js";

export { resolveApiRegion } from "./endpoints.js";

const CACHE_PATH = join(homedir(), ".kiro-models-cache.json");

// Valid Kiro model IDs - API accepts friendly names directly
export const KIRO_MODEL_IDS = new Set([
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "claude-fable-5",
  "deepseek-3.2",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-5",
  "qwen3-coder-next",
  "auto",
]);

let cachedIdsLoaded = false;
export function loadCachedModelIds(): void {
  if (cachedIdsLoaded) return;
  if (!existsSync(CACHE_PATH)) return;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, typeof kiroModels>;
    for (const regionModels of Object.values(data)) {
      if (Array.isArray(regionModels)) {
        for (const m of regionModels) {
          if (m?.id) {
            const kiroId = m.id.replace(/(\d)-(\d)/g, "$1.$2");
            KIRO_MODEL_IDS.add(kiroId);
          }
        }
      }
    }
    cachedIdsLoaded = true;
  } catch {
    // Ignore cache errors
  }
}

export function getCachedModels(region: string): typeof kiroModels {
  if (existsSync(CACHE_PATH)) {
    try {
      const raw = readFileSync(CACHE_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, typeof kiroModels>;
      if (data && Array.isArray(data[region])) {
        return data[region];
      }
    } catch {
      // Ignore cache errors
    }
  }
  return filterModelsByRegion(kiroModels, region);
}

export function isCacheStale(region: string): boolean {
  if (!existsSync(CACHE_PATH)) return true;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, typeof kiroModels>;
    if (!data || !Array.isArray(data[region])) return true;
    const stat = statSync(CACHE_PATH);
    // Stale if older than 1 hour
    return Date.now() - stat.mtimeMs > 3600_000;
  } catch {
    return true;
  }
}

export async function updateKiroModelsCache(accessToken: string, region: string, profileArn?: string): Promise<void> {
  const qHost = `https://q.${region}.amazonaws.com`;
  const data = await fetchKiroModelCatalog({ accessToken, region }, profileArn);
  const fetchedModels = data.models;

  const newModels = fetchedModels.map((fm) => {
    const kiroId = fm.modelId;
    const piId = kiroId.replace(/(\d)\.(\d)/g, "$1-$2");

    const existing = kiroModels.find((m) => m.id === piId);
    if (existing) {
      return existing;
    }

    const isClaude = piId.startsWith("claude");
    const isReasoning =
      piId.includes("opus") || piId.includes("sonnet") || piId.includes("coder") || piId.includes("deepseek");
    const name = piId
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    return {
      id: piId,
      name: name,
      api: "kiro-api" as const,
      provider: "kiro" as const,
      baseUrl: `${qHost}/generateAssistantResponse`,
      reasoning: isReasoning,
      input: isClaude ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
      cost: ZERO_COST,
      contextWindow: isClaude ? 1000000 : 200000,
      maxTokens: isClaude ? 65536 : 8192,
    };
  });

  if (!newModels.some((m) => m.id === "auto")) {
    newModels.push({
      id: "auto",
      name: "Auto",
      api: "kiro-api" as const,
      provider: "kiro" as const,
      baseUrl: `${qHost}/generateAssistantResponse`,
      reasoning: true,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 1000000,
      maxTokens: 65536,
    });
  }

  let cache: Record<string, typeof kiroModels> = {};
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    } catch {
      // Ignore parsing errors
    }
  }

  cache[region] = newModels;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

  cachedIdsLoaded = false;
  loadCachedModelIds();
}

export function resolveKiroModel(modelId: string): string {
  // Convert pi format (dashes) to kiro format (dots): claude-opus-4-6 -> claude-opus-4.6
  // Only convert digit-dash-digit patterns (version numbers like 4-6 -> 4.6)
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  loadCachedModelIds();
  if (!KIRO_MODEL_IDS.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

/**
 * Model availability per API region (allowlist).
 * Source: https://kiro.dev/docs/cli/models/
 *
 * When a new region is added, it must be explicitly listed here with its
 * supported models — unknown regions get no models, forcing a conscious
 * update rather than silently exposing unsupported models.
 */
const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "claude-fable-5",
    "deepseek-3-2",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-5",
    "qwen3-coder-next",
    "auto",
  ]),
  // API-verified 2026-04-14 (eu-west-1 IdC token), glm-5 removed 2026-05-05 (us-east-1 only)
  "eu-central-1": new Set([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "claude-fable-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "qwen3-coder-next",
    "auto",
  ]),
};

/** Filter a model list to only those available in the given API region.
 *  Unknown regions return an empty list — add the region to MODELS_BY_REGION. */
export function filterModelsByRegion<T extends { id: string }>(models: T[], apiRegion: string): T[] {
  const allowed = MODELS_BY_REGION[apiRegion];
  if (!allowed) {
    console.warn(
      `[pi-provider-kiro] Unknown API region "${apiRegion}" — no models available. Update MODELS_BY_REGION in models.ts.`,
    );
    return [];
  }
  return models.filter((m) => allowed.has(m.id));
}

const BASE_URL = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const kiroModels = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
    firstTokenTimeout: 180_000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 128000,
    firstTokenTimeout: 180_000,
  },
  // Claude Opus 4.6
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  // Claude Sonnet 5
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  // Claude Sonnet 4.6
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  // Claude Sonnet 4.5
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  // Claude Sonnet 4
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  // Claude Haiku 4.5
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  // DeepSeek
  {
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 164000,
    maxTokens: 8192,
  },
  // MiniMax
  {
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 196000,
    maxTokens: 8192,
  },
  {
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 196000,
    maxTokens: 8192,
  },
  // GLM (Zhipu AI)
  {
    id: "glm-5",
    name: "GLM 5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  // Qwen (Alibaba)
  {
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 8192,
  },
  // Auto — routes to optimal model per task
  {
    id: "auto",
    name: "Auto",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
];
