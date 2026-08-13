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
