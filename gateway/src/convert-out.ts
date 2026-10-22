// Gateway outbound adapter: pi AssistantMessageEvent stream -> Anthropic
// Messages SSE (streaming) or a single Message JSON (non-streaming).
//
// Provider quirk that shapes this file: streamKiro emits a tool call's
// toolcall_delta ONCE with the full input string (see emitToolCall in
// src/stream.ts), while Anthropic input_json_delta is append-only. We diff
// against what was already sent per block and forward only the suffix.

import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "aborted":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function anthropicUsage(message: AssistantMessage | undefined, fallbackInput: number) {
  const u = message?.usage;
  return {
    input_tokens: u?.input || fallbackInput,
    output_tokens: u?.output ?? 0,
    cache_read_input_tokens: u?.cacheRead ?? 0,
    cache_creation_input_tokens: u?.cacheWrite ?? 0,
  };
}

export function errorTypeFor(message: string): { status: number; type: string } {
  if (/401|403|Invalid token|AccessDenied|GetProfile|credentials not set|expired/i.test(message)) return { status: 401, type: "authentication_error" };
  if (/429|rate|MONTHLY_REQUEST_COUNT|quota/i.test(message)) return { status: 429, type: "rate_limit_error" };
  if (/400|validation|Improperly formed|TOOL_USE|request body/i.test(message)) return { status: 400, type: "invalid_request_error" };
  if (/capacity|INSUFFICIENT_MODEL_CAPACITY|503|502/i.test(message)) return { status: 503, type: "api_error" };
  return { status: 500, type: "api_error" };
}

export function anthropicErrorBody(message: string) {
  const { type } = errorTypeFor(message);
  return { type: "error", error: { type, message } };
}

interface BlockState {
  piIndex: number;
  anthropicIndex: number;
  kind: "text" | "thinking" | "tool_use";
  sentInput: string;
}

/** Stateful SSE writer fed with pi events for one request. */
export class AnthropicStreamWriter {
  private blocks = new Map<number, BlockState>();
  private nextIndex = 0;
  private started = false;
  private finished = false;
  readonly messageId = `msg_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;

  constructor(
    private write: (chunk: string) => void,
    private modelId: string,
    private estimatedInputTokens: number,
  ) {}

  private send(event: string, data: unknown) {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.send("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.estimatedInputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }

  private openBlock(piIndex: number, kind: BlockState["kind"], block: Record<string, unknown>): BlockState {
    this.ensureStarted();
    let state = this.blocks.get(piIndex);
    if (state) return state;
    state = { piIndex, anthropicIndex: this.nextIndex++, kind, sentInput: "" };
    this.blocks.set(piIndex, state);
    this.send("content_block_start", { type: "content_block_start", index: state.anthropicIndex, content_block: block });
    return state;
  }

  private closeBlock(state: BlockState) {
    if (!this.blocks.delete(state.piIndex)) return; // already closed
    this.send("content_block_stop", { type: "content_block_stop", index: state.anthropicIndex });
  }

  handle(event: AssistantMessageEvent) {
    if (this.finished) return;
    switch (event.type) {
      case "start":
        this.ensureStarted();
        break;
      case "text_start":
        this.openBlock(event.contentIndex, "text", { type: "text", text: "" });
        break;
      case "text_delta": {
        const s = this.openBlock(event.contentIndex, "text", { type: "text", text: "" });
        this.send("content_block_delta", {
          type: "content_block_delta",
          index: s.anthropicIndex,
          delta: { type: "text_delta", text: event.delta },
        });
        break;
      }
      case "text_end": {
        const s = this.blocks.get(event.contentIndex);
        if (s) this.closeBlock(s);
        break;
      }
      case "thinking_start":
        this.openBlock(event.contentIndex, "thinking", { type: "thinking", thinking: "", signature: "" });
        break;
      case "thinking_delta": {
        const s = this.openBlock(event.contentIndex, "thinking", { type: "thinking", thinking: "", signature: "" });
        this.send("content_block_delta", {
          type: "content_block_delta",
          index: s.anthropicIndex,
          delta: { type: "thinking_delta", thinking: event.delta },
        });
        break;
      }
      case "thinking_end": {
        const s = this.blocks.get(event.contentIndex);
        if (s) {
          // Anthropic expects a signature on thinking blocks. Kiro provides
          // none; emit an empty signature_delta (other Kiro gateways do the
          // same — Claude Code tolerates it and the block is dropped from
          // history on the way back in).
          this.send("content_block_delta", {
            type: "content_block_delta",
            index: s.anthropicIndex,
            delta: { type: "signature_delta", signature: "" },
          });
          this.closeBlock(s);
        }
        break;
      }
      case "toolcall_start": {
        const partial = event.partial.content[event.contentIndex];
        const tc = partial?.type === "toolCall" ? partial : undefined;
        this.openBlock(event.contentIndex, "tool_use", {
          type: "tool_use",
          id: tc?.id ?? "",
          name: tc?.name ?? "",
          input: {},
        });
        break;
      }
      case "toolcall_delta": {
        const partial = event.partial.content[event.contentIndex];
        const tc = partial?.type === "toolCall" ? partial : undefined;
        const s = this.openBlock(event.contentIndex, "tool_use", {
          type: "tool_use",
          id: tc?.id ?? "",
          name: tc?.name ?? "",
          input: {},
        });
        const full = event.delta ?? "";
        const suffix = full.startsWith(s.sentInput) ? full.slice(s.sentInput.length) : full;
        s.sentInput = full;
        if (suffix) {
          this.send("content_block_delta", {
            type: "content_block_delta",
            index: s.anthropicIndex,
            delta: { type: "input_json_delta", partial_json: suffix },
          });
        }
        break;
      }
      case "toolcall_end": {
        const s = this.blocks.get(event.contentIndex);
        if (s) this.closeBlock(s);
        break;
      }
      case "done": {
        this.ensureStarted();
        for (const s of [...this.blocks.values()]) this.closeBlock(s);
        this.send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: mapStopReason(event.reason), stop_sequence: null },
          usage: anthropicUsage(event.message, this.estimatedInputTokens),
        });
        this.send("message_stop", { type: "message_stop" });
        this.finished = true;
        break;
      }
      case "error": {
        const message = event.error.errorMessage ?? "Kiro request failed";
        if (!this.started) {
          // Handled by the server: it turns a pre-output error into an HTTP
          // error response instead of an SSE stream.
          throw new PreOutputError(message);
        }
        this.send("error", anthropicErrorBody(message));
        this.finished = true;
        break;
      }
    }
  }

  get isStarted() {
    return this.started;
  }
  get isFinished() {
    return this.finished;
  }
}

export class PreOutputError extends Error {}

/** Aggregate a finished pi AssistantMessage into an Anthropic Message JSON. */
export function toAnthropicMessage(message: AssistantMessage, requestedModel: string, estimatedInputTokens: number, id: string) {
  const content: Record<string, unknown>[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "thinking") content.push({ type: "thinking", thinking: part.thinking, signature: "" });
    else if (part.type === "toolCall") content.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments ?? {} });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStopReason(message.stopReason),
    stop_sequence: null,
    usage: anthropicUsage(message, estimatedInputTokens),
  };
}
