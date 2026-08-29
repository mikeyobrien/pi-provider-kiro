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
import {
  buildKiroAdditionalModelRequestFields,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
} from "./effort.js";
import { getKiroEndpoints, getKiroRegionFromEndpoint } from "./endpoints.js";
import { parseKiroEvent } from "./event-parser.js";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  prepareHistory,
} from "./history.js";
import { isKiroToolStructureRule, kiroConversationEntries, repairKiroConversation } from "./history-validator.js";
import { parseInvokeToolCalls } from "./invoke-tool-parser.js";
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, refreshViaKiroCli } from "./kiro-cli.js";
import {
  invalidateKiroProfileArn,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "./management.js";
import { resolveKiroModel } from "./models.js";
import { kiroAuthHeaders } from "./oauth.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  extractKiroReason,
  firstTokenTimeoutForModel,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  MAX_RETRY_DELAY,
  resolveRequestRateRetryDelay,
  retryConfig,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { kiroTokenTypeHeaders } from "./token-type.js";
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
  relocateDisplacedToolResults,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  toKiroToolUseId,
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
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createResponseHeaderDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const onCallerAbort = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    controller.abort(callerSignal?.reason);
  };
  timer = setTimeout(() => {
    timedOut = true;
    callerSignal?.removeEventListener("abort", onCallerAbort);
    controller.abort(new DOMException("Kiro response headers timeout", "TimeoutError"));
  }, timeoutMs);

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
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
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
      requestLoop: while (retryCount <= maxRetries) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const effectiveSystemPrompt = systemPrompt;
        // Relocate a tool result that arrived behind a later assistant turn than
        // the one that called it, before anything positional runs. Interleaved
        // concurrent tool executions produce that shape, and `sanitizeHistory`
        // pairs POSITIONALLY, so without this pass the displaced result's issuing
        // assistant is dropped and the real tool output is discarded. Pure
        // reorder — see `relocateDisplacedToolResults`.
        const normalized = relocateDisplacedToolResults(normalizeMessages(context.messages));
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
              // Reasoning is deliberately NOT serialized into the assistant text
              // channel, matching `buildHistory` and first-party
              // `extractTextContent`, which type-filters to `text`. Flattening it
              // to `<thinking>...</thinking>` writes literal markup into the
              // string the model reads back as its own prior speech.
              //
              // Unlike the history site, this needs no "turn had blocks" guard:
              // `currentMsgStartIdx` increments past an assistant that declares no
              // `toolCall`, so reaching this branch at all means one exists and
              // `armToolUses` is non-empty. The guard below therefore cannot drop
              // the entry when reasoning is excluded.
              else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: toKiroToolUseId(tc.id),
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
              // Merge into previous assistant message to maintain alternation
              // without synthetic padding. Join only non-empty sides: a turn that
              // carried only reasoning or only a tool call leaves `armContent`
              // empty, and an unconditional separator would append a bare `\n\n`
              // onto text the model actually produced.
              prevArm.content =
                prevArm.content && armContent ? `${prevArm.content}\n\n${armContent}` : prevArm.content || armContent;
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
                toolUseId: toKiroToolUseId(trm.toolCallId),
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages.push(c as ImageContent);
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          // A tool turn carries its payload in `userInputMessageContext.toolResults`,
          // so it needs no text. Leaving this empty also leaves the fallback
          // below free to fill in only genuinely payload-less turns.
          currentContent = "";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages2: ImageContent[] = [];
          for (const m of currentMessages)
            if (m.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: trm.isError ? "error" : "success",
                toolUseId: toKiroToolUseId(trm.toolCallId),
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages2.push(c as ImageContent);
            }
          if (toolResultImages2.length > 0) {
            const converted = convertImagesToKiro(toolResultImages2);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          // Empty by design — `toolResults` is this turn's payload.
          currentContent = "";
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
          currentContent = currentContent === "" ? TRUNCATION_NOTICE : `${TRUNCATION_NOTICE}\n\n${currentContent}`;
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
        // A turn with neither text nor tool results has no payload at all:
        // an image-only user message, an empty-text user message, or a
        // host-appended message whose role falls outside pi-ai's `Message`
        // union. Send a neutral prompt so its attachments still reach the
        // model (#106).
        //
        // The `currentToolResults` guard is load-bearing. Without it this line
        // refills every tool turn that deliberately left `currentContent`
        // empty, and the only change is which sentence is fabricated. Kiro's
        // rule is content **or** tool results — see EMPTY_CONTENT_PLACEHOLDER.
        if (currentContent === "" && currentToolResults.length === 0) currentContent = EMPTY_CONTENT_PLACEHOLDER;
        // kiro-cli does not enforce alternation — the API accepts
        // non-alternating history. No synthetic padding needed.
        //
        // Pre-send REPAIR against the seven rules first-party Kiro Agent
        // enforces. `prepareHistory` covers the shapes this provider itself
        // produces, but not every shape a caller can hand us: `sanitizeHistory`
        // tests tool pairing by POSITION, so an assistant entry with `toolUses`
        // survives whenever the next entry carries any `toolResults` at all,
        // matching ids or not, and `injectSyntheticToolCalls` only rescues
        // orphaned RESULTS. A mismatched pair — both partners present, paired
        // with each other's counterpart — passes both passes untouched and is
        // rejected on the wire with `400 TOOL_USE_RESULT_MISMATCH`.
        //
        // Observed 2026-08-14: a caller whose transcript interleaved two
        // concurrent tool executions sent exactly that shape, and because the
        // retry resends identical history the session was terminally wedged.
        //
        // Repair runs on the WHOLE conversation and is split back afterwards.
        // Repairing `history` alone would be wrong in the ordinary case: its
        // last entry is normally the assistant whose `toolUses` this very
        // request answers, so rule 4 would synthesize a FAILED result for a call
        // whose real output is sitting in the current message.
        //
        // Still never throws. `remaining` is what repair could not express, and
        // that — not merely "input was invalid" — is what earns the warning.
        const conversationEntries = kiroConversationEntries(history, {
          content: currentContent,
          modelId: kiroModelId,
          origin: "KIRO_CLI",
          ...(uimc ? { userInputMessageContext: uimc } : {}),
        });
        const repair = repairKiroConversation(conversationEntries);
        if (repair.diagnostics.length > 0) {
          debugLog("request.invariants", { errors: repair.diagnostics, remaining: repair.remaining });
        }
        // Split back. Repair moves entries in only three ways, and each one keeps
        // the current message last:
        //   - step 1 drops a prefix, never a suffix;
        //   - step 4 inserts a synthetic user turn only AFTER an assistant whose
        //     uses nothing answers, and the current message is a user entry, so
        //     no assistant is ever last;
        //   - steps 2/3/5 rewrite entries in place.
        // The one exception is total collapse: a conversation that is *only* a
        // bare tool-result carrier has no valid opening entry, so step 1 consumes
        // it and returns nothing. Because step 1 cannot skip past a survivor,
        // `entries.length === 0` is the only shape where the current message is
        // gone — anything longer keeps it at the end.
        const repairedCurrent = repair.entries[repair.entries.length - 1]?.userInputMessage;
        // `currentImages` is carried separately below and is not part of the
        // repaired projection, so only text + context are read back here.
        //
        // Read the repaired context EXACTLY, including when repair removed it.
        // A `?? uimc` fallback here would undo the repair in the one case that
        // matters most: stripping every orphaned tool result leaves a turn with
        // no context at all, and falling back would put the orphans — the shape
        // the backend rejects — straight back onto the wire.
        let wireHistory: KiroHistoryEntry[];
        let wireContent: string;
        let wireUimc: typeof uimc;
        if (repairedCurrent) {
          wireHistory = repair.entries.slice(0, -1);
          wireContent = repairedCurrent.content;
          wireUimc = repairedCurrent.userInputMessageContext;
        } else {
          // Collapsed. Apply what repair would have applied to a lone carrier:
          // drop the results that answer nothing (steps 3), keep any tool
          // catalog, and give the empty turn the neutral prompt (step 5).
          wireHistory = [];
          wireContent = currentContent || EMPTY_CONTENT_PLACEHOLDER;
          wireUimc = uimc?.tools?.length ? { tools: uimc.tools } : undefined;
        }
        if (repair.remaining.length > 0) {
          const structural = repair.remaining.filter((e) => isKiroToolStructureRule(e.rule));
          if (structural.length > 0) {
            console.warn(
              `[pi-provider-kiro] outbound history still violates ${structural
                .map((e) => `${e.rule}@${e.index}`)
                .join(", ")} after repair — Kiro may reject this request`,
            );
          }
        }
        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: sanitizeSurrogates(wireContent),
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                ...(wireUimc ? { userInputMessageContext: wireUimc } : {}),
              },
            },
            ...(wireHistory.length > 0 ? { history: wireHistory } : {}),
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
            // Wire values, not pre-repair ones: this line is what a reader
            // correlates against a 400, so it must describe the bytes actually
            // sent. `toolResultCount` likewise counts the repaired carrier,
            // which may include synthesized results the raw turn never had.
            historyLen: wireHistory.length,
            currentContentLen: wireContent.length,
            hasImages: !!currentImages,
            toolResultCount: wireUimc?.toolResults?.length ?? 0,
            request,
          });
          const responseHeaderDeadline = createResponseHeaderDeadline(
            options?.signal,
            retryConfig.requestHeaderTimeoutMs,
          );
          let responseHeadersTimedOut = false;
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/vnd.amazon.eventstream",
                ...kiroAuthHeaders(accessToken),
                ...kiroTokenTypeHeaders(accessToken),
                "x-amzn-codewhisperer-optout": "true",
                "amz-sdk-invocation-id": crypto.randomUUID(),
                "amz-sdk-request": "attempt=1; max=1",
                "x-amzn-kiro-agent-mode": "vibe",
                "x-amz-user-agent": ua,
                "user-agent": ua,
              },
              body: JSON.stringify(request),
              signal: responseHeaderDeadline.signal,
            });
          } catch (error) {
            if (!responseHeaderDeadline.didTimeout() || options?.signal?.aborted) throw error;
            responseHeadersTimedOut = true;
          } finally {
            responseHeaderDeadline.cleanup();
          }
          if (responseHeadersTimedOut) {
            if (retryCount >= maxRetries) {
              throw new Error("Kiro API error: response headers timeout after max retries");
            }
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            await abortableDelay(delayMs, options?.signal);
            continue requestLoop;
          }
          if (!response.ok) {
            let errText = "";
            try {
              errText = redactSensitiveText(await response.text());
            } catch {
              errText = "";
            }
            const safeStatusText = redactSensitiveText(response.statusText);
            const reasonCode = extractKiroReason(errText);
            const isRequestRateExceeded =
              response.status === 429 &&
              reasonCode === KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED &&
              !isNonRetryableBodyError(errText) &&
              !isCapacityError(errText);
            debugLog("response.error", {
              status: response.status,
              statusText: safeStatusText,
              ...(isRequestRateExceeded ? { reasonCode } : { body: errText }),
            });
            // Retry transient capacity errors with longer backoff
            if (isCapacityError(errText) && capacityRetryCount < capacityRetryConfig.maxRetries) {
              capacityRetryCount++;
              const delayMs = exponentialBackoff(capacityRetryCount - 1, capacityRetryConfig.baseDelayMs, 30_000);
              const msg = `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${capacityRetryConfig.maxRetries})`;
              logCapacityEvent(msg);
              await abortableDelay(delayMs, options?.signal);
              continue;
            }
            if (isCapacityError(errText)) {
              logCapacityEvent(
                `INSUFFICIENT_MODEL_CAPACITY — exhausted ${capacityRetryConfig.maxRetries} retries, giving up`,
              );
            }
            if (isRequestRateExceeded) {
              if (retryCount >= maxRetries) {
                throw new Error(
                  `Kiro API error: request window retry budget exhausted (${KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED})`,
                );
              }
              retryCount++;
              const retryDelay = resolveRequestRateRetryDelay(response.headers);
              debugLog("request.rateWindowRetry", {
                attempt: retryCount,
                maxRetries,
                delayMs: retryDelay.delayMs,
                advertisedDelayMs: retryDelay.advertisedDelayMs,
                capped: retryDelay.capped,
                reasonCode,
              });
              await abortableDelay(retryDelay.delayMs, options?.signal);
              continue requestLoop;
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
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
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
          const eventPayload = Object.values(value as Record<string, unknown>)[0] as Record<string, unknown>;
          const event = parseKiroEvent(eventPayload);
          if (!event) continue;
          if (debugEnabled()) debugLog("stream.events", [event]);
          switch (event.type) {
            case "contextUsage": {
              const pct = event.data.contextUsagePercentage;
              output.usage.input = Math.round((pct / 100) * model.contextWindow);
              (output.usage as unknown as Record<string, unknown>).contextPercent = pct;
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
              usageEvent = event.data;
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
        // Fallback: extract text-dialect tool calls from content if no native
        // tool calls arrived. Two dialects are recovered at this seam:
        //   1. Kiro's own `[Called name with args: {...}]` bracket form.
        //   2. Anthropic's `<invoke name="..."><parameter .../></invoke>` XML
        //      form, which opus-class models emit as plain text at high context.
        // Without this, the turn ends `stopReason:"stop"` with zero tool calls —
        // the agent loop sees a finished answer and an unattended session stalls
        // indefinitely with no error recorded anywhere.
        if (!sawAnyToolCalls && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          const recovered: Array<{ toolUseId: string; name: string; arguments: Record<string, unknown> }> = [];
          const bracketResult = parseBracketToolCalls(textBlock.text);
          if (bracketResult.toolCalls.length > 0) {
            textBlock.text = bracketResult.cleanedText;
            recovered.push(...bracketResult.toolCalls);
          }
          const invokeResult = parseInvokeToolCalls(textBlock.text);
          if (invokeResult.toolCalls.length > 0) {
            textBlock.text = invokeResult.cleanedText;
            recovered.push(...invokeResult.toolCalls);
          }
          if (recovered.length > 0) {
            sawAnyToolCalls = true;
            for (const btc of recovered) {
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
        // The Kiro streaming API does not reliably emit per-response output
        // token counts (unlike Anthropic's `output_tokens` or Bedrock's
        // `usage.outputTokens`). When the `usage` event is missing or only
        // reports `inputTokens`, fall back to a tiktoken estimate over
        // everything the assistant emitted — text plus tool-call input JSON
        // (accumulated into `totalContent` above). Otherwise tool-call-only
        // turns report 0 output tokens and break consumers like the TPS
        // extension that watch `usage.output`.
        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
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
