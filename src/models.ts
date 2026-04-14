// Feature 2: Model Definitions

// Valid Kiro model IDs - API accepts friendly names directly
export const KIRO_MODEL_IDS = new Set([
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-1m",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "kimi-k2.5",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-4.7",
  "glm-4.7-flash",
  "qwen3-coder-next",
  "agi-nova-beta-1m",
  "qwen3-coder-480b",
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
  "us-east-2": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
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
    "claude-opus-4-6-1m",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-1m",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "deepseek-3-2",
    "kimi-k2-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-4-7",
    "glm-4-7-flash",
    "qwen3-coder-next",
    "qwen3-coder-480b",
    "agi-nova-beta-1m",
    "auto",
  ]),
  // API-verified 2026-04-14 (eu-west-1 IdC token)
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
  // Claude Opus 4.6
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M)",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
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
    contextWindow: 200000,
    maxTokens: 65536,
  },
  {
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 (1M)",
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
  {
    id: "claude-sonnet-4-5-1m",
    name: "Claude Sonnet 4.5 (1M)",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
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
  // Kimi (Moonshot AI)
  {
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 200000,
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
    id: "glm-4-7",
    name: "GLM 4.7",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "glm-4-7-flash",
    name: "GLM 4.7 Flash",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 128000,
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
  {
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  // AGI Nova
  {
    id: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    api: "kiro-api" as const,
    provider: "kiro" as const,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 65536,
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
