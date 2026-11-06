// ABOUTME: Per-turn provenance diagnostic recording where each usage figure came from.
// ABOUTME: diagnostics[] is the only structured channel out of streamKiro, which never rejects.

import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

/**
 * Where a usage figure came from. Consumed by diagnostics; never billing.
 *
 * - `measured`  — the service reported the count in `metadataEvent.tokenUsage`.
 * - `derived`   — back-computed locally from another wire figure
 *   (`contextUsagePercentage` × context window for `input`; the sum of
 *   measured slots for `totalTokens`).
 * - `estimated` — invented locally with no wire basis: a tiktoken pass over the
 *   emitted content for `output`, a sum that includes such an estimate for
 *   `totalTokens`, or the opt-in local cache estimate.
 */
export type KiroUsageSource = "measured" | "derived" | "estimated";

/**
 * Provenance for the figures pi's flat `Usage` cannot self-describe.
 *
 * A slot is ABSENT (not `"measured"`) when nothing wrote it this turn, so the
 * `0` left by the attempt reset stays distinguishable from a measured zero.
 * `cache` is absent whenever the turn reported neither cache field, so a genuine
 * 0% cache hit is distinguishable from "the provider never told us". Consumers
 * must render an absent slot as unknown, never as a measured zero. The one
 * exception is the opt-in local cache estimate (`estimateCacheUsage`): when it
 * moves tokens from `input` into `cacheRead`, both `input` and `cache` read
 * `estimated`, because both figures are now local inventions.
 */
export type KiroUsageProvenance = {
  input?: KiroUsageSource;
  output?: KiroUsageSource;
  totalTokens?: KiroUsageSource;
  cache?: KiroUsageSource;
};

/**
 * Diagnostic `type` for the per-turn provenance record.
 *
 * A stable string that a host can match on. Distinct from `kiro_api_error`,
 * which records a failed turn's typed HTTP classification — this one records a
 * turn whose numbers settled, and is the success record rather than a note
 * attached to one.
 */
export const KIRO_TURN_PROVENANCE_DIAGNOSTIC = "kiro_turn_provenance";

/** Inputs for the per-turn provenance diagnostic. */
export interface KiroTurnProvenanceInput {
  /**
   * Provenance recorded by `streamKiro` at the sites that write each usage
   * slot. Read rather than recomputed — the write sites own the
   * measured/derived/estimated decision, and a second classifier here would be
   * free to disagree with the numbers it describes.
   */
  usage: KiroUsageProvenance;
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
 * The usage provenance is copied rather than referenced. The object handed in
 * is the provider's mutable per-attempt accumulator, and this record is a
 * point-in-time statement about a turn that has finished: sharing the
 * reference would let a later write silently rewrite what the diagnostic
 * claims.
 */
export function createKiroTurnProvenanceDiagnostic(input: KiroTurnProvenanceInput): AssistantMessageDiagnostic {
  return {
    type: KIRO_TURN_PROVENANCE_DIAGNOSTIC,
    timestamp: Date.now(),
    details: { usage: { ...input.usage } },
  };
}
