// Feature 2: Model Definitions

import { execFileSync } from "node:child_process";

// Valid Kiro model IDs - API accepts friendly names directly
export const KIRO_MODEL_IDS = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-5",
  "qwen3-coder-next",
  "auto",
]);

export function resolveKiroModel(modelId: string): string {
  // Convert pi format (dashes) to kiro format (dots): claude-opus-4-6 -> claude-opus-4.6
  // Only convert digit-dash-digit patterns (version numbers like 4-6 -> 4.6)
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  if (!KIRO_MODEL_IDS.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

/**
 * Map an SSO/OIDC region to the Kiro API region.
 *
 * The Kiro Q API is only deployed in a subset of regions. Tokens issued by
 * an SSO instance in e.g. eu-west-1 must be sent to the eu-central-1 API
 * endpoint. This mirrors the endpoint resolution that kiro-cli performs
 * internally via the AWS SDK partition resolver.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-southeast-3": "us-east-1",
  "ap-southeast-4": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-northeast-2": "us-east-1",
  "ap-northeast-3": "us-east-1",
  "ap-east-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "ap-south-2": "us-east-1",
  "ca-central-1": "us-east-1",
  "ca-west-1": "us-east-1",
  "sa-east-1": "us-east-1",
  "me-south-1": "us-east-1",
  "me-central-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
  "af-south-1": "eu-central-1",
  "il-central-1": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
  //te: if ssoRegion is already "us-east-1" or "eu-central-1" (API regions),
  // it won't be in the map but will pass through correctly to MODELS_BY_REGION.
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
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "deepseek-3-2",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-5",
    "qwen3-coder-next",
    "auto",
  ]),
  "eu-central-1": new Set([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "qwen3-coder-next",
    "auto",
  ]),
};

/** Filter a model list to only those available in the given API region.
 *  Falls back to MODELS_BY_REGION allowlist when kiro-cli is unavailable. */

type KiroCliModel = { model_id: string };
let cachedCliModels: KiroCliModel[] | null = null;

function fetchKiroCliModels(): KiroCliModel[] | null {
  if (cachedCliModels !== null) return cachedCliModels;
  try {
    const out = execFileSync("kiro-cli", ["chat", "--list-models", "--format", "json"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const data = JSON.parse(out) as { models: KiroCliModel[] };
    cachedCliModels = data.models ?? [];
    return cachedCliModels;
  } catch {
    cachedCliModels = []; // don't retry on failure
    return null;
  }
}

export function filterModelsByRegion<T extends { id: string }>(models: T[], apiRegion: string): T[] {
  const allowed = MODELS_BY_REGION[apiRegion];
  if (!allowed) {
    console.warn(
      `[pi-provider-kiro] Unknown API region "${apiRegion}" — no models available. Update MODELS_BY_REGION in models.ts.`,
    );
    return [];
  }
  let filtered = models.filter((m) => allowed.has(m.id));

  // Intersect with live kiro-cli model list to remove IDs no longer valid
  const cliModels = fetchKiroCliModels();
  if (cliModels && cliModels.length > 0) {
    const cliIds = new Set(cliModels.map((m) => m.model_id.replace(/(\d)\.(\d)/g, "$1-$2")));
    filtered = filtered.filter((m) => cliIds.has(m.id));
  }

  return filtered;
}

const BASE_URL = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const kiroModels = [
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
    firstTokenTimeout: 180_000,
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
  // Claude Opus 4.5
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 32768,
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
    contextWindow: 128000,
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
    contextWindow: 200000,
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
    contextWindow: 200000,
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
    contextWindow: 200000,
    maxTokens: 65536,
  },
];
