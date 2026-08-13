// ABOUTME: Per-turn provenance diagnostic carrying usage sources and the modeled stop reason.
// ABOUTME: diagnostics[] is the only structured channel out of streamKiro, which never rejects.

import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
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
 *   contextUsage event arrived. Usually right, but a guess.
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
 * None of these is reliably recoverable from the `stopReason` this provider
 * emits, because that value is reconstructed from emitted tool calls and whether
 * a `contextUsageEvent` arrived — `rawStopReason` is never consulted. Each member
 * documents how the emitted value can disagree with it.
 */
export const KIRO_MODELED_STOP_REASONS = {
  /**
   * Context overflow delivered as a *successful* stop reason.
   *
   * It arrives on a 200 with no error body, so the prose-matching
   * `isContextOverflow()` path never sees it and the turn looks like a normal
   * completion that simply stopped early. A consumer that needs to compact has
   * to read this field to find out.
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
   * pi's vocabulary *does* have a member for this — `"length"` — but this
   * provider never routes it there: the emitted value is `"stop"` for any turn
   * with no tool calls once a contextUsage frame has arrived, and `"length"`
   * only when that frame is absent. So a truncated answer is emitted as a
   * natural completion, and the two are told apart only by this field.
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
   * The emitted value agrees (`"stop"`) only once a `contextUsageEvent` has
   * arrived. A `metadataEvent`-only stream leaves `receivedContextUsage` false,
   * so the emitted value is `"length"` while the service said it finished — a
   * fabricated truncation that only this field contradicts.
   */
  endTurn: "END_TURN",
  /**
   * The model is requesting tool use.
   *
   * The emitted value agrees (`"toolUse"`) only when at least one tool call was
   * actually emitted. A turn whose tool calls all had empty or unparseable input
   * emits `"stop"` deliberately — that combination stalls pi's agent loop — so
   * the service's `TOOL_USE` survives only here.
   */
  toolUse: "TOOL_USE",
} as const;

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
