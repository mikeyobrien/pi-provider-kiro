// ABOUTME: Kiro stream event type definitions and modeled-key-to-typed-event mapping.
// ABOUTME: Binary framing is handled by @smithy/core EventStreamMarshaller in stream.ts.

/**
 * Members of the `ChatResponseStream` tagged union emitted by
 * `generateAssistantResponse` on `runtime.{region}.kiro.dev`.
 *
 * Source of truth: the generated Smithy client for the same service
 * (`@amzn/kiro-runtime-service-typescript-client`, `ChatResponseStream`).
 * The frame's `:event-type` header carries one of these keys, so routing is a
 * switch on the key rather than a guess based on which fields happen to be set.
 */
export const KIRO_EVENT_KEYS = [
  "assistantResponseEvent",
  "codeReferenceEvent",
  "contextUsageEvent",
  "documentCitationEvent",
  "error",
  "metadataEvent",
  "meteringEvent",
  "reasoningContentEvent",
  "serviceUnavailableError",
  "throttlingError",
  "toolResultEvent",
  "toolUseEvent",
  "validationError",
] as const;

export type KiroEventKey = (typeof KIRO_EVENT_KEYS)[number];

const KIRO_EVENT_KEY_SET: ReadonlySet<string> = new Set(KIRO_EVENT_KEYS);

export function isKiroEventKey(key: string): key is KiroEventKey {
  return KIRO_EVENT_KEY_SET.has(key);
}

/** Token accounting from `MetadataEvent.tokenUsage`. */
export type KiroUsageData = {
  /** `TokenUsage.uncachedInputTokens` — input tokens billed at full rate. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  contextUsagePercentage?: number;
  /** `TokenUsage.normalizedTokenUsage` — the MPS credit basis, not a token count. */
  normalizedTokenUsage?: number;
  /** `MetadataEvent.stopReason`, passed through verbatim. */
  rawStopReason?: string;
  /** `MetadataEvent.stopDetails`, passed through verbatim. */
  stopDetails?: Record<string, unknown>;
};

/** Which modeled union member produced an error event. */
export type KiroErrorKind = "internalServer" | "throttling" | "validation" | "serviceUnavailable" | "unknown";

export type KiroErrorData = {
  /** Exception class name, or the legacy free-form `error` string. */
  error: string;
  message?: string;
  kind: KiroErrorKind;
  /** `ThrottlingException.reason` / `ValidationException.reason`, passed through. */
  reason?: string;
  /** `ThrottlingException.retryAfterMilliseconds`. */
  retryAfterMilliseconds?: number;
};

export type KiroStreamEvent =
  | { type: "content"; data: string }
  | { type: "thinkingText"; data: string }
  | { type: "thinkingSignature"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: KiroUsageData }
  /** `MeteringEvent` — `usage` is a COUNT OF CREDITS, not tokens. */
  | { type: "metering"; data: { credits?: number; unit?: string; unitPlural?: string } }
  | { type: "error"; data: KiroErrorData }
  /** A known union member with no consumer yet. Kept distinct from unparseable. */
  | { type: "ignored"; data: { key: string } };

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Serialize a toolUse `input` field, collapsing the empty-object placeholder to "". */
function toolInput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && Object.keys(raw as Record<string, unknown>).length > 0) {
    return JSON.stringify(raw);
  }
  return "";
}

function parseToolUse(parsed: Record<string, unknown>): KiroStreamEvent | null {
  // Kiro splits one logical tool call across frames: the first carries
  // name+toolUseId, continuations carry only `input`, the last only `stop`.
  if (parsed.name && parsed.toolUseId) {
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input: toolInput(parsed.input),
        stop: parsed.stop as boolean | undefined,
      },
    };
  }
  if (parsed.input !== undefined) {
    return { type: "toolUseInput", data: { input: toolInput(parsed.input) } };
  }
  if (parsed.stop !== undefined) return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  return null;
}

function parseMetadata(parsed: Record<string, unknown>): KiroStreamEvent | null {
  const tu = (parsed.tokenUsage ?? {}) as Record<string, unknown>;
  const data: KiroUsageData = {
    inputTokens: num(tu.uncachedInputTokens),
    outputTokens: num(tu.outputTokens),
    totalTokens: num(tu.totalTokens),
    cacheReadInputTokens: num(tu.cacheReadInputTokens),
    cacheWriteInputTokens: num(tu.cacheWriteInputTokens),
    contextUsagePercentage: num(tu.contextUsagePercentage),
    normalizedTokenUsage: num(tu.normalizedTokenUsage),
    rawStopReason: str(parsed.stopReason),
    stopDetails:
      parsed.stopDetails && typeof parsed.stopDetails === "object"
        ? (parsed.stopDetails as Record<string, unknown>)
        : undefined,
  };
  for (const k of Object.keys(data) as (keyof KiroUsageData)[]) {
    if (data[k] === undefined) delete data[k];
  }
  return Object.keys(data).length > 0 ? { type: "usage", data } : null;
}

function parseError(parsed: Record<string, unknown>, kind: KiroErrorKind, fallbackName: string): KiroStreamEvent {
  // Modeled exceptions carry {message, reason?, retryAfterMilliseconds?}; older
  // free-form frames carry {error, message}. Accept both.
  const rawError = parsed.error ?? parsed.Error;
  const error =
    typeof rawError === "string"
      ? rawError
      : rawError !== undefined
        ? JSON.stringify(rawError)
        : (str(parsed.name) ?? fallbackName);
  const message = (parsed.message ?? parsed.Message ?? parsed.reason) as string | undefined;
  const data: KiroErrorData = { error, kind };
  if (typeof message === "string") data.message = message;
  const reason = str(parsed.reason);
  if (reason !== undefined) data.reason = reason;
  const retryAfterMilliseconds = num(parsed.retryAfterMilliseconds);
  if (retryAfterMilliseconds !== undefined) data.retryAfterMilliseconds = retryAfterMilliseconds;
  return { type: "error", data };
}

/**
 * Route a decoded stream frame by its modeled `:event-type` key.
 *
 * `key` is the `ChatResponseStream` union member name from the frame header.
 * Unknown or missing keys fall back to {@link parseKiroEventByShape} so new
 * server-side members degrade instead of breaking the stream.
 */
export function parseKiroEvent(key: string, parsed: Record<string, unknown>): KiroStreamEvent | null {
  switch (key) {
    case "assistantResponseEvent": {
      const content = str(parsed.content);
      return content !== undefined ? { type: "content", data: content } : null;
    }
    case "reasoningContentEvent": {
      // ReasoningContentEvent = {text?, redactedContent?, signature?}
      const text = str(parsed.text);
      if (text !== undefined) return { type: "thinkingText", data: text };
      const signature = str(parsed.signature);
      if (signature !== undefined) return { type: "thinkingSignature", data: signature };
      return { type: "ignored", data: { key } };
    }
    case "toolUseEvent":
      return parseToolUse(parsed);
    case "contextUsageEvent": {
      const pct = num(parsed.contextUsagePercentage);
      return pct !== undefined ? { type: "contextUsage", data: { contextUsagePercentage: pct } } : null;
    }
    case "metadataEvent":
      return parseMetadata(parsed);
    case "meteringEvent":
      // MeteringEvent.usage is a NUMBER of credits — never token counts.
      return {
        type: "metering",
        data: { credits: num(parsed.usage), unit: str(parsed.unit), unitPlural: str(parsed.unitPlural) },
      };
    case "error":
      return parseError(parsed, "internalServer", "InternalServerException");
    case "throttlingError":
      return parseError(parsed, "throttling", "ThrottlingException");
    case "validationError":
      return parseError(parsed, "validation", "ValidationException");
    case "serviceUnavailableError":
      return parseError(parsed, "serviceUnavailable", "ServiceUnavailableException");
    // Known members with no consumer yet: explicitly ignored, not unparseable.
    case "codeReferenceEvent":
    case "documentCitationEvent":
    case "toolResultEvent":
      return { type: "ignored", data: { key } };
    default:
      return parseKiroEventByShape(parsed);
  }
}

/**
 * Fail-open fallback for `$unknown` / unkeyed frames.
 *
 * Order-dependent field sniffing. Only reachable when the frame carries no
 * recognizable `:event-type`; modeled frames never reach here.
 */
export function parseKiroEventByShape(parsed: Record<string, unknown>): KiroStreamEvent | null {
  if (parsed.content !== undefined) return { type: "content", data: parsed.content as string };
  if (typeof parsed.text === "string") return { type: "thinkingText", data: parsed.text };
  if (typeof parsed.signature === "string") return { type: "thinkingSignature", data: parsed.signature };
  if (parsed.name && parsed.toolUseId) return parseToolUse(parsed);
  if (parsed.input !== undefined && !parsed.name) {
    return { type: "toolUseInput", data: { input: toolInput(parsed.input) } };
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined)
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  if (parsed.contextUsagePercentage !== undefined)
    return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage as number } };
  if (parsed.followupPrompt !== undefined) return { type: "followupPrompt", data: parsed.followupPrompt as string };
  if (parsed.tokenUsage !== undefined || parsed.stopReason !== undefined || parsed.stopDetails !== undefined) {
    return parseMetadata(parsed);
  }
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    return parseError(parsed, "unknown", "unknown");
  }
  if (typeof parsed.usage === "number") {
    return {
      type: "metering",
      data: { credits: parsed.usage, unit: str(parsed.unit), unitPlural: str(parsed.unitPlural) },
    };
  }
  return null;
}
