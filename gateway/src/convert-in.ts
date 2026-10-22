// Gateway inbound adapter: Anthropic Messages request -> pi Context.
//
// The gateway wraps the provider's exported streamKiro() unchanged. This file
// is the ONLY place that knows the Anthropic wire shape on the way in.

import type {
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getCachedModels, kiroModels, type KiroModel } from "../../src/models.js";

export interface AnthropicRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
  tool_choice?: { type?: string; name?: string; disable_parallel_tool_use?: boolean };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: { user_id?: string };
  stop_sequences?: string[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
  cache_control?: unknown;
}

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve an Anthropic-facing model id to a Kiro model entry.
 * Search order mirrors pi: the account's dynamic catalog first (what the
 * account can actually use), then the static bootstrap list (so a
 * bootstrap-only id is still attempted and Kiro returns its own error
 * instead of the gateway silently swapping models).
 */
export function resolveGatewayModel(requested: string | undefined): KiroModel {
  const catalog = getCachedModels("us-east-1");
  const byId = new Map<string, KiroModel>();
  for (const m of [...catalog, ...kiroModels]) if (!byId.has(m.id)) byId.set(m.id, m);
  const models = [...byId.values()];
  const raw = (requested ?? "").trim();
  const normalized = raw.replace(/-\d{8}$/, "").replace(/\./g, "-").toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === normalized);
  if (exact) return exact;
  // Claude Code may send provider-prefixed or dated ids; fall back by family.
  const byPrefix = models.find((m) => normalized.startsWith(m.id.toLowerCase()));
  if (byPrefix) return byPrefix;
  const fallback = models.find((m) => m.id === "claude-sonnet-4-6") ?? models[0];
  if (raw) console.warn(`[kiro-gateway] unknown model "${raw}", falling back to ${fallback.id}`);
  return fallback;
}

function budgetToLevel(budget: number): ThinkingLevel {
  if (budget < 2000) return "minimal";
  if (budget < 8000) return "low";
  if (budget < 20000) return "medium";
  if (budget < 40000) return "high";
  return "xhigh";
}

export interface ConvertedRequest {
  context: Context;
  model: KiroModel;
  reasoning?: ThinkingLevel;
  sessionId?: string;
}

export function anthropicToPiContext(body: AnthropicRequest): ConvertedRequest {
  let model = resolveGatewayModel(body.model);

  // Reasoning: explicit effort wins, then thinking budget, then disabled.
  let reasoning: ThinkingLevel | undefined;
  const effort = body.output_config?.effort;
  if (effort && (THINKING_LEVELS as string[]).includes(effort)) {
    reasoning = effort as ThinkingLevel;
  } else if (body.thinking?.type === "enabled" || body.thinking?.type === "adaptive") {
    reasoning = body.thinking.budget_tokens ? budgetToLevel(body.thinking.budget_tokens) : "high";
  }
  if (body.thinking?.type === "disabled") {
    reasoning = undefined;
    // streamKiro enables thinking from model.reasoning when no level is set,
    // so an explicit client-side disable needs a reasoning-less model clone.
    model = { ...model, reasoning: false };
  }

  const systemPrompt = extractSystem(body.system);
  const messages: Message[] = [];
  const now = Date.now();
  for (const msg of body.messages ?? []) {
    if (msg.role === "user") messages.push(...convertUserMessage(msg, now));
    else if (msg.role === "assistant") messages.push(convertAssistantMessage(msg, now));
    // "system"/"developer" mid-conversation messages: streamKiro's own
    // transcript handling lowers them; here we fold them into a user turn.
    else if (typeof msg.content === "string" && msg.content) {
      messages.push({ role: "user", content: msg.content, timestamp: now });
    }
  }

  const tools: Tool[] =
    body.tool_choice?.type === "none"
      ? []
      : (body.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: (t.input_schema ?? { type: "object", properties: {} }) as Tool["parameters"],
        }));

  const sessionId = extractSessionId(body.metadata?.user_id);
  return {
    context: { ...(systemPrompt ? { systemPrompt } : {}), messages, ...(tools.length ? { tools } : {}) },
    model,
    ...(reasoning ? { reasoning } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function extractSessionId(userId: string | undefined): string | undefined {
  if (!userId) return undefined;
  const match = userId.match(/session_([0-9a-fA-F-]{36})/) ?? userId.match(/([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})/);
  return match?.[1];
}

function extractSystem(system: AnthropicRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system || undefined;
  const text = system
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
  return text || undefined;
}

function convertUserMessage(msg: AnthropicMessage, now: number): Message[] {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content, timestamp: now }];
  }
  const out: Message[] = [];
  const parts: (TextContent | ImageContent)[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "tool_result") {
      out.push(convertToolResult(block, now));
    } else if (block.type === "text" && block.text) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.source?.data) {
      parts.push({ type: "image", data: block.source.data, mimeType: block.source.media_type ?? "image/png" });
    } else if (block.type === "document") {
      parts.push({ type: "text", text: "[document omitted: Kiro accepts images only]" });
    }
  }
  if (parts.length > 0) out.push({ role: "user", content: parts, timestamp: now });
  return out;
}

function convertToolResult(block: AnthropicBlock, now: number): ToolResultMessage {
  const content: (TextContent | ImageContent)[] = [];
  if (typeof block.content === "string") {
    content.push({ type: "text", text: block.content });
  } else {
    for (const inner of block.content ?? []) {
      if (inner.type === "text" && inner.text) content.push({ type: "text", text: inner.text });
      else if (inner.type === "image" && inner.source?.data) {
        content.push({ type: "image", data: inner.source.data, mimeType: inner.source.media_type ?? "image/png" });
      }
    }
  }
  return {
    role: "toolResult",
    toolCallId: block.tool_use_id ?? "",
    toolName: "",
    content,
    isError: !!block.is_error,
    timestamp: now,
  };
}

function convertAssistantMessage(msg: AnthropicMessage, now: number): Message {
  if (typeof msg.content === "string") {
    return {
      role: "assistant",
      content: msg.content ? [{ type: "text", text: msg.content }] : [],
      api: "kiro-api",
      provider: "kiro",
      model: "",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: now,
    } as Message;
  }
  const content: Message["content"] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "text" && block.text) {
      (content as TextContent[]).push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && block.thinking) {
      // Signature is dropped: Kiro history ignores reasoning content and the
      // provider re-derives everything else from the wire shape.
      (content as { type: "thinking"; thinking: string }[]).push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use") {
      (content as { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }[]).push({
        type: "toolCall",
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    }
    // redacted_thinking and unknown blocks are dropped on purpose.
  }
  return {
    role: "assistant",
    content,
    api: "kiro-api",
    provider: "kiro",
    model: "",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: now,
  } as Message;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Rough text projection of a converted context, for token estimation. */
export function contextToText(context: Context): string {
  const chunks: string[] = [];
  if (context.systemPrompt) chunks.push(context.systemPrompt);
  for (const m of context.messages) {
    if (typeof m.content === "string") chunks.push(m.content);
    else
      for (const part of m.content) {
        if (part.type === "text") chunks.push(part.text);
        else if (part.type === "thinking") chunks.push(part.thinking);
        else if (part.type === "toolCall") chunks.push(JSON.stringify(part.arguments));
      }
  }
  for (const t of context.tools ?? []) chunks.push(t.name, t.description, JSON.stringify(t.parameters));
  return chunks.join("\n");
}

export type { Model };
