// ABOUTME: Maps Kiro's modeled MetadataEvent.tokenUsage onto pi's Usage shape.
// ABOUTME: Measured wire counts win over derived/estimated ones; provenance is recorded.

import type { Usage } from "@earendil-works/pi-ai";

/**
 * Token accounting as it arrives on the wire, from `MetadataEvent.tokenUsage`.
 *
 * Source of truth: the generated Smithy client for the same service
 * (`@amzn/kiro-runtime-service-typescript-client`, `TokenUsage`). Field names
 * are the wire names. Every field is optional here because a given turn may
 * omit any of them, and an absent count must stay distinguishable from zero.
 *
 * `inputTokens` deliberately mirrors the wire's `uncachedInputTokens`: it is
 * the input billed at full rate, NOT the total prompt size. Total prompt size
 * is `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`, which is
 * exactly how pi's `Usage` splits the same quantity.
 */
export type KiroWireTokenUsage = {
  /** `TokenUsage.uncachedInputTokens` — input billed at full rate. */
  inputTokens?: number;
  outputTokens?: number;
  /** `TokenUsage.totalTokens` — authoritative; preferred over recomputation. */
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** `(totalTokens / maxContextWindowTokens) * 100`, as computed by the service. */
  contextUsagePercentage?: number;
  /** `TokenUsage.normalizedTokenUsage` — the MPS credit basis, not a token count. */
  normalizedTokenUsage?: number;
};

/** Where a usage figure came from. Consumed by diagnostics; never billing. */
export type KiroUsageSource = "measured" | "derived" | "estimated";

/**
 * Provenance for the figures pi cannot self-describe.
 *
 * `cache` is absent (not `"measured"`) when the turn reported no cache fields
 * at all, so a genuine 0% cache hit stays distinguishable from "the provider
 * never told us". Consumers must render the absent case as unknown rather than
 * as a measured zero.
 */
export type KiroUsageProvenance = {
  input?: KiroUsageSource;
  output?: KiroUsageSource;
  totalTokens?: KiroUsageSource;
  cache?: KiroUsageSource;
};

/**
 * pi's `Usage` plus the Kiro-specific figures it has no slot for.
 *
 * These were previously written through an `as unknown as Record<string,
 * unknown>` cast, which let typos through silently. They are declared here so
 * the compiler checks them.
 */
export type KiroUsage = Usage & {
  /** Service-reported context consumption, 0-100. Verbatim, never derived. */
  contextPercent?: number;
  /** `TokenUsage.normalizedTokenUsage` — MPS credit basis. */
  normalizedTokenUsage?: number;
  /** `MeteringEvent.usage` — a count of CREDITS, never tokens. */
  credits?: number;
  /** Display unit for {@link credits}, e.g. "credit"/"credits". */
  creditUnit?: string;
  /**
   * Both grammatical forms `MeteringEvent` supplied, retained so {@link
   * creditUnit} can be re-decided when a later frame revises the count.
   * Diagnostics should read {@link creditUnit}, not this.
   */
  creditUnitForms?: { singular?: string; plural?: string };
  provenance?: KiroUsageProvenance;
};

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Clear everything a single stream attempt wrote, `cost` included.
 *
 * The `usage` object outlives the retry loop, but each attempt re-reports its
 * own counts. Without this reset a failed attempt's cache counts, credits,
 * `normalizedTokenUsage` and provenance would survive into a successful retry
 * that reported none of them — and stale cache legs would then be added into
 * the retry's recomputed `totalTokens`.
 *
 * `cost` is reset with them, because it is derived wholly from the counts being
 * cleared and would otherwise be the one figure left unbacked by any of them.
 * A successful attempt recomputes it via `PiAi.calculateCost`, so this only
 * changes what a FAILED turn reports — and there it is the whole point. The
 * empty-response/echo-loop retry runs after the turn has already been
 * finalized and priced, so a degenerate-but-priced attempt followed by a
 * terminal stream error would otherwise emit an error message carrying the
 * abandoned attempt's charge against zeroed token counts.
 */
export function resetKiroUsage(usage: KiroUsage): void {
  usage.input = 0;
  usage.output = 0;
  usage.cacheRead = 0;
  usage.cacheWrite = 0;
  usage.totalTokens = 0;
  usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  delete usage.contextPercent;
  delete usage.normalizedTokenUsage;
  delete usage.credits;
  delete usage.creditUnit;
  delete usage.creditUnitForms;
  delete usage.provenance;
}

/**
 * Record the service's context consumption and a provisional input estimate.
 *
 * `contextUsageEvent` arrives mid-stream, well before `metadataEvent`, so this
 * keeps live context% updating during a turn. The input figure it derives is
 * back-computed from a percentage and is therefore coarse; it is marked
 * `"derived"` so {@link finalizeKiroUsage} can overwrite it with the measured
 * count once metadata lands. `contextPercent` itself is always the service's
 * own number and is never re-derived from tokens.
 *
 * Note what the percentage actually measures: the service computes it as
 * `(totalTokens / maxContextWindowTokens) * 100`, and `totalTokens` spans the
 * WHOLE turn — uncached input, cache reads/writes AND output. So this figure is
 * an approximation of `totalTokens`, not of the `input` slot it is parked in.
 * That is tolerable only because it is provisional: a measured
 * `uncachedInputTokens` replaces it, and a measured `totalTokens` replaces any
 * total recomputed from it. See {@link finalizeKiroUsage} for what remains
 * imprecise when the wire omits both.
 */
export function applyContextUsage(usage: KiroUsage, contextUsagePercentage: number, contextWindow: number): void {
  if (!isCount(contextUsagePercentage)) return;
  usage.contextPercent = contextUsagePercentage;
  if (!isCount(contextWindow) || contextWindow === 0) return;
  usage.input = Math.round((contextUsagePercentage / 100) * contextWindow);
  usage.provenance = { ...usage.provenance, input: "derived" };
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * Record `MeteringEvent` credits.
 *
 * These are the units the account is actually billed in. They are not tokens
 * and must never be folded into token counts or into `Usage.cost`.
 *
 * `MeteringEvent` supplies both grammatical forms (`unit`/`unitPlural`), so the
 * one that agrees with the count is selected here rather than at the call site:
 * storing `unitPlural` unconditionally renders "1 credits". Zero takes the
 * plural, as English does. Either form alone is used as-is.
 *
 * Every `MeteringEvent` field is optional (see the generated `MeteringEvent`:
 * `usage`, `unit` and `unitPlural` are all optional), so the count and the unit
 * strings can arrive in either order, in separate frames:
 *
 *   - units then count — the units frame has no count to agree with, so its
 *     choice is provisional and must be revisited once the count lands.
 *   - count then units — the units frame carries no count, so agreement must be
 *     decided against the count already recorded, not this call's argument.
 *
 * Both are handled by keeping the forms themselves on `usage` and re-deciding
 * agreement from scratch on every frame. Deciding once per frame from only that
 * frame's fields renders "1 credits" in whichever order is not special-cased.
 */
export function applyMeteringCredits(usage: KiroUsage, credits?: number, unit?: string, unitPlural?: string): void {
  if (isCount(credits)) usage.credits = credits;

  const singular = nonEmpty(unit) ?? usage.creditUnitForms?.singular;
  const plural = nonEmpty(unitPlural) ?? usage.creditUnitForms?.plural;
  if (singular === undefined && plural === undefined) return;
  usage.creditUnitForms = { ...(singular !== undefined && { singular }), ...(plural !== undefined && { plural }) };

  // Re-decided against the count now held on `usage`, so a count arriving in a
  // later frame corrects a provisionally-plural unit. An unknown count takes the
  // plural, matching the zero case.
  const preferred = usage.credits === 1 ? (singular ?? plural) : (plural ?? singular);
  if (preferred !== undefined) usage.creditUnit = preferred;
}

/**
 * Fold the modeled token counts into `usage`, then fill remaining gaps.
 *
 * Precedence, highest first:
 *   1. measured  — a count the service reported in `metadataEvent.tokenUsage`
 *   2. derived   — back-computed from `contextUsagePercentage` (input only)
 *   3. estimated — tiktoken over what the assistant emitted (output only)
 *
 * A measured count always overwrites a derived or estimated one; the reverse
 * never happens. `estimateOutput` is invoked only when the wire omitted
 * `outputTokens`, so an estimate can never displace a real measurement.
 *
 * Kiro does not reliably emit `outputTokens` on every turn, and a tool-call-only
 * turn that reported 0 output would break consumers that watch `usage.output`
 * (the TPS extension, for one) — hence the estimate fallback rather than a zero.
 */
export function finalizeKiroUsage(
  usage: KiroUsage,
  wire: KiroWireTokenUsage | null | undefined,
  estimateOutput: () => number,
): void {
  const provenance: KiroUsageProvenance = { ...usage.provenance };

  if (isCount(wire?.inputTokens)) {
    usage.input = wire.inputTokens;
    provenance.input = "measured";
  }

  if (isCount(wire?.outputTokens)) {
    usage.output = wire.outputTokens;
    provenance.output = "measured";
  } else {
    usage.output = estimateOutput();
    provenance.output = "estimated";
  }

  // Slot invariant: pi's `input`, `cacheRead` and `cacheWrite` are mutually
  // exclusive slices of ONE prompt, and `calculateCost` prices each separately.
  // The wire's `uncachedInputTokens` is exactly the `input` slice, so a measured
  // input and the cache counts compose correctly. A
  // `contextUsagePercentage`-derived input does NOT: it spans the whole prompt,
  // cached portion included. Leaving that in `input` while also reporting cache
  // counts double-counts the cached tokens — in the total AND in the cost.
  //
  // So normalize the slots here rather than special-casing the sum below:
  // subtract the known cache legs out of a derived input. Then the four slots
  // never overlap and the total is one unconditional sum in every case.
  const cacheRead = wire?.cacheReadInputTokens;
  const cacheWrite = wire?.cacheWriteInputTokens;
  if (isCount(cacheRead) || isCount(cacheWrite)) {
    usage.cacheRead = isCount(cacheRead) ? cacheRead : 0;
    usage.cacheWrite = isCount(cacheWrite) ? cacheWrite : 0;
    provenance.cache = "measured";
    if (provenance.input === "derived") {
      // Floored at 0: the derived figure is a rounded back-computation, so it can
      // legitimately land under the measured cache legs.
      usage.input = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
    }
  }

  // What the subtraction above does and does not achieve: it stops the cached
  // tokens being priced twice (once inside the derived `input`, once on
  // `calculateCost`'s separate `cacheRead` line), which is the part that costs
  // money. It does NOT make a derived `input` a true prompt-only figure — the
  // percentage it came from spans the output tokens as well, and those cannot be
  // subtracted out because the only output count available here may itself be an
  // estimate. Consequence, confined to the recomputed-total branch below: when
  // the input is derived AND the wire omitted `totalTokens`, the total
  // over-reports by roughly the output count. Both conditions together are rare
  // — `TokenUsage.totalTokens` is a required field, so any conforming
  // `metadataEvent` supplies the authoritative total and this branch is skipped.
  // The total is marked `"estimated"` in exactly that case.

  if (isCount(wire?.contextUsagePercentage)) usage.contextPercent = wire.contextUsagePercentage;
  if (isCount(wire?.normalizedTokenUsage)) usage.normalizedTokenUsage = wire.normalizedTokenUsage;

  if (isCount(wire?.totalTokens)) {
    // `TokenUsage.totalTokens` is required on the wire while the cache counts are
    // optional, so the service's own total is authoritative — recomputing from
    // components under-reports whenever one is omitted. `calculateContextTokens`
    // reads `totalTokens` first, so this figure drives pi's context gauge.
    usage.totalTokens = wire.totalTokens;
    provenance.totalTokens = "measured";
  } else {
    // No authoritative total. Sum the four slots, which the normalization above
    // made non-overlapping for cost purposes. Accurate when the input was
    // measured; over-reports by roughly the output count when it was derived,
    // per the note above — hence the provenance below.
    usage.totalTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    provenance.totalTokens =
      provenance.input === "measured" && provenance.output === "measured" ? "derived" : "estimated";
  }

  usage.provenance = provenance;
}
