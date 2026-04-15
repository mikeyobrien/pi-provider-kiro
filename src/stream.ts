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
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { parseKiroEvents } from "./event-parser.js";
import { addPlaceholderTools, HISTORY_LIMIT, HISTORY_LIMIT_CONTEXT_WINDOW, truncateHistory } from "./history.js";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { resolveKiroModel } from "./models.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  MAX_RETRY_DELAY,
  retryConfig,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { countTokens } from "./tokenizer.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
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
  profileArn?: string;
  agentMode?: string;
}
interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

// --- profileArn resolution (cached per endpoint) ---
const profileArnCache = new Map<string, string>();
const profileArnPending = new Set<string>();

/** Reset profileArn cache — exported for tests. */
export function resetProfileArnCache(resolved = false): void {
  profileArnCache.clear();
  profileArnPending.clear();
  if (resolved) profileArnPending.add("__all__");
}

async function resolveProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  if (profileArnPending.has("__all__")) return undefined;
  if (profileArnCache.has(endpoint)) return profileArnCache.get(endpoint);
  if (profileArnPending.has(endpoint)) return undefined;
  try {
    const ep = new URL(endpoint);
    ep.pathname = ep.pathname.replace(/\/generateAssistantResponse\/?$/, "/");
    ep.search = "";
    ep.hash = "";

    const r = await fetch(ep.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      },
      body: "{}",
    });
    if (!r.ok) {
      console.warn(
        `[pi-provider-kiro] Failed to resolve profileArn: ListAvailableProfiles returned ${r.status} ${r.statusText}. Will retry on the next request.`,
      );
      return undefined;
    }
    const j = (await r.json()) as { profiles?: Array<{ arn?: string }> };
    const arn = j.profiles?.find((p) => p.arn)?.arn;
    if (!arn) {
      console.warn(
        "[pi-provider-kiro] Failed to resolve profileArn: ListAvailableProfiles returned no profile ARN. Will retry on the next request.",
      );
      return undefined;
    }
    profileArnCache.set(endpoint, arn);
    return arn;
  } catch (error) {
    console.warn(
      `[pi-provider-kiro] Failed to resolve profileArn: ${error instanceof Error ? error.message : String(error)}. Will retry on the next request.`,
    );
    return undefined;
  }
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
      `[pi-provider-kiro] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${e instanceof Error ? e.message : String(e)}. Raw input (${state.input.length} chars): ${state.input.substring(0, 200)}`,
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
  const stream = createAssistantMessageEventStream();
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
      let accessToken = options?.apiKey;
      if (!accessToken) throw new Error("Kiro credentials not set. Run /login kiro or install kiro-cli.");
      const endpoint = model.baseUrl || "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

      let profileArn = await resolveProfileArn(accessToken, endpoint);
      const kiroModelId = resolveKiroModel(model.id);
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      let systemPrompt = context.systemPrompt ?? "";
      if (thinkingEnabled) {
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
        // Scale history limit to model context window
        // HISTORY_LIMIT (850K chars) is sized for 200K token models
        const dynamicHistoryLimit = Math.floor((model.contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT);
        const history = truncateHistory(rawHistory, dynamicHistoryLimit);
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
            if (history.length > 0 && !history[history.length - 1].userInputMessage)
              history.push({ userInputMessage: { content: "Continue", modelId: kiroModelId, origin: "KIRO_CLI" } });
            history.push({
              assistantResponseMessage: {
                content: armContent,
                ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
              },
            });
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
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Continue";
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
        // Prepend truncation notice if the previous assistant response was cut off
        if (wasPreviousResponseTruncated(context.messages)) {
          currentContent = `${TRUNCATION_NOTICE}\n\n${currentContent}`;
        }
        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        if (currentToolResults.length > 0 || (context.tools && context.tools.length > 0)) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (context.tools?.length) {
            let kt = convertToolsToKiro(context.tools);
            if (history.length > 0) kt = addPlaceholderTools(kt, history);
            uimc.tools = kt;
          }
        }
        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs as ImageContent[]);
        }
        if (history.length > 0 && history[history.length - 1].userInputMessage)
          history.push({ assistantResponseMessage: { content: "Continue" } });
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
          ...(profileArn ? { profileArn } : {}),
          agentMode: "vibe",
        };
        let response!: Response;
        // Reset per outer iteration — each 403 retry gets a fresh capacity budget
        let capacityRetryCount = 0;
        // Inner loop: retry capacity errors without consuming outer retry budget
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.0",
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
              "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
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
              errText = await response.text();
            } catch {
              errText = "";
            }
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
              // On 403, try to get a fresh token before retrying — the current
              // one may have been rotated by kiro-cli or another session.
              const freshCreds = getKiroCliCredentials();
              if (freshCreds?.access) accessToken = freshCreds.access;

              // Re-resolve profileArn with fresh credentials
              profileArnCache.delete(endpoint);
              profileArn = await resolveProfileArn(accessToken, endpoint);
              const delayMs = exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY);
              await abortableDelay(delayMs, options?.signal);
              break; // break inner loop, continue outer loop
            }
            // Avoid pi-coding-agent's outer auto-retry from treating known
            // Kiro quota/capacity body markers as generic retryable 429s.
            // This covers both hard quota (MONTHLY_REQUEST_COUNT) and
            // exhausted capacity retries (INSUFFICIENT_MODEL_CAPACITY).
            if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
              throw new Error(`Kiro API error: ${errText || response.statusText}`);
            }
            // Format error so pi-ai's isContextOverflow() recognizes it
            if (isTooBigError(response.status, errText)) {
              throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
            }
            throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
          }
          break; // success, break inner loop
        }
        if (capacityRetryCount > 0 && response.ok) {
          logCapacityEvent(`INSUFFICIENT_MODEL_CAPACITY — succeeded after ${capacityRetryCount} retries`);
        }
        // 403 retry: continue outer loop
        if (!response.ok) continue;
        stream.push({ type: "start", partial: output });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let lastContentData = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        let currentToolCall: KiroToolCallState | null = null;
        const IDLE_TIMEOUT = 300_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, IDLE_TIMEOUT);
        };
        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let idleCancelled = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          if (!gotFirstToken) {
            // First-token timeout: race the first read against a deadline.
            // Keep a reference to the read promise so we can suppress its
            // rejection if the timeout wins — otherwise an abort that fires
            // after the race settles leaves a dangling rejected promise.
            const readPromise = reader.read();
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
                setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), retryConfig.firstTokenTimeoutMs),
              ),
            ]);
            if (result === FIRST_TOKEN_SENTINEL) {
              readPromise.catch(() => {}); // suppress dangling rejection
              void reader.cancel().catch(() => {});
              firstTokenTimedOut = true;
              break;
            }
            readResult = result as ReadableStreamReadResult<Uint8Array>;
            gotFirstToken = true;
            resetIdle(); // Start idle timer after first token received
          } else {
            readResult = await reader.read();
          }
          const { done, value } = readResult;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          // Reset idle timer on any bytes received — large tool call inputs
          // span many chunks that parse as zero events (incomplete JSON) but
          // the stream is still actively flowing.
          resetIdle();
          for (const event of events) {
            if (event.type === "contextUsage") {
              const pct = event.data.contextUsagePercentage;
              output.usage.input = Math.round((pct / 100) * model.contextWindow);
              // Pass through the raw percentage so rho-web (and other UIs)
              // can display it directly instead of back-calculating from
              // input tokens / guessed context window — which breaks when
              // the usage event later overwrites usage.input.
              (output.usage as unknown as Record<string, unknown>).contextPercent = pct;
              receivedContextUsage = true;
              // Don't break the reader loop here — tool call input chunks
              // may still be pending in subsequent network packets. The
              // stream will close naturally when the server ends it.
            } else if (event.type === "content") {
              if (event.data === lastContentData) continue;
              lastContentData = event.data;
              totalContent += event.data;
              if (thinkingParser) thinkingParser.processChunk(event.data);
              else {
                if (textBlockIndex === null) {
                  textBlockIndex = output.content.length;
                  output.content.push({ type: "text", text: "" });
                  stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                }
                (output.content[textBlockIndex] as TextContent).text += event.data;
                stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: event.data, partial: output });
              }
            } else if (event.type === "toolUse") {
              const tc = event.data;
              sawAnyToolCalls = true;
              if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                if (currentToolCall && emitToolCall(currentToolCall, output, stream)) {
                  emittedToolCalls++;
                }
                currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
              }
              currentToolCall.input += tc.input || "";
              if (tc.stop && currentToolCall) {
                if (emitToolCall(currentToolCall, output, stream)) {
                  emittedToolCalls++;
                }
                currentToolCall = null;
              }
            } else if (event.type === "toolUseInput") {
              if (currentToolCall) currentToolCall.input += event.data.input || "";
            } else if (event.type === "toolUseStop") {
              if (currentToolCall && event.data.stop) {
                if (emitToolCall(currentToolCall, output, stream)) {
                  emittedToolCalls++;
                }
                currentToolCall = null;
              }
            } else if (event.type === "usage") {
              usageEvent = event.data;
            } else if (event.type === "error") {
              // API sent an error mid-stream (throttling, internal error, etc.)
              const errMsg = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
              streamError = errMsg;
              void reader.cancel().catch(() => {});
              break;
            }
            // followupPrompt events are intentionally ignored
          }
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
        if (textBlockIndex !== null)
          stream.push({
            type: "text_end",
            contentIndex: textBlockIndex,
            content: (output.content[textBlockIndex] as TextContent).text,
            partial: output,
          });
        // Prefer usage event values when available, fall back to tiktoken
        if (usageEvent) {
          if (usageEvent.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
          if (usageEvent.outputTokens !== undefined) output.usage.output = usageEvent.outputTokens;
        } else {
          output.usage.output = countTokens(totalContent);
        }
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          calculateCost(model, output.usage);
        } catch {
          // Model might not have cost info, use zeros
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        // Detect degenerate responses: the API returned 200 but produced no
        // usable content at all — no text and no tool calls (not even broken
        // ones). This happens when the stream is truncated early or the API
        // returns only a contextUsage event. Retry with backoff.
        //
        // When tool calls *were* present but all got dropped (empty/unparseable
        // input), don't retry — the API did respond, it just sent malformed
        // tool calls. Retrying would likely produce the same result. The
        // stopReason fix below prevents the agent loop stall.
        const hasText = textBlockIndex !== null && (output.content[textBlockIndex] as TextContent).text.length > 0;
        if (!hasText && !sawAnyToolCalls) {
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            console.warn(
              `[pi-provider-kiro] Empty response (no text, no tool calls) — retrying (${retryCount}/${maxRetries})`,
            );
            // Reset output content for the retry
            output.content = [];
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          console.warn(
            `[pi-provider-kiro] Empty response after ${maxRetries} retries — returning stopReason:"stop" to avoid agent loop stall`,
          );
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
        stream.end();
        break;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
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
