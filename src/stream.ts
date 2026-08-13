// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import { createKiroTurnProvenanceDiagnostic } from "./diagnostics.js";
import {
  buildKiroAdditionalModelRequestFields,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
} from "./effort.js";
import { getKiroEndpoints, getKiroRegionFromEndpoint } from "./endpoints.js";
import { type KiroUsageData, parseKiroEvent } from "./event-parser.js";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  prepareHistory,
} from "./history.js";
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, refreshViaKiroCli } from "./kiro-cli.js";
import {
  invalidateKiroProfileArn,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "./management.js";
import { resolveKiroModel } from "./models.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  firstTokenTimeoutForModel,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  MAX_RETRY_DELAY,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import {
  applyContextUsage,
  applyMeteringCredits,
  finalizeKiroUsage,
  type KiroUsage,
  resetKiroUsage,
} from "./token-usage.js";
import { countTokens } from "./tokenizer.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  EMPTY_CONTENT_PLACEHOLDER,
  extractImages,
  getContentText,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform.js";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "./truncation.js";

const CAPACITY_LOG_DIR = join(homedir(), ".pi", "logs");
const CAPACITY_LOG_FILE = join(CAPACITY_LOG_DIR, "capacity-retries.log");

const eventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
});

let capacityLogDirCreated = false;

function logCapacityEvent(message: string): void {
  // Fire-and-forget async logging to avoid blocking the event loop
  (async () => {
    try {
      if (!capacityLogDirCreated) {
        await mkdir(CAPACITY_LOG_DIR, { recursive: true });
        capacityLogDirCreated = true;
      }
      await appendFile(CAPACITY_LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // best-effort logging, don't break the provider
    }
  })();
}

/** Delay that rejects early if the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  additionalModelRequestFields?: KiroAdditionalModelRequestFields;
  profileArn: string;
  agentMode?: string;
}
interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

let skipProfileResolutionForTests = false;
const TEST_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test";

/** Reset profile resolution state — exported for stream tests. */
export function resetProfileArnCache(resolved = false): void {
  resetKiroProfileArnCache();
  skipProfileResolutionForTests = resolved;
}

function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): boolean {
  if (!state.input.trim()) {
    // Kiro API omits the input payload when the model calls a tool with no
    // arguments (e.g. mcp({})). Treat empty input as an empty object rather
    // than skipping — these are valid zero-arg tool calls, not truncations.
    state.input = "{}";
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
  } catch (e) {
    console.warn(
      `[pi-provider-kiro] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${formatSafeError(e)}. Raw input (${state.input.length} chars): ${redactSensitiveText(state.input.substring(0, 200))}`,
    );
    return false;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: state.input, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return true;
}

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // pi-ai's barrel re-exports the class as type-only before the runtime class re-export, so
  // a named import of AssistantMessageEventStream resolves to a type. Read it from the
  // namespace import to get the actual constructor. Replaces the removed
  // createAssistantMessageEventStream() factory (gone in @oh-my-pi/pi-ai).
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();
  (async () => {
    // Held as `KiroUsage` (pi's `Usage` plus Kiro-only figures) so the
    // Kiro-specific fields are compiler-checked instead of being written
    // through a cast. `output.usage` is the same object.
    //
    // cacheRead/cacheWrite start at 0 because pi's `Usage` requires numbers,
    // but that 0 is a placeholder, not a measurement: until a turn reports
    // cache counts, `usage.provenance.cache` stays absent so consumers can
    // tell "no cache hits" apart from "the service never said".
    const usage: KiroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const initialAccessToken = options?.apiKey;
      if (!initialAccessToken) throw new Error("Kiro credentials not set. Run /login kiro or install kiro-cli.");
      let accessToken: string = initialAccessToken;
      const modelMetadata = model as Model<Api> & {
        kiroModelId?: string;
        kiroRegion?: string;
        kiroProfileArn?: string;
        additionalModelRequestFieldsSchema?: Record<string, unknown>;
      };
      const region = modelMetadata.kiroRegion ?? getKiroRegionFromEndpoint(model.baseUrl) ?? "us-east-1";
      const endpoint = new URL("generateAssistantResponse", getKiroEndpoints(region).runtime).toString();
      let managementAuth: KiroManagementAuth = { accessToken, region };

      const optionProfileArn =
        (options as unknown as { credentials?: { profileArn?: string }; profileArn?: string })?.credentials
          ?.profileArn || (options as unknown as { profileArn?: string })?.profileArn;
      const cliCreds = getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired();
      const cliProfileArn = cliCreds?.access === accessToken ? cliCreds.profileArn : undefined;
      const initialProfileArn = modelMetadata.kiroProfileArn || optionProfileArn || cliProfileArn;
      let profileArn: string;
      try {
        profileArn =
          initialProfileArn ||
          (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
      } catch (error) {
        if (!(error instanceof KiroManagementHttpError) || error.status !== 403) throw error;

        // The host may have captured an access token before kiro-cli rotated it.
        // Re-read the shared store first, then force a refresh only when it still
        // contains the rejected token. Profile discovery must succeed before the
        // runtime request can be constructed.
        const storedCreds = getKiroCliCredentials();
        const freshCreds =
          storedCreds?.access && storedCreds.access !== accessToken ? storedCreds : refreshViaKiroCli();
        if (!freshCreds?.access) throw error;

        accessToken = freshCreds.access;
        managementAuth = { accessToken, region };
        profileArn =
          freshCreds.profileArn ||
          (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
      }

      // Trigger dynamic models cache update in the background if empty or stale
      const { isCacheStale, updateKiroModelsCache } = await import("./models.js");
      if (!process.env.VITEST && isCacheStale(region)) {
        updateKiroModelsCache(accessToken, region, profileArn).catch((error) => {
          console.warn(
            `[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`,
          );
        });
      }

      const kiroModelId = resolveKiroModel(model.id, modelMetadata.kiroModelId);
      const effortConfig = getKiroEffortConfig(modelMetadata.additionalModelRequestFieldsSchema, kiroModelId);
      const additionalModelRequestFields = buildKiroAdditionalModelRequestFields(
        modelMetadata,
        kiroModelId,
        options?.reasoning,
      );
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      debugLog("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });
      let systemPrompt = context.systemPrompt ?? "";
      // Kiro's runtime endpoint honors structured effort but only exposes Claude's
      // user-visible thinking stream when the legacy thinking markers are also
      // present. Keep both controls: structured fields select effort, while these
      // markers preserve the <thinking> content consumed by ThinkingTagParser.
      if (thinkingEnabled && effortConfig?.field !== "reasoning") {
        const budget =
          options?.reasoning === "xhigh"
            ? 50000
            : options?.reasoning === "high"
              ? 30000
              : options?.reasoning === "medium"
                ? 20000
                : 10000;
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${systemPrompt ? `\n${systemPrompt}` : ""}`;
      }
      let retryCount = 0;
      const maxRetries = 3;
      const conversationId = options?.sessionId ?? crypto.randomUUID();
      while (retryCount <= maxRetries) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const effectiveSystemPrompt = systemPrompt;
        const normalized = normalizeMessages(context.messages);
        const {
          history: rawHistory,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, effectiveSystemPrompt);
        // Preserve semantic context locally; Pi owns lossy compaction.
        const history = prepareHistory(rawHistory);
        const dynamicHistoryLimit = Math.floor((model.contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT);
        const toolResultLimit = TOOL_RESULT_LIMIT;
        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;
        if (firstMsg?.role === "assistant") {
          const am = firstMsg as AssistantMessage;
          let armContent = "";
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content))
            for (const b of am.content) {
              if (b.type === "text") armContent += (b as TextContent).text;
              else if (b.type === "thinking")
                armContent = `<thinking>${(b as unknown as { thinking: string }).thinking}</thinking>\n\n${armContent}`;
              else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: tc.id,
                  input:
                    typeof tc.arguments === "string"
                      ? JSON.parse(tc.arguments)
                      : (tc.arguments as Record<string, unknown>),
                });
              }
            }
          if (armContent || armToolUses.length > 0) {
            const lastEntryForArm = history[history.length - 1];
            const prevArm = lastEntryForArm?.assistantResponseMessage;
            if (history.length > 0 && !lastEntryForArm?.userInputMessage && prevArm) {
              // Merge into previous assistant message to maintain alternation without synthetic padding
              prevArm.content += `\n\n${armContent}`;
              if (armToolUses.length > 0) prevArm.toolUses = [...(prevArm.toolUses || []), ...armToolUses];
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                },
              });
            }
          }
          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages.push(c as ImageContent);
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages2: ImageContent[] = [];
          for (const m of currentMessages)
            if (m.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages2.push(c as ImageContent);
            }
          if (toolResultImages2.length > 0) {
            const converted = convertImagesToKiro(toolResultImages2);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (effectiveSystemPrompt && !systemPrepended)
            currentContent = `${effectiveSystemPrompt}\n\n${currentContent}`;
        }
        // Current assistant tool calls are outbound history too, so enforce the
        // budget only after they have been appended.
        assertHistoryWithinLimit(history, dynamicHistoryLimit);
        // Prepend truncation notice if the previous assistant response was cut off
        if (wasPreviousResponseTruncated(context.messages)) {
          currentContent = `${TRUNCATION_NOTICE}\n\n${currentContent}`;
        }
        // Always synthesize placeholder specs for tool names referenced in
        // history, even when context.tools is empty/undefined. Without this,
        // an "advisor-style" call that inherits a tool-rich conversation but
        // declares no current tools is rejected by Kiro as "Improperly formed
        // request" because history references toolUses with no tool catalog.
        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        const baseTools = context.tools?.length ? convertToolsToKiro(context.tools) : [];
        const finalTools = history.length > 0 ? addPlaceholderTools(baseTools, history) : baseTools;
        if (currentToolResults.length > 0 || finalTools.length > 0) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (finalTools.length > 0) uimc.tools = finalTools;
        }
        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs as ImageContent[]);
        }
        // `content` is required: Kiro answers an empty one with a 400
        // "Improperly formed request." Fall back to a neutral prompt so a turn
        // that carries only images (or an empty-text user message) still sends.
        if (currentContent === "") currentContent = EMPTY_CONTENT_PLACEHOLDER;
        // kiro-cli does not enforce alternation — the API accepts
        // non-alternating history. No synthetic padding needed.
        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: sanitizeSurrogates(currentContent),
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                ...(uimc ? { userInputMessageContext: uimc } : {}),
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
          profileArn,
          agentMode: "vibe",
        };
        let response!: Response;
        // Reset per outer iteration — each 403 retry gets a fresh capacity budget
        let capacityRetryCount = 0;
        // Inner loop: retry capacity errors without consuming outer retry budget
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
          debugLog("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
            request,
          });
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/vnd.amazon.eventstream",
              Authorization: `Bearer ${accessToken}`,
              "x-amzn-codewhisperer-optout": "true",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=1",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amz-user-agent": ua,
              "user-agent": ua,
            },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!response.ok) {
            let errText = "";
            try {
              errText = redactSensitiveText(await response.text());
            } catch {
              errText = "";
            }
            const safeStatusText = redactSensitiveText(response.statusText);
            debugLog("response.error", { status: response.status, statusText: safeStatusText, body: errText });
            // Retry transient capacity errors with longer backoff
            if (isCapacityError(errText) && capacityRetryCount < capacityRetryConfig.maxRetries) {
              capacityRetryCount++;
              const delayMs = exponentialBackoff(capacityRetryCount - 1, capacityRetryConfig.baseDelayMs, 30_000);
              const msg = `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${capacityRetryConfig.maxRetries})`;
              console.error(`[pi-provider-kiro] ${msg}`);
              logCapacityEvent(msg);
              await abortableDelay(delayMs, options?.signal);
              continue;
            }
            if (isCapacityError(errText)) {
              logCapacityEvent(
                `INSUFFICIENT_MODEL_CAPACITY — exhausted ${capacityRetryConfig.maxRetries} retries, giving up`,
              );
            }
            if (response.status === 403 && !isCapacityError(errText) && retryCount < maxRetries) {
              retryCount++;
              // Re-read the shared store first in case another process already
              // rotated the token. If it still contains the rejected token,
              // force kiro-cli to refresh before retrying runtime.
              invalidateKiroProfileArn(managementAuth);
              const rejectedAccessToken = accessToken;
              const rejectedProfileArn = profileArn;
              const storedCreds = getKiroCliCredentials();
              const rejectedCliCreds =
                storedCreds?.access === rejectedAccessToken
                  ? storedCreds
                  : cliCreds?.access === rejectedAccessToken
                    ? cliCreds
                    : undefined;
              const freshCreds: ReturnType<typeof getKiroCliCredentials> =
                storedCreds?.access && storedCreds.access !== rejectedAccessToken ? storedCreds : refreshViaKiroCli();
              if (freshCreds?.access) accessToken = freshCreds.access;
              managementAuth = { accessToken, region };

              // Social profiles may not be discoverable through management.
              // Carry the profile used by the rejected request only across a
              // confirmed desktop-to-desktop credential replacement.
              const inheritedDesktopProfileArn =
                rejectedCliCreds?.authMethod === "desktop" && freshCreds?.authMethod === "desktop"
                  ? rejectedProfileArn
                  : undefined;
              profileArn =
                freshCreds?.profileArn ||
                inheritedDesktopProfileArn ||
                (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
              const delayMs = exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY);
              await abortableDelay(delayMs, options?.signal);
              break; // break inner loop, continue outer loop
            }
            // Avoid pi-coding-agent's outer auto-retry from treating known
            // Kiro quota/capacity body markers as generic retryable 429s.
            // This covers both hard quota (MONTHLY_REQUEST_COUNT) and
            // exhausted capacity retries (INSUFFICIENT_MODEL_CAPACITY).
            if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
              throw new Error(`Kiro API error: ${errText || safeStatusText}`);
            }
            // Format error so pi-ai's isContextOverflow() recognizes it
            if (isTooBigError(response.status, errText)) {
              throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
            }
            throw new Error(`Kiro API error: ${response.status} ${safeStatusText} ${errText}`);
          }
          break; // success, break inner loop
        }
        if (capacityRetryCount > 0 && response.ok) {
          logCapacityEvent(`INSUFFICIENT_MODEL_CAPACITY — succeeded after ${capacityRetryCount} retries`);
        }
        // 403 retry: continue outer loop
        if (!response.ok) continue;
        stream.push({ type: "start", partial: output });
        if (!response.body) throw new Error("No response body");
        const bodyReader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
        let totalContent = "";
        let lastContentData = "";
        let usageEvent: KiroUsageData | null = null;
        // `usage` outlives this loop; clear whatever a previous attempt reported
        // so a failed attempt's counts cannot survive into this one.
        resetKiroUsage(usage);
        let receivedContextUsage = false;
        const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
        let nativeThinkingBlockIndex: number | null = null;
        let nativeThinkingEnded = false;
        const ensureNativeThinkingBlock = (): { block: ThinkingContent; contentIndex: number } => {
          if (nativeThinkingBlockIndex === null) {
            nativeThinkingBlockIndex = output.content.length;
            output.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: nativeThinkingBlockIndex, partial: output });
          }
          return {
            block: output.content[nativeThinkingBlockIndex] as ThinkingContent,
            contentIndex: nativeThinkingBlockIndex,
          };
        };
        const endNativeThinking = () => {
          if (nativeThinkingBlockIndex === null || nativeThinkingEnded) return;
          nativeThinkingEnded = true;
          const block = output.content[nativeThinkingBlockIndex] as ThinkingContent;
          stream.push({
            type: "thinking_end",
            contentIndex: nativeThinkingBlockIndex,
            content: block.thinking,
            partial: output,
          });
        };
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        let currentToolCall: KiroToolCallState | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          currentToolCall = null;
        };
        const IDLE_TIMEOUT = 300_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void bodyReader.cancel().catch(() => {});
          }, IDLE_TIMEOUT);
        };
        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");

        // Smithy EventStreamMarshaller handles: chunk reassembly, CRC validation,
        // protocol error/exception detection, and payload deserialization.
        const bodyIterable: AsyncIterable<Uint8Array> = {
          async *[Symbol.asyncIterator]() {
            try {
              while (true) {
                const { done, value } = await bodyReader.read();
                if (done) return;
                yield value;
              }
            } finally {
              bodyReader.releaseLock();
            }
          },
        };
        const utf8Decoder = new TextDecoder();
        const eventStream = eventStreamMarshaller.deserialize(bodyIterable, async (event: Record<string, Message>) => {
          const entry = Object.entries(event)[0];
          if (!entry) throw new Error("Received an empty event stream message");
          const [key, msg] = entry;
          const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>;
          return { [key]: parsed } as Record<string, unknown>;
        });
        const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;

        while (true) {
          let iterResult: IteratorResult<Record<string, unknown>>;
          try {
            if (!gotFirstToken) {
              const readPromise = iterator.next();
              const result = await Promise.race([
                readPromise,
                new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
                  setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), firstTokenTimeoutForModel(model.id)),
                ),
              ]);
              if (result === FIRST_TOKEN_SENTINEL) {
                readPromise.catch(() => {}); // suppress dangling rejection
                void bodyReader.cancel().catch(() => {});
                firstTokenTimedOut = true;
                break;
              }
              iterResult = result as IteratorResult<Record<string, unknown>>;
              gotFirstToken = true;
              resetIdle();
            } else {
              iterResult = await iterator.next();
            }
          } catch (e) {
            // Smithy throws on :message-type error/exception headers
            streamError =
              e instanceof Error
                ? e.message
                : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)) || "Unknown stream error";
            break;
          }
          const { done, value } = iterResult;
          if (done) break;
          resetIdle();
          // The marshaller keys each frame by its modeled `ChatResponseStream`
          // union member (from the `:event-type` header). Route on that key
          // instead of guessing the member from which fields are populated.
          const frameEntry = Object.entries(value as Record<string, unknown>)[0];
          if (!frameEntry) continue;
          const [frameKey, framePayload] = frameEntry;
          const event = parseKiroEvent(frameKey, (framePayload ?? {}) as Record<string, unknown>);
          if (!event) continue;
          if (event.type === "ignored") {
            if (debugEnabled()) debugLog("stream.events.ignored", [event.data.key]);
            continue;
          }
          if (debugEnabled()) debugLog("stream.events", [event]);
          switch (event.type) {
            case "contextUsage": {
              // Provisional only: this arrives long before metadataEvent, so it
              // keeps live context% moving mid-turn. The input count it derives
              // is superseded by the measured one in finalizeKiroUsage().
              applyContextUsage(usage, event.data.contextUsagePercentage, model.contextWindow);
              receivedContextUsage = true;
              break;
            }
            case "thinkingText": {
              if (!thinkingEnabled) break;
              const { block, contentIndex } = ensureNativeThinkingBlock();
              block.thinking += event.data;
              totalContent += event.data;
              stream.push({
                type: "thinking_delta",
                contentIndex,
                delta: event.data,
                partial: output,
              });
              break;
            }
            case "thinkingSignature": {
              if (!thinkingEnabled) break;
              const { block } = ensureNativeThinkingBlock();
              block.thinkingSignature = event.data;
              endNativeThinking();
              break;
            }
            case "content": {
              endNativeThinking();
              if (event.data === lastContentData) continue;
              lastContentData = event.data;
              totalContent += event.data;
              if (thinkingParser) {
                thinkingParser.processChunk(event.data);
              } else {
                if (textBlockIndex === null) {
                  textBlockIndex = output.content.length;
                  output.content.push({ type: "text", text: "" });
                  stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                }
                (output.content[textBlockIndex] as TextContent).text += event.data;
                stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: event.data, partial: output });
              }
              break;
            }
            case "toolUse": {
              const tc = event.data;
              sawAnyToolCalls = true;
              if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                flushToolCall();
                currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
              }
              currentToolCall.input += tc.input || "";
              if (tc.input) totalContent += tc.input;
              if (tc.stop) flushToolCall();
              break;
            }
            case "toolUseInput": {
              if (currentToolCall) currentToolCall.input += event.data.input || "";
              if (event.data.input) totalContent += event.data.input;
              break;
            }
            case "toolUseStop": {
              if (event.data.stop) flushToolCall();
              break;
            }
            case "usage": {
              // Every MetadataEvent field is optional, so the service may split
              // tokenUsage and stopReason/stopDetails across frames. Merge so a
              // later partial frame cannot erase counts already received.
              const prev: KiroUsageData = usageEvent ?? {};
              usageEvent = { ...prev, ...event.data };
              break;
            }
            case "metering": {
              // MeteringEvent.usage counts credits, not tokens. Recorded as its
              // own field so the actual billing unit is observable; never folded
              // into token accounting or into Usage.cost. Both grammatical forms
              // are passed through so the count picks the right one.
              applyMeteringCredits(usage, event.data.credits, event.data.unit, event.data.unitPlural);
              if (debugEnabled()) debugLog("stream.metering", [event.data]);
              break;
            }
            case "error": {
              const errMsg = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
              streamError = errMsg;
              void bodyReader.cancel().catch(() => {});
              break;
            }
            // followupPrompt events are intentionally ignored
          }
          if (streamError) break;
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (firstTokenTimedOut || idleCancelled || streamError) {
          // Timed out or received error mid-stream: retry with backoff
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            // `output` is created once outside the retry loop, so anything the
            // aborted attempt already appended survives into the next one. A
            // typed error frame (throttling/validation/serviceUnavailable) can
            // arrive after partial text, which would otherwise concatenate the
            // abandoned prefix onto the retried response. The empty-response
            // retry below resets for the same reason. `textBlockIndex` and the
            // tool-call state are per-iteration and need no reset here.
            output.content = [];
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (streamError) {
            throw new Error(`Kiro API stream error after max retries: ${streamError}`);
          }
          throw new Error(`Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`);
        }
        if (currentToolCall && emitToolCall(currentToolCall, output, stream)) {
          emittedToolCalls++;
        }
        endNativeThinking();
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }
        // Fallback: extract bracket-style tool calls from content if no native tool calls
        if (!sawAnyToolCalls && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          const bracketResult = parseBracketToolCalls(textBlock.text);
          if (bracketResult.toolCalls.length > 0) {
            sawAnyToolCalls = true;
            textBlock.text = bracketResult.cleanedText;
            for (const btc of bracketResult.toolCalls) {
              if (
                emitToolCall(
                  {
                    toolUseId: btc.toolUseId,
                    name: btc.name,
                    input: JSON.stringify(btc.arguments),
                  },
                  output,
                  stream,
                )
              ) {
                emittedToolCalls++;
              }
            }
          }
        }
        // Strip echo noise: when tool calls are present and the text content
        // is just "." or similar short echo from history padding, remove it.
        // This prevents the echo from accumulating in conversation history
        // and reinforcing the pattern in future turns.
        if (emittedToolCalls > 0 && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          if (/^\s*(\.+|continue)\s*$/i.test(textBlock.text)) {
            textBlock.text = "";
          }
        }
        if (textBlockIndex !== null)
          stream.push({
            type: "text_end",
            contentIndex: textBlockIndex,
            content: (output.content[textBlockIndex] as TextContent).text,
            partial: output,
          });
        // Fold in whatever `metadataEvent.tokenUsage` reported.
        //
        // `KiroUsageData.inputTokens` is `TokenUsage.uncachedInputTokens` — the
        // input billed at full rate, NOT total input. pi's `usage.input` is the
        // same uncached slot, with `cacheRead`/`cacheWrite` as siblings, and
        // `calculateCost` prices all three separately, so the cache counts must
        // land whenever `input` comes from the wire; otherwise a cached turn
        // reports a fraction of its real input and is priced far too low.
        //
        // `TokenUsage.totalTokens` is required on the wire while the cache counts
        // are optional, so the service's own total is authoritative — recomputing
        // from components under-reports whenever one is omitted.
        //
        // finalizeKiroUsage() owns all of that, plus the measured > derived >
        // estimated precedence and the slot normalization that keeps
        // input/cacheRead/cacheWrite disjoint. The tiktoken estimate over
        // everything the assistant emitted (text plus tool-call input JSON,
        // accumulated into `totalContent`) fills only the figures the wire
        // omitted: Kiro does not reliably send `outputTokens`, and a
        // tool-call-only turn reporting 0 output breaks consumers that watch
        // `usage.output`, such as the TPS extension.
        finalizeKiroUsage(usage, usageEvent, () => countTokens(totalContent));
        try {
          PiAi.calculateCost(model, output.usage);
        } catch {
          // Model might not have cost info, use zeros
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        // Detect degenerate responses: the API returned 200 but produced no
        // usable content at all — no text and no tool calls (not even broken
        // ones). This happens when the stream is truncated early or the API
        // returns only a contextUsage event. Retry with backoff.
        //
        // Also detect "Continue" echo loops: the model's entire response is
        // just "continue" (case-insensitive) with no tool calls. This happens
        // when synthetic history padding teaches the model to echo "Continue"
        // as a valid response, causing an infinite loop where pi sends
        // "continue" back and the model echoes it again.
        //
        // When tool calls *were* present but all got dropped (empty/unparseable
        // input), don't retry — the API did respond, it just sent malformed
        // tool calls. Retrying would likely produce the same result. The
        // stopReason fix below prevents the agent loop stall.
        const hasText = textBlockIndex !== null && (output.content[textBlockIndex] as TextContent).text.length > 0;
        const responseText = hasText ? (output.content[textBlockIndex as number] as TextContent).text : "";
        const isEchoLoop = hasText && !sawAnyToolCalls && /^\s*(continue|\.+)\s*$/i.test(responseText);
        if ((!hasText && !sawAnyToolCalls) || isEchoLoop) {
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            console.warn(
              `[pi-provider-kiro] ${isEchoLoop ? 'Echo loop detected (model responded with just "Continue")' : "Empty response (no text, no tool calls)"} — retrying (${retryCount}/${maxRetries})`,
            );
            // Reset output content for the retry
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (isEchoLoop) {
            // After max retries, strip the echo text to prevent the agent
            // loop from interpreting "Continue" as a continuation signal.
            (output.content[textBlockIndex as number] as TextContent).text = "";
            console.warn(
              `[pi-provider-kiro] Echo loop persisted after ${maxRetries} retries — stripping "Continue" response`,
            );
          } else {
            console.warn(
              `[pi-provider-kiro] Empty response after ${maxRetries} retries — returning stopReason:"stop" to avoid agent loop stall`,
            );
          }
        }
        // Use emittedToolCalls (not toolCalls.length) to avoid stopReason:"toolUse"
        // when all tool calls were skipped due to empty/unparseable input — that
        // combination (empty content + toolUse stop) causes pi's agent loop to
        // stall waiting for tool results that will never arrive.
        if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }
        // Record where this turn's numbers came from. `usage.provenance` and the
        // modeled stop reason are both invisible in the emitted message: the
        // usage numbers are a flat bag with no room to say whether a figure was
        // measured or invented, and `MetadataEvent.stopReason` has no slot in
        // pi's `stopReason` vocabulary at this peer. diagnostics[] is the only
        // structured channel out of here — streamKiro never rejects, it encodes
        // outcomes into the stream.
        //
        // `stopReasonSource` is `inferred` because the branch above still
        // reconstructs the emitted value from tool calls and contextUsage
        // arrival. It becomes `modeled` when that branch consumes
        // `rawStopReason`, which is a separate change.
        try {
          PiAi.appendAssistantMessageDiagnostic(
            output,
            createKiroTurnProvenanceDiagnostic({
              usage: usage.provenance,
              stopReason: output.stopReason,
              stopReasonSource: "inferred",
              rawStopReason: usageEvent?.rawStopReason,
              stopDetails: usageEvent?.stopDetails,
            }),
          );
        } catch (e) {
          // Observational only. A malformed record must never cost the caller a
          // turn that otherwise completed.
          debugLog("diagnostics.failed", { error: formatSafeError(e) });
        }
        stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
        debugLog("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          textLen: textBlockIndex !== null ? (output.content[textBlockIndex] as TextContent).text.length : 0,
          usage: output.usage,
          content: output.content,
        });
        stream.end();
        break;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatSafeError(error);
      debugLog("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    // Safety net: catch any rejection that escapes the inner try/catch
    // (e.g., AbortError during signal teardown). Without this, the
    // fire-and-forget IIFE produces an unhandled rejection that crashes pi.
    try {
      stream.end();
    } catch {}
  });
  return stream;
}
