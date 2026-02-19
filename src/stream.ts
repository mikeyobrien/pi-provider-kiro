// Feature 9: Streaming Integration

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
import { parseKiroEvents } from "./event-parser.js";
import { addPlaceholderTools, HISTORY_LIMIT, truncateHistory } from "./history.js";
import { resolveKiroModel } from "./models.js";
import { ThinkingTagParser } from "./thinking-parser.js";
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

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
}
interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
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
      const accessToken = options?.apiKey;
      if (!accessToken) throw new Error("Kiro credentials not set. Run /login kiro or install kiro-cli.");
      const region = "us-east-1";
      const endpoint = `https://q.${region}.amazonaws.com/generateAssistantResponse`;
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
      let reductionFactor = 1.0;
      while (retryCount <= maxRetries) {
        let effectiveSystemPrompt = systemPrompt;
        if (reductionFactor < 1.0) {
          // Truncate system prompt on retry to reduce request size
          const maxSystemLength = Math.floor(5000 * reductionFactor);
          if (effectiveSystemPrompt.length > maxSystemLength) {
            effectiveSystemPrompt = `${effectiveSystemPrompt.substring(0, maxSystemLength)}\n[System prompt truncated due to length]`;
          }
        }
        const normalized = normalizeMessages(context.messages);
        const {
          history: rawHistory,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, effectiveSystemPrompt, reductionFactor);
        const history = truncateHistory(rawHistory, Math.floor(HISTORY_LIMIT * reductionFactor));
        const toolResultLimit = Math.floor(TOOL_RESULT_LIMIT * reductionFactor);
        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
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
              history.push({ userInputMessage: { content: "Continue", modelId: kiroModelId, origin: "AI_EDITOR" } });
            history.push({
              assistantResponseMessage: {
                content: armContent,
                ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
              },
            });
          }
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m.role === "toolResult")
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: (m as ToolResultMessage).isError ? "error" : "success",
                toolUseId: (m as ToolResultMessage).toolCallId,
              });
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Continue";
        } else if (firstMsg?.role === "toolResult") {
          for (const m of currentMessages)
            if (m.role === "toolResult")
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: (m as ToolResultMessage).isError ? "error" : "success",
                toolUseId: (m as ToolResultMessage).toolCallId,
              });
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (effectiveSystemPrompt && !systemPrepended)
            currentContent = `${effectiveSystemPrompt}\n\n${currentContent}`;
        }
        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        if (currentToolResults.length > 0 || (context.tools && context.tools.length > 0)) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (context.tools?.length) {
            let kt = convertToolsToKiro(context.tools);
            if (history.length > 0) kt = addPlaceholderTools(kt, history);
            // Limit tools on retry to reduce request size
            if (reductionFactor < 1.0) {
              const maxTools = Math.max(3, Math.floor(kt.length * reductionFactor));
              kt = kt.slice(0, maxTools);
            }
            uimc.tools = kt;
          }
        }
        let currentImages: KiroImage[] | undefined;
        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs as ImageContent[]);
        }
        if (history.length > 0 && history[history.length - 1].userInputMessage)
          history.push({ assistantResponseMessage: { content: "Continue" } });
        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            conversationId: crypto.randomUUID(),
            currentMessage: {
              userInputMessage: {
                content: sanitizeSurrogates(currentContent),
                modelId: kiroModelId,
                origin: "AI_EDITOR",
                ...(currentImages ? { images: currentImages } : {}),
                ...(uimc ? { userInputMessageContext: uimc } : {}),
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
        };
        const mid = crypto.randomUUID().replace(/-/g, "");
        const ua = `aws-sdk-js/1.0.0 ua/2.1 os/nodejs lang/js api/codewhispererruntime#1.0.0 m/E KiroIDE-${mid}`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "amz-sdk-invocation-id": crypto.randomUUID(),
            "amz-sdk-request": "attempt=1; max=1",
            "x-amzn-kiro-agent-mode": "vibe",
            "x-amz-user-agent": ua,
            "user-agent": ua,
            Connection: "close",
          },
          body: JSON.stringify(request),
          signal: options?.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          const isTooBig =
            errText.includes("CONTENT_LENGTH_EXCEEDS_THRESHOLD") ||
            errText.includes("Input is too long") ||
            errText.includes("Improperly formed");
          if ((response.status === 413 || (response.status === 400 && isTooBig)) && retryCount < maxRetries) {
            retryCount++;
            reductionFactor *= 0.7;
            continue;
          }
          throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
        }
        stream.push({ type: "start", partial: output });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
        let textBlockIndex: number | null = null;
        const toolCalls: KiroToolCallState[] = [];
        let currentToolCall: KiroToolCallState | null = null;
        const IDLE_TIMEOUT = 30_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            try {
              reader.cancel();
            } catch {}
          }, IDLE_TIMEOUT);
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();
          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          let streamComplete = false;
          for (const event of events) {
            if (event.type === "contextUsage") {
              const pct = event.data.contextUsagePercentage;
              output.usage.input = Math.round((pct / 100) * model.contextWindow);
              streamComplete = true;
            } else if (event.type === "content") {
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
              if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId)
                currentToolCall.input += tc.input || "";
              else {
                if (currentToolCall) toolCalls.push(currentToolCall);
                currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: tc.input || "" };
              }
              if (tc.stop && currentToolCall) {
                toolCalls.push(currentToolCall);
                currentToolCall = null;
              }
            } else if (event.type === "toolUseInput") {
              if (currentToolCall) currentToolCall.input += event.data.input || "";
            } else if (event.type === "toolUseStop") {
              if (currentToolCall && event.data.stop) {
                toolCalls.push(currentToolCall);
                currentToolCall = null;
              }
            }
          }
          if (streamComplete) break;
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (currentToolCall) toolCalls.push(currentToolCall);
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }
        if (textBlockIndex !== null)
          stream.push({
            type: "text_end",
            contentIndex: textBlockIndex,
            content: (output.content[textBlockIndex] as TextContent).text,
            partial: output,
          });
        for (const tc of toolCalls) {
          const idx = output.content.length;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.input);
          } catch {}
          const toolCall: ToolCall = { type: "toolCall", id: tc.toolUseId, name: tc.name, arguments: args };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: tc.input, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
        }
        const outTok = Math.ceil(totalContent.length / 4);
        output.usage.output = outTok;
        output.usage.totalTokens = output.usage.input + outTok;
        try {
          calculateCost(model, output.usage);
        } catch {
          // Model might not have cost info, use zeros
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        output.stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
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
