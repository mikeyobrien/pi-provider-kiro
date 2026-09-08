// ABOUTME: Translates the modeled Kiro `MetadataEvent.stopReason` into pi's `StopReason` vocabulary.
// ABOUTME: Returns undefined for members this peer cannot express, so callers keep a local decision honest.

import type { StopReason } from "@earendil-works/pi-ai";

/**
 * The wire `StopReason` members this peer has a faithful pi member for.
 *
 * Source of truth: `StopReason` in `KiroRuntimeServiceModel`
 * (`src/main/smithy/types/conversation/tokenTypes.smithy`). The full set is
 * CONTENT_FILTERED, END_TURN, MAX_TOKENS, MODEL_CONTEXT_WINDOW_EXCEEDED,
 * PAUSE_TURN, TOOL_USE, UNKNOWN. Only the three below translate; see
 * {@link mapModeledStopReason} for why each of the others does not.
 */
const MODELED_TO_PI: Readonly<Record<string, Extract<StopReason, "stop" | "length" | "toolUse">>> = {
  END_TURN: "stop",
  TOOL_USE: "toolUse",
  MAX_TOKENS: "length",
};

/**
 * Translate a modeled wire `StopReason` into pi's `StopReason` vocabulary.
 *
 * Returns `undefined` when this peer has no member that means the same thing,
 * so the caller falls back to its own decision rather than passing off a local
 * guess as the service's statement. The unmapped members are:
 *
 * - `CONTENT_FILTERED` — a refusal. `"error"` would be wrong (the request was
 *   valid and the model did respond) and pi has no refusal member.
 * - `PAUSE_TURN` — pi 0.83.0 spells this `"pending"`; at this peer there is no
 *   member, and `"stop"` at least ends the turn rather than stalling it.
 * - `MODEL_CONTEXT_WINDOW_EXCEEDED` — `"length"` is the literal truncation
 *   member, but it reaches `wasPreviousResponseTruncated()`, which prepends
 *   TRUNCATION_NOTICE and sends the same already-overflowing context back. The
 *   next turn overflows again and the loop does not converge. `"stop"` is lossy
 *   in a vocabulary with no overflow member, but a non-terminating retry loop
 *   would not be recoverable at all.
 * - `UNKNOWN` — the service itself could not classify the turn, so there is
 *   nothing to translate.
 *
 * `TOOL_USE` maps to `"toolUse"`, but the caller must still gate that on having
 * actually emitted a tool call: the service can say TOOL_USE while every tool
 * call it sent was dropped for empty or unparseable input, and emitting
 * `"toolUse"` with no tool call on the message stalls pi's agent loop.
 *
 * Nothing maps onto `"error"` or `"aborted"`: every modeled stop reason arrives
 * on a 200 with content already streamed, so routing one there would turn a
 * completed turn into a failed one.
 */
export function mapModeledStopReason(
  rawStopReason: string | undefined,
): Extract<StopReason, "stop" | "length" | "toolUse"> | undefined {
  if (rawStopReason === undefined) return undefined;
  // Own-property lookup: a wire value like "constructor" must not resolve
  // through the record's prototype.
  return Object.hasOwn(MODELED_TO_PI, rawStopReason) ? MODELED_TO_PI[rawStopReason] : undefined;
}
