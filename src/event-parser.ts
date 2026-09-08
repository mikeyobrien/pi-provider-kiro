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
  /**
   * `TokenUsage.normalizedTokenUsage` — usage normalized by MPS from credit
   * information. Distinct from `MeteringEvent.usage`, which is a raw credit
   * count; surfaced so it is not dropped at the boundary like the rest of
   * `MetadataEvent` was.
   */
  normalizedTokenUsage?: number;
  /** `MetadataEvent.stopReason`, passed through verbatim. */
  rawStopReason?: string;
  /** `MetadataEvent.stopDetails`, passed through verbatim. */
  stopDetails?: Record<string, unknown>;
};

/** Which modeled union member produced an error event. */
export type KiroErrorKind = "internalServer" | "throttling" | "validation" | "serviceUnavailable" | "unknown";

/**
 * The four error members of `ChatResponseStream` target `@error` shapes, so the
 * service frames them as `:message-type: exception` with the union member name
 * in `:exception-type` — not as ordinary `event` frames. Mapping the member to
 * its exception class here keeps both framings on one table.
 */
export const KIRO_ERROR_MEMBERS: Readonly<Record<string, { kind: KiroErrorKind; exception: string }>> = {
  error: { kind: "internalServer", exception: "InternalServerException" },
  throttlingError: { kind: "throttling", exception: "ThrottlingException" },
  validationError: { kind: "validation", exception: "ValidationException" },
  serviceUnavailableError: { kind: "serviceUnavailable", exception: "ServiceUnavailableException" },
};

/**
 * The token the service puts in `:exception-type` is not guaranteed to be the
 * union member name. The hand-written event-stream bridge in the generated
 * client for THIS service (`sse-middleware.ts`, `buildStreamException`) accepts
 * either form for every one of the four members — `throttlingError` OR
 * `ThrottlingException` — and does so on both its exception-frame and its
 * defensive event-frame path. That is the same service, so both tokens are
 * observed vocabulary, not speculation.
 *
 * Keyed separately from `KIRO_EVENT_MEMBERS` because a class name is NOT a
 * `ChatResponseStream` member: `KIRO_EVENT_KEYS` stays the union's enumeration
 * and keeps guarding fixture encoding.
 */
const KIRO_ERROR_TOKENS: Readonly<Record<string, { kind: KiroErrorKind; exception: string }>> = {
  ...KIRO_ERROR_MEMBERS,
  InternalServerException: KIRO_ERROR_MEMBERS.error,
  ThrottlingException: KIRO_ERROR_MEMBERS.throttlingError,
  ValidationException: KIRO_ERROR_MEMBERS.validationError,
  ServiceUnavailableException: KIRO_ERROR_MEMBERS.serviceUnavailableError,
};

/**
 * Look up an error member by a token the SERVICE chose.
 *
 * `KIRO_ERROR_TOKENS` is an ordinary object literal, so a bare index would
 * also resolve inherited `Object.prototype` members: an `:exception-type` of
 * `toString` or `constructor` returns a truthy value whose `kind` and
 * `exception` are both undefined, silently discarding the member name this
 * routing exists to preserve. Only own properties count as modeled members.
 */
export function lookupKiroErrorMember(key: string): { kind: KiroErrorKind; exception: string } | undefined {
  return Object.hasOwn(KIRO_ERROR_TOKENS, key) ? KIRO_ERROR_TOKENS[key] : undefined;
}

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

function parseError(
  parsed: Record<string, unknown>,
  kind: KiroErrorKind,
  fallbackName: string,
): { type: "error"; data: KiroErrorData } {
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
 * An unrecognized key falls back to {@link parseKiroEventByShape} so a member
 * added server-side degrades instead of breaking the stream.
 *
 * Note: a frame whose `:event-type` is the literal `$unknown` never reaches
 * here. The Smithy marshaller drops any event frame for which the deserializer
 * returns a `$unknown` property, and the deserializer keys its result by the
 * header value, so `$unknown` is discarded one layer up. The fallback below is
 * therefore reached only by a real, unrecognized member name.
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
    // Reachable when a member that models an exception is delivered as an
    // ordinary event frame. The real wire uses exception framing, handled by
    // parseKiroExceptionFrame, but both routes must agree.
    case "error":
    case "throttlingError":
    case "validationError":
    case "serviceUnavailableError": {
      // Literal case labels, so the own-property lookup always resolves.
      const member = lookupKiroErrorMember(key) as { kind: KiroErrorKind; exception: string };
      return parseError(parsed, member.kind, member.exception);
    }
    // Known members with no consumer yet: explicitly ignored, not unparseable.
    case "codeReferenceEvent":
    case "documentCitationEvent":
    case "toolResultEvent":
      return { type: "ignored", data: { key } };
    default: {
      // An error member delivered under its exception CLASS name rather than its
      // union member name (see KIRO_ERROR_TOKENS). Classify before shape
      // sniffing: an exception payload is `{message, reason?}`, which the
      // fallback ladder matches on nothing and drops — losing the class exactly
      // the way the old field ladder did.
      const member = lookupKiroErrorMember(key);
      if (member) return parseError(parsed, member.kind, member.exception);
      return parseKiroEventByShape(parsed);
    }
  }
}

/**
 * Route an `:message-type: exception` frame by its `:exception-type` token.
 *
 * The Smithy marshaller throws whatever the deserializer returns for that key,
 * so this is the only place the modeled exception class, `reason`, and
 * `retryAfterMilliseconds` are still structured. Accepts either token form the
 * service uses (union member name or exception class name). Returns `null` for
 * a token that is not one of the four modeled errors; the caller is responsible
 * for still preserving that name (see `src/stream.ts`), because Smithy's own
 * raw-body fallback only fires for a `$unknown` result this deserializer never
 * produces.
 */
export function parseKiroExceptionFrame(key: string, parsed: Record<string, unknown>): KiroErrorData | null {
  const member = lookupKiroErrorMember(key);
  if (!member) return null;
  const event = parseError(parsed, member.kind, member.exception);
  return event.data;
}

/**
 * Fail-open fallback for frames carrying an unrecognized `:event-type`.
 *
 * Order-dependent field sniffing. Only reachable when the frame's key is not a
 * known `ChatResponseStream` member; modeled frames never reach here.
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
