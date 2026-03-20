// Feature 5: Message Transformation

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "AI_EDITOR";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const am = msg as AssistantMessage;
    return am.stopReason !== "error" && am.stopReason !== "aborted";
  });
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters as Record<string, unknown> },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;
  const toolResultLimit = TOOL_RESULT_LIMIT;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx].role === "toolResult") currentMsgStartIdx--;
  if (currentMsgStartIdx >= 0 && messages[currentMsgStartIdx].role === "assistant") {
    const am = messages[currentMsgStartIdx] as AssistantMessage;
    if (!Array.isArray(am.content) || !am.content.some((b) => b.type === "toolCall")) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId,
        origin: "AI_EDITOR",
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };
      if (history[history.length - 1]?.userInputMessage)
        history.push({ assistantResponseMessage: { content: "Continue" } });
      history.push({ userInputMessage: uim });
    } else if (msg.role === "assistant") {
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") armContent += (block as TextContent).text;
          else if (block.type === "thinking")
            armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
          else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: tc.id,
              input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: { content: armContent, ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}) },
      });
    } else if (msg.role === "toolResult") {
      const trMsg = msg as ToolResultMessage;
      const toolResults: KiroToolResult[] = [
        {
          content: [{ text: truncate(getContentText(msg), toolResultLimit) }],
          status: trMsg.isError ? "error" : "success",
          toolUseId: trMsg.toolCallId,
        },
      ];
      const trImages: ImageContent[] = [];
      if (Array.isArray(trMsg.content))
        for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
      let j = i + 1;
      while (j < historyMessages.length && historyMessages[j].role === "toolResult") {
        const next = historyMessages[j] as ToolResultMessage;
        toolResults.push({
          content: [{ text: truncate(getContentText(next), toolResultLimit) }],
          status: next.isError ? "error" : "success",
          toolUseId: next.toolCallId,
        });
        if (Array.isArray(next.content))
          for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
        j++;
      }
      i = j - 1;
      if (history[history.length - 1]?.userInputMessage)
        history.push({ assistantResponseMessage: { content: "Continue" } });
      history.push({
        userInputMessage: {
          content: "Tool results provided.",
          modelId,
          origin: "AI_EDITOR",
          ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
          userInputMessageContext: { toolResults },
        },
      });
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
