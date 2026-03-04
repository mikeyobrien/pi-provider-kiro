// ABOUTME: Fallback wrapper that tries Kiro first, then falls back to Bedrock on failure.
// ABOUTME: Maps Kiro model IDs to Bedrock equivalents and proxies stream events.
// ABOUTME: Automatically resolves AWS profile/region for Bedrock from environment or config.

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
// @ts-ignore - importing from internal path
import type { BedrockOptions } from "@mariozechner/pi-ai/dist/providers/amazon-bedrock.js";
// @ts-ignore - importing from internal path
import { streamBedrock } from "@mariozechner/pi-ai/dist/providers/amazon-bedrock.js";
// @ts-ignore - importing from internal path
import { MODELS } from "@mariozechner/pi-ai/dist/models.generated.js";
// @ts-ignore - importing from internal path
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "@mariozechner/pi-ai/dist/providers/simple-options.js";
import { streamKiro } from "./stream.js";

// Map kiro model IDs to their bedrock equivalents.
// Uses cross-region inference (us.*) variants where available.
const KIRO_TO_BEDROCK: Record<string, string> = {
  "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
  "claude-opus-4-6-1m": "us.anthropic.claude-opus-4-6-v1",
  "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-5-20250929-v1:0", // closest available
  "claude-sonnet-4-6-1m": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-opus-4-5": "us.anthropic.claude-opus-4-5-20251101-v1:0",
  "claude-sonnet-4-5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-sonnet-4-5-1m": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-sonnet-4": "us.anthropic.claude-sonnet-4-20250514-v1:0",
  "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "deepseek-3-2": "deepseek.v3.2-v1:0",
  "kimi-k2-5": "moonshotai.kimi-k2.5",
  "minimax-m2-1": "minimax.minimax-m2.1",
  "glm-4-7": "zai.glm-4.7",
  "glm-4-7-flash": "zai.glm-4.7-flash",
  "qwen3-coder-next": "qwen.qwen3-coder-480b-a35b-v1:0", // closest available
  "qwen3-coder-480b": "qwen.qwen3-coder-480b-a35b-v1:0",
  "agi-nova-beta-1m": "amazon.nova-premier-v1:0", // closest Nova model
};

function getBedrockModel(kiroModelId: string): Model<"bedrock-converse-stream"> | null {
  const bedrockId = KIRO_TO_BEDROCK[kiroModelId];
  if (!bedrockId) return null;

  const bedrockModels = MODELS["amazon-bedrock"] as Record<string, Model<"bedrock-converse-stream">> | undefined;
  if (!bedrockModels?.[bedrockId]) return null;

  return bedrockModels[bedrockId];
}

/**
 * Resolves the AWS profile for Bedrock fallback.
 *
 * Priority:
 *   1. PI_BEDROCK_PROFILE env var (explicit override for this extension)
 *   2. AWS_PROFILE env var (standard AWS SDK convention)
 *   3. undefined (let AWS SDK use default credential chain)
 */
function resolveBedrockProfile(): string | undefined {
  return process.env.PI_BEDROCK_PROFILE || process.env.AWS_PROFILE || undefined;
}

/**
 * Resolves the AWS region for Bedrock fallback.
 *
 * Priority:
 *   1. PI_BEDROCK_REGION env var (explicit override)
 *   2. AWS_REGION env var
 *   3. AWS_DEFAULT_REGION env var
 *   4. Region from model baseUrl (e.g., bedrock-runtime.us-east-1.amazonaws.com)
 *   5. "us-east-1" as final fallback
 */
function resolveBedrockRegion(model: Model<"bedrock-converse-stream">): string {
  if (process.env.PI_BEDROCK_REGION) return process.env.PI_BEDROCK_REGION;
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION;

  // Extract region from model baseUrl
  const match = model.baseUrl?.match(/bedrock-runtime\.([^.]+)\.amazonaws\.com/);
  if (match) return match[1];

  return "us-east-1";
}

/**
 * Build BedrockOptions from SimpleStreamOptions, adding profile and region.
 * Mirrors what streamSimpleBedrock does internally but with profile support.
 */
function buildBedrockOptions(
  model: Model<"bedrock-converse-stream">,
  options?: SimpleStreamOptions,
): BedrockOptions {
  const base = buildBaseOptions(model, options, undefined);
  const profile = resolveBedrockProfile();
  const region = resolveBedrockRegion(model);

  const bedrockOpts: BedrockOptions = {
    ...base,
    profile,
    region,
  };

  // Handle reasoning/thinking budget (same logic as streamSimpleBedrock)
  if (options?.reasoning) {
    bedrockOpts.reasoning = options.reasoning;
    if (model.id.includes("anthropic.claude") || model.id.includes("anthropic/claude")) {
      const adjusted = adjustMaxTokensForThinking(
        base.maxTokens || 0,
        model.maxTokens,
        options.reasoning,
        options.thinkingBudgets,
      );
      bedrockOpts.maxTokens = adjusted.maxTokens;
      bedrockOpts.thinkingBudgets = {
        ...(options.thinkingBudgets || {}),
        [clampReasoning(options.reasoning) as string]: adjusted.thinkingBudget,
      };
    }
  }

  return bedrockOpts;
}

/**
 * Attempt Bedrock fallback for a failed Kiro request.
 * Returns true if fallback was attempted (success or failure), false if no mapping exists.
 */
async function tryBedrockFallback(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  wrapper: AssistantMessageEventStream,
  errorMessage: string,
  gotStart: boolean,
): Promise<boolean> {
  const bedrockModel = getBedrockModel(model.id);
  if (!bedrockModel) return false;

  const profile = resolveBedrockProfile();
  const region = resolveBedrockRegion(bedrockModel);
  console.warn(
    `[pi-provider-kiro] Kiro failed (${errorMessage}), falling back to Bedrock model: ${bedrockModel.id} (profile=${profile || "default"}, region=${region})`,
  );

  const bedrockOpts = buildBedrockOptions(bedrockModel, options);
  const bedrockStream = streamBedrock(bedrockModel, context, bedrockOpts);

  for await (const event of bedrockStream) {
    // If we already pushed a start event from kiro, skip the bedrock start
    if (event.type === "start" && gotStart) continue;
    // Tag events with fallback info so the UI shows which backend served the response
    if ("partial" in event && event.partial) {
      event.partial.provider = "bedrock";
      event.partial.model = `${model.id} (bedrock)`;
    }
    if (event.type === "done" && event.message) {
      event.message.provider = "bedrock";
      event.message.model = `${model.id} (bedrock)`;
    }
    wrapper.push(event);
  }

  return true;
}

function emitError(
  wrapper: AssistantMessageEventStream,
  model: Model<Api>,
  errorMessage: string,
  reason: "error" | "aborted" = "error",
): void {
  wrapper.push({
    type: "error",
    reason,
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason,
      errorMessage,
      timestamp: Date.now(),
    },
  });
}

/**
 * Wraps the Kiro stream with automatic fallback to Bedrock.
 * If the Kiro stream emits an error event OR throws an exception,
 * a Bedrock stream is started transparently using the equivalent model.
 *
 * AWS credentials for Bedrock are resolved automatically:
 *   - PI_BEDROCK_PROFILE or AWS_PROFILE → named profile in ~/.aws/config
 *   - credential_process in the profile config auto-refreshes via ada
 *   - Falls back to standard AWS SDK credential chain if no profile is set
 */
export function streamWithFallback(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const wrapper = createAssistantMessageEventStream();

  (async () => {
    let gotStart = false;

    try {
      // Try Kiro first
      const kiroStream = streamKiro(model, context, options);
      let gotError = false;
      let errorMessage = "";

      for await (const event of kiroStream) {
        if (event.type === "error") {
          gotError = true;
          errorMessage = event.error?.errorMessage || "Unknown Kiro error";
          break;
        }
        if (event.type === "start") gotStart = true;
        wrapper.push(event);
        if (event.type === "done") {
          wrapper.end();
          return;
        }
      }

      // If we got no error and stream ended cleanly without "done", just end
      if (!gotError) {
        wrapper.end();
        return;
      }

      // --- Fallback to Bedrock ---
      const didFallback = await tryBedrockFallback(model, context, options, wrapper, errorMessage, gotStart);
      if (!didFallback) {
        emitError(wrapper, model, `Kiro failed (${errorMessage}) and no Bedrock fallback available for model ${model.id}`);
      }

      wrapper.end();
    } catch (error) {
      // Kiro threw an exception (auth failure, network error, etc.)
      // — try Bedrock before giving up.
      if (options?.signal?.aborted) {
        emitError(wrapper, model, error instanceof Error ? error.message : String(error), "aborted");
        wrapper.end();
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        const didFallback = await tryBedrockFallback(model, context, options, wrapper, errorMessage, gotStart);
        if (didFallback) {
          wrapper.end();
          return;
        }
      } catch (bedrockError) {
        // Bedrock also failed — report both errors
        const bedrockMsg = bedrockError instanceof Error ? bedrockError.message : String(bedrockError);
        emitError(wrapper, model, `Kiro failed (${errorMessage}), Bedrock fallback also failed: ${bedrockMsg}`);
        wrapper.end();
        return;
      }

      // No Bedrock mapping — emit original error
      emitError(wrapper, model, errorMessage);
      wrapper.end();
    }
  })().catch(() => {
    try { wrapper.end(); } catch {}
  });

  return wrapper;
}
