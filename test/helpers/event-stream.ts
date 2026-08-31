import { EventStreamCodec } from "@smithy/core/event-streams";
import { isKiroEventKey, type KiroEventKey } from "../../src/event-parser.js";

const codec = new EventStreamCodec(
  (input: Uint8Array) => new TextDecoder().decode(input),
  (input: string) => new TextEncoder().encode(input),
);

/**
 * Infer the `ChatResponseStream` union member a payload belongs to.
 *
 * Real frames carry the member name in the `:event-type` header; fixtures are
 * written as bare payloads, so derive the key from the payload shape to keep
 * the encoded frame faithful to the wire contract.
 */
export function inferEventKey(payload: Record<string, unknown>): KiroEventKey | "$unknown" {
  if (payload.content !== undefined) return "assistantResponseEvent";
  if (typeof payload.text === "string" || typeof payload.signature === "string") return "reasoningContentEvent";
  // contextUsagePercentage is checked before the toolUse `stop` branch for the
  // same reason parseKiroEventByShape guards it: a contextUsageEvent payload can
  // also carry `stop`, and inferring toolUseEvent there would frame it wrongly.
  if (payload.contextUsagePercentage !== undefined) return "contextUsageEvent";
  if (payload.toolUseId !== undefined || payload.input !== undefined || payload.stop !== undefined)
    return "toolUseEvent";
  if (payload.tokenUsage !== undefined || payload.stopReason !== undefined || payload.stopDetails !== undefined)
    return "metadataEvent";
  if (typeof payload.usage === "number") return "meteringEvent";
  if (payload.error !== undefined || payload.Error !== undefined) return "error";
  return "$unknown";
}

/**
 * Encode a payload as one binary event-stream frame.
 *
 * `eventType` defaults to the member inferred from the payload shape; pass it
 * explicitly to exercise a specific union member (including error members,
 * which share field names with each other).
 *
 * Passing `"$unknown"` produces a frame the Smithy marshaller DROPS: it skips
 * any event frame whose deserialized result carries a `$unknown` property, and
 * the deserializer in `src/stream.ts` keys its result by this header value. Use
 * a real member name for anything that must reach the parser.
 *
 * Note: the four error members target `@error` shapes, so the service frames
 * them as `:message-type: exception`. Use {@link encodeExceptionMessage} for
 * those; this function is for ordinary `event` frames.
 */
export function encodeEventMessage(payload: object, eventType?: KiroEventKey | "$unknown"): Uint8Array {
  const key = eventType ?? inferEventKey(payload as Record<string, unknown>);
  if (key !== "$unknown" && !isKiroEventKey(key)) {
    throw new Error(`Not a ChatResponseStream member: ${key}`);
  }
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: key },
      ":message-type": { type: "string", value: "event" },
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

/**
 * Encode a modeled error member the way the service actually frames it.
 *
 * `ChatResponseStream`'s `error` / `throttlingError` / `validationError` /
 * `serviceUnavailableError` members target `@error` shapes, so they arrive as
 * `:message-type: exception` with the member name in `:exception-type` — the
 * Smithy marshaller routes those through a different path than event frames.
 */
export function encodeExceptionMessage(exceptionType: KiroEventKey, payload: object): Uint8Array {
  if (!isKiroEventKey(exceptionType)) {
    throw new Error(`Not a ChatResponseStream member: ${exceptionType}`);
  }
  return encodeRawExceptionMessage(exceptionType, payload);
}

/**
 * Encode an exception frame for a member name this client does not model.
 *
 * Deliberately skips the `KIRO_EVENT_KEYS` guard so tests can exercise the
 * unmodeled-member path — a fifth error member added server-side, which must
 * still surface its `:exception-type` name rather than a bare JSON body.
 */
export function encodeRawExceptionMessage(exceptionType: string, payload: object): Uint8Array {
  return encodeExceptionFrame(exceptionType, JSON.stringify(payload));
}

/**
 * Encode an exception frame whose body is NOT parseable JSON.
 *
 * The modeled class lives in the `:exception-type` header, so it must survive a
 * body this client cannot read — otherwise the JSON parse failure replaces the
 * modeled error with a `SyntaxError` message and the class is lost.
 */
export function encodeExceptionMessageWithRawBody(exceptionType: string, body: string): Uint8Array {
  return encodeExceptionFrame(exceptionType, body);
}

function encodeExceptionFrame(exceptionType: string, body: string): Uint8Array {
  return codec.encode({
    headers: {
      ":exception-type": { type: "string", value: exceptionType },
      ":message-type": { type: "string", value: "exception" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: new TextEncoder().encode(body),
  });
}

export function concatMessages(...msgs: Uint8Array[]): Uint8Array {
  const total = msgs.reduce((sum, m) => sum + m.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const m of msgs) {
    result.set(m, offset);
    offset += m.length;
  }
  return result;
}
