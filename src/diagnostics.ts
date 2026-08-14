// ABOUTME: Per-turn provenance diagnostic carrying usage sources and the modeled stop reason.
// ABOUTME: diagnostics[] is the only structured channel out of streamKiro, which never rejects.

import type { AssistantMessageDiagnostic, StopReason } from "@earendil-works/pi-ai";
import type { KiroUsageProvenance } from "./token-usage.js";

/**
 * Diagnostic `type` for the per-turn provenance record.
 *
 * Stable string: kermes matches on it. Distinct from `kiro_api_error`, which
 * records a failed turn's typed HTTP classification — this one records a turn
 * whose numbers settled, and is the success record rather than a note attached
 * to one.
 */
export const KIRO_TURN_PROVENANCE_DIAGNOSTIC = "kiro_turn_provenance";

/**
 * How the `stopReason` this provider emitted was arrived at.
 *
 * - `modeled` — `MetadataEvent.stopReason` arrived on the wire and the emitted
 *   value reflects it.
 * - `inferred` — reconstructed locally from emitted tool calls and whether a
 *   contextUsage event arrived. Usually right, but a guess. Also used when a
 *   modeled stop reason *did* arrive but pi's vocabulary has no faithful member
 *   for it, so the emitted value cannot reflect it (see
 *   {@link mapModeledStopReason}).
 */
export type KiroStopReasonSource = "modeled" | "inferred";

/**
 * The complete wire `StopReason` vocabulary, so a consumer can match
 * {@link KiroStopReasonRecord.modeled} against named members instead of
 * hand-written string literals.
 *
 * Source of truth: `StopReason` in `KiroRuntimeServiceModel`
 * (`src/main/smithy/types/conversation/tokenTypes.smithy`), surfaced through the
 * generated client (`@amzn/kiro-runtime-service-typescript-client`). All seven
 * members are listed; the map is exhaustive by intent, and its test asserts that
 * by exact equality.
 *
 * {@link mapModeledStopReason} translates the members pi has a member for; the
 * rest remain recoverable only from this record, because pi's vocabulary has
 * nowhere to put them. Each member below documents which case it is.
 */
export const KIRO_MODELED_STOP_REASONS = {
  /**
   * Context overflow delivered as a *successful* stop reason.
   *
   * It arrives on a 200 with no error body, so the prose-matching
   * `isContextOverflow()` path never sees it and the turn looks like a normal
   * completion that simply stopped early. A consumer that needs to compact has
   * to read this field to find out — {@link mapModeledStopReason} deliberately
   * declines to route it to pi's `"length"`, because that member asks for a
   * continuation, which is the one thing an overflowed context must not get.
   */
  contextWindowExceeded: "MODEL_CONTEXT_WINDOW_EXCEEDED",
  /**
   * A content-policy refusal, also delivered as a *successful* stop reason.
   *
   * The service models a refusal as `MetadataEvent { stopReason:
   * CONTENT_FILTERED, stopDetails: { refusal: { category, explanation,
   * recommendedModel } } }` rather than as a `ValidationException` — the request
   * was valid and the model did respond, it just declined. So this shares the
   * invisibility of {@link contextWindowExceeded}: nothing on the error path
   * ever sees it, and pi's emitted `stopReason` has no member for it either.
   * The `refusal` payload rides {@link KiroStopReasonRecord.details}.
   */
  contentFiltered: "CONTENT_FILTERED",
  /** The wire origin of pi 0.83.0's `"pending"`; earlier peers have no slot for it. */
  pauseTurn: "PAUSE_TURN",
  /**
   * The model hit its output token limit.
   *
   * pi's vocabulary has a member for exactly this — `"length"` — and
   * {@link mapModeledStopReason} routes it there, so a truncated answer is
   * emitted as truncated and `wasPreviousResponseTruncated()` can offer the
   * continuation the turn actually needs.
   */
  maxTokens: "MAX_TOKENS",
  /**
   * The provider returned a stop reason the service itself did not recognize.
   *
   * Named so a consumer can distinguish "the service explicitly could not
   * classify this turn" from `modeled` being absent, which means no
   * `metadataEvent` stop reason arrived at all.
   */
  unknown: "UNKNOWN",
  /**
   * The model finished naturally.
   *
   * Routed to pi's `"stop"`. Before the modeled value was consulted, a
   * `metadataEvent`-only stream left `receivedContextUsage` false and the turn
   * was emitted as `"length"` — a fabricated truncation that made
   * `wasPreviousResponseTruncated()` prepend a continuation notice to the next
   * turn.
   */
  endTurn: "END_TURN",
  /**
   * The model is requesting tool use.
   *
   * Routed to pi's `"toolUse"` only when at least one tool call was actually
   * emitted. A turn whose tool calls all had empty or unparseable input emits
   * `"stop"` deliberately — that combination stalls pi's agent loop waiting for
   * results that will never arrive — so in that case the service's `TOOL_USE`
   * survives only here.
   */
  toolUse: "TOOL_USE",
} as const;

/**
 * Translate a modeled wire `StopReason` into pi's `StopReason` vocabulary.
 *
 * Returns `undefined` when this peer has no member that means the same thing.
 * The caller then keeps its local reconstruction and reports
 * `stopReasonSource: "inferred"`, so an unmappable member never masquerades as
 * a modeled emission. The unmapped members are:
 *
 * - `CONTENT_FILTERED` — a refusal. `"error"` would be wrong (the request was
 *   valid and the model did respond) and pi has no refusal member, so the
 *   category/explanation payload stays in {@link KiroStopReasonRecord.details}.
 * - `PAUSE_TURN` — pi 0.83.0 spells this `"pending"`; at this peer there is no
 *   member, and `"stop"` at least ends the turn rather than stalling it.
 * - `MODEL_CONTEXT_WINDOW_EXCEEDED` — see
 *   {@link KIRO_MODELED_STOP_REASONS.contextWindowExceeded}: `"length"` invites
 *   a continuation that would grow the very context that overflowed. Consumers
 *   detect it with {@link isModeledContextOverflowStopReason}.
 * - `UNKNOWN` — the service itself could not classify the turn, so there is
 *   nothing to translate.
 *
 * `TOOL_USE` maps to `"toolUse"`, but the caller must still gate that on having
 * actually emitted a tool call: emitting `"toolUse"` with no tool call on the
 * message stalls pi's agent loop.
 */
export function mapModeledStopReason(rawStopReason: string | undefined): StopReason | undefined {
  switch (rawStopReason) {
    case KIRO_MODELED_STOP_REASONS.endTurn:
      return "stop";
    case KIRO_MODELED_STOP_REASONS.toolUse:
      return "toolUse";
    case KIRO_MODELED_STOP_REASONS.maxTokens:
      return "length";
    default:
      return undefined;
  }
}

/**
 * True when the modeled stop reason says the context window overflowed.
 *
 * Exported so consumers share this judgement instead of re-deriving it from a
 * raw string, and so the distinction survives the fact that pi's emitted
 * `stopReason` has no member for it.
 */
export function isModeledContextOverflowStopReason(rawStopReason: string | undefined): boolean {
  return rawStopReason === KIRO_MODELED_STOP_REASONS.contextWindowExceeded;
}

/** Stop-reason facts recorded for a turn. */
export interface KiroStopReasonRecord {
  /** The value this provider actually emitted on the message. */
  emitted: string;
  /** How {@link emitted} was arrived at. */
  source: KiroStopReasonSource;
  /** `MetadataEvent.stopReason`, verbatim, when the service sent one. */
  modeled?: string;
  /** `MetadataEvent.stopDetails`, verbatim, when the service sent one. */
  details?: Record<string, unknown>;
  /**
   * Set only when the modeled stop reason reports a context overflow. Present
   * because that case is otherwise invisible: it rides a successful turn.
   */
  contextOverflow?: true;
}

/** Inputs for the per-turn provenance diagnostic. */
export interface KiroTurnProvenanceInput {
  /**
   * Provenance recorded by `finalizeKiroUsage`. Read rather than recomputed —
   * that function owns the measured/derived/estimated precedence, and a second
   * classifier here would be free to disagree with the numbers it describes.
   */
  usage?: KiroUsageProvenance;
  /** The stop reason this provider emitted. */
  stopReason: string;
  /**
   * How {@link stopReason} was produced, supplied by the code that produced it.
   *
   * Deliberately not inferred from {@link rawStopReason} being present: the
   * service can send a modeled stop reason that the emitted value does not yet
   * follow, and reading presence as authorship would report the emitted value
   * as measured when it was still a local guess.
   */
  stopReasonSource: KiroStopReasonSource;
  /** `MetadataEvent.stopReason`, when one arrived. */
  rawStopReason?: string;
  /** `MetadataEvent.stopDetails`, when it arrived. */
  stopDetails?: Record<string, unknown>;
}

/**
 * Build the per-turn provenance diagnostic.
 *
 * Constructed as a literal rather than through pi-ai's
 * `createAssistantMessageDiagnostic`, which routes its second argument through
 * `extractDiagnosticError` unconditionally — passing `undefined` there yields a
 * bogus `error: { name: "ThrownValue", message: "undefined" }` on a record that
 * describes a successful turn. `kiro_api_error` uses the helper correctly
 * because it always has a real error to pass.
 *
 * Absent optional fields are omitted rather than written as null, so a consumer
 * can distinguish "the service never said" from "the service said nothing".
 *
 * The usage provenance is copied rather than referenced. The object handed in
 * lives on `usage.provenance`, i.e. elsewhere on the same message, and this
 * record is a point-in-time statement about a turn that has finished: sharing
 * the reference would let a later write to `usage.provenance` silently rewrite
 * what the diagnostic claims, and would make any test asserting the two agree
 * unable to fail.
 */
export function createKiroTurnProvenanceDiagnostic(input: KiroTurnProvenanceInput): AssistantMessageDiagnostic {
  const stopReason: KiroStopReasonRecord = {
    emitted: input.stopReason,
    source: input.stopReasonSource,
    ...(input.rawStopReason !== undefined ? { modeled: input.rawStopReason } : {}),
    ...(input.stopDetails !== undefined ? { details: input.stopDetails } : {}),
    ...(isModeledContextOverflowStopReason(input.rawStopReason) ? { contextOverflow: true as const } : {}),
  };
  return {
    type: KIRO_TURN_PROVENANCE_DIAGNOSTIC,
    timestamp: Date.now(),
    details: {
      ...(input.usage !== undefined ? { usage: { ...input.usage } } : {}),
      stopReason,
    },
  };
}
