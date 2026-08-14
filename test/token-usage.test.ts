import { describe, expect, it } from "vitest";
import {
  applyContextUsage,
  applyMeteringCredits,
  finalizeKiroUsage,
  type KiroUsage,
  type KiroWireTokenUsage,
  resetKiroUsage,
} from "../src/token-usage.js";

const CONTEXT_WINDOW = 200_000;

function freshUsage(): KiroUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A fully populated wire payload, as a cache-warm turn actually reports it. */
function fullWire(): KiroWireTokenUsage {
  return {
    inputTokens: 1_200,
    outputTokens: 340,
    totalTokens: 9_540,
    cacheReadInputTokens: 8_000,
    cacheWriteInputTokens: 0,
    contextUsagePercentage: 4.77,
    normalizedTokenUsage: 12.5,
  };
}

/** Fails the test if called — proves the estimate never displaces a measurement. */
const neverEstimate = () => {
  throw new Error("estimateOutput must not be called when the wire reported outputTokens");
};

describe("applyContextUsage", () => {
  it("records the service percentage verbatim and marks derived input", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 42, CONTEXT_WINDOW);

    expect(usage.contextPercent).toBe(42);
    expect(usage.input).toBe(Math.round(0.42 * CONTEXT_WINDOW));
    expect(usage.provenance?.input).toBe("derived");
  });

  it("keeps a fractional percentage unrounded", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 4.77, CONTEXT_WINDOW);

    expect(usage.contextPercent).toBe(4.77);
  });

  it("still reports the percentage when the context window is unknown", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 30, 0);

    expect(usage.contextPercent).toBe(30);
    expect(usage.input).toBe(0);
    expect(usage.provenance?.input).toBeUndefined();
  });

  it("ignores a non-finite percentage", () => {
    const usage = freshUsage();
    applyContextUsage(usage, Number.NaN, CONTEXT_WINDOW);

    expect(usage.contextPercent).toBeUndefined();
    expect(usage.input).toBe(0);
  });
});

describe("applyMeteringCredits", () => {
  it("records credits and unit without touching token counts", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 3, "credit", "credits");

    expect(usage.credits).toBe(3);
    expect(usage.creditUnit).toBe("credits");
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  it("picks the singular unit for a single credit", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 1, "credit", "credits");

    // Storing unitPlural unconditionally would render "1 credits".
    expect(usage.creditUnit).toBe("credit");
  });

  it("records an explicit zero credit charge", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 0, "credit", "credits");

    expect(usage.credits).toBe(0);
    // Zero takes the plural, as English does.
    expect(usage.creditUnit).toBe("credits");
  });

  it("uses whichever form the event supplied when only one is present", () => {
    const pluralOnly = freshUsage();
    applyMeteringCredits(pluralOnly, 1, undefined, "credits");
    expect(pluralOnly.creditUnit).toBe("credits");

    const singularOnly = freshUsage();
    applyMeteringCredits(singularOnly, 4, "credit", undefined);
    expect(singularOnly.creditUnit).toBe("credit");
  });

  it("leaves credits absent when the event carried none", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, undefined, undefined, undefined);

    expect(usage.credits).toBeUndefined();
    expect(usage.creditUnit).toBeUndefined();
  });

  it("keeps the singular unit when a later frame carries units but no count", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 1, "credit", "credits");
    expect(usage.creditUnit).toBe("credit");

    // Every MeteringEvent field is optional, so a later frame can repeat the unit
    // strings with no `usage` number. Agreement must be decided against the count
    // already recorded, not against this call's absent argument, or the recorded
    // single credit is re-pluralized into "1 credits".
    applyMeteringCredits(usage, undefined, "credit", "credits");

    expect(usage.credits).toBe(1);
    expect(usage.creditUnit).toBe("credit");
  });

  it("repluralizes when a later frame revises the count upward", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 1, "credit", "credits");
    applyMeteringCredits(usage, 4, "credit", "credits");

    expect(usage.credits).toBe(4);
    expect(usage.creditUnit).toBe("credits");
  });

  it("singularizes when the count arrives in a frame after the unit strings", () => {
    const usage = freshUsage();
    // The mirror image of the case above: `MeteringEvent.usage` is optional, so a
    // units-only frame can precede the count. With no count to agree with its
    // choice is provisional, and must be revisited once the count lands —
    // otherwise the provisional plural sticks and renders "1 credits".
    applyMeteringCredits(usage, undefined, "credit", "credits");
    expect(usage.creditUnit).toBe("credits");

    applyMeteringCredits(usage, 1, undefined, undefined);

    expect(usage.credits).toBe(1);
    expect(usage.creditUnit).toBe("credit");
  });

  it("keeps the plural when a later count is not one", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, undefined, "credit", "credits");
    applyMeteringCredits(usage, 6, undefined, undefined);

    expect(usage.creditUnit).toBe("credits");
  });

  it("remembers a single form supplied by an earlier frame", () => {
    const usage = freshUsage();
    // Only the singular was ever sent, so it stays in use whatever the count.
    applyMeteringCredits(usage, undefined, "credit", undefined);
    applyMeteringCredits(usage, 3, undefined, undefined);

    expect(usage.creditUnit).toBe("credit");
  });
});

describe("finalizeKiroUsage", () => {
  it("maps every modeled field onto pi's Usage", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, fullWire(), neverEstimate);

    expect(usage.input).toBe(1_200);
    expect(usage.output).toBe(340);
    expect(usage.cacheRead).toBe(8_000);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.totalTokens).toBe(9_540);
    expect(usage.contextPercent).toBe(4.77);
    expect(usage.normalizedTokenUsage).toBe(12.5);
  });

  it("prefers the wire totalTokens over recomputing it", () => {
    const usage = freshUsage();
    // 1200 + 340 + 8000 + 0 = 9540 would coincide, so use a wire value that cannot
    // be produced by summation — proving the wire figure is the one reported.
    finalizeKiroUsage(usage, { ...fullWire(), totalTokens: 9_999 }, neverEstimate);

    expect(usage.totalTokens).toBe(9_999);
    expect(usage.provenance?.totalTokens).toBe("measured");
  });

  it("lets a measured input overwrite a contextUsage-derived one", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 50, CONTEXT_WINDOW);
    expect(usage.input).toBe(100_000);

    finalizeKiroUsage(usage, { inputTokens: 1_234, outputTokens: 7 }, neverEstimate);

    expect(usage.input).toBe(1_234);
    expect(usage.provenance?.input).toBe("measured");
  });

  it("keeps the derived input when the wire omitted inputTokens", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 25, CONTEXT_WINDOW);

    finalizeKiroUsage(usage, { outputTokens: 11 }, neverEstimate);

    expect(usage.input).toBe(50_000);
    expect(usage.provenance?.input).toBe("derived");
  });

  it("prefers the metadata contextUsagePercentage over an earlier mid-stream one", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 10, CONTEXT_WINDOW);

    finalizeKiroUsage(usage, { contextUsagePercentage: 12.5, outputTokens: 1 }, neverEstimate);

    expect(usage.contextPercent).toBe(12.5);
  });

  it("does not re-derive contextPercent from token counts", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 10, CONTEXT_WINDOW);

    // Metadata reports tokens but no percentage: the mid-stream percentage stands.
    finalizeKiroUsage(usage, { inputTokens: 4, outputTokens: 4, totalTokens: 8 }, neverEstimate);

    expect(usage.contextPercent).toBe(10);
  });

  it("estimates output only when the wire omitted outputTokens", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 500 }, () => 77);

    expect(usage.output).toBe(77);
    expect(usage.provenance?.output).toBe("estimated");
    expect(usage.provenance?.input).toBe("measured");
  });

  it("does not let the estimate displace a measured zero output", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 0 }, neverEstimate);

    expect(usage.output).toBe(0);
    expect(usage.provenance?.output).toBe("measured");
  });

  it("estimates output when there is no metadata event at all", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, null, () => 42);

    expect(usage.output).toBe(42);
    expect(usage.totalTokens).toBe(42);
    expect(usage.provenance?.output).toBe("estimated");
  });

  it("leaves cache provenance absent when the turn reported no cache fields", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, neverEstimate);

    // The zeros are placeholders required by pi's Usage type, NOT a measured
    // 0% cache hit rate. Absent provenance is what makes the two separable.
    expect(usage.cacheRead).toBe(0);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.provenance?.cache).toBeUndefined();
  });

  it("marks a genuine zero cache hit as measured", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 }, neverEstimate);

    expect(usage.cacheRead).toBe(0);
    expect(usage.provenance?.cache).toBe("measured");
  });

  it("defaults the missing half of a partial cache report to zero", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 5, cacheWriteInputTokens: 2_048 }, neverEstimate);

    expect(usage.cacheWrite).toBe(2_048);
    expect(usage.cacheRead).toBe(0);
    expect(usage.provenance?.cache).toBe("measured");
  });

  it("adds the cache legs back in when recomputing a missing total", () => {
    const usage = freshUsage();
    // The wire's input is the UNCACHED slice, so a total of input+output alone
    // would under-report this turn by the 8000 cache-read tokens.
    finalizeKiroUsage(
      usage,
      { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 8_000, cacheWriteInputTokens: 10 },
      neverEstimate,
    );

    expect(usage.totalTokens).toBe(8_160);
  });

  it("normalizes a derived input against measured cache legs instead of double-counting", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 10, CONTEXT_WINDOW);
    expect(usage.input).toBe(20_000);

    // Cache counts arrive but uncachedInputTokens does not. The derived input
    // spans the WHOLE prompt, cached portion included, so the cache legs are
    // subtracted out of it rather than added on top. Otherwise the 8000 cached
    // tokens are counted twice — in totalTokens and, worse, in cost, since
    // calculateCost prices input and cacheRead as separate lines.
    finalizeKiroUsage(usage, { outputTokens: 50, cacheReadInputTokens: 8_000 }, neverEstimate);

    expect(usage.cacheRead).toBe(8_000);
    expect(usage.provenance?.cache).toBe("measured");
    expect(usage.input).toBe(12_000);
    // The three prompt slots no longer overlap, so cost is charged once per
    // cached token: 12000 back to the derived figure of 20000.
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(20_000);
    // The recomputed total is 20050, and it is knowingly imprecise: the 20000 it
    // builds on was back-computed from contextUsagePercentage, which the service
    // derives from totalTokens — output tokens included. So those 50 output
    // tokens are counted twice here. Unavoidable without a measured input, and
    // marked "estimated" for exactly that reason. Only reachable when the wire
    // omitted the required totalTokens field.
    expect(usage.totalTokens).toBe(20_050);
    expect(usage.provenance?.totalTokens).toBe("estimated");
  });

  it("floors a normalized derived input at zero when the cache legs exceed it", () => {
    const usage = freshUsage();
    // 1% of 200k = 2000, under the reported 8000 cache-read tokens. The derived
    // figure is a rounded back-computation, so this is reachable.
    applyContextUsage(usage, 1, CONTEXT_WINDOW);

    finalizeKiroUsage(usage, { outputTokens: 5, cacheReadInputTokens: 8_000 }, neverEstimate);

    expect(usage.input).toBe(0);
    expect(usage.cacheRead).toBe(8_000);
    expect(usage.totalTokens).toBe(8_005);
  });

  it("does not normalize a measured input against the cache legs", () => {
    const usage = freshUsage();
    applyContextUsage(usage, 10, CONTEXT_WINDOW);

    // uncachedInputTokens IS the uncached slice, so it already excludes the cache
    // legs and must be left alone.
    finalizeKiroUsage(usage, { inputTokens: 1_200, outputTokens: 50, cacheReadInputTokens: 8_000 }, neverEstimate);

    expect(usage.input).toBe(1_200);
    expect(usage.totalTokens).toBe(9_250);
  });

  it("marks a recomputed total estimated when output was estimated", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 100 }, () => 50);

    expect(usage.totalTokens).toBe(150);
    expect(usage.provenance?.totalTokens).toBe("estimated");
  });

  it("marks a recomputed total derived when both legs were measured", () => {
    const usage = freshUsage();
    finalizeKiroUsage(usage, { inputTokens: 100, outputTokens: 50 }, neverEstimate);

    expect(usage.provenance?.totalTokens).toBe("derived");
  });

  it("ignores negative and non-finite counts rather than reporting them", () => {
    const usage = freshUsage();
    finalizeKiroUsage(
      usage,
      {
        inputTokens: -5,
        outputTokens: Number.NaN,
        totalTokens: Number.POSITIVE_INFINITY,
        cacheReadInputTokens: -1,
      },
      () => 9,
    );

    expect(usage.input).toBe(0);
    expect(usage.provenance?.input).toBeUndefined();
    expect(usage.output).toBe(9);
    expect(usage.cacheRead).toBe(0);
    expect(usage.provenance?.cache).toBeUndefined();
    expect(usage.totalTokens).toBe(9);
  });

  it("carries normalizedTokenUsage and metering credits together", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 2, "credit", "credits");
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 5, normalizedTokenUsage: 0.25 }, neverEstimate);

    // Credits (MeteringEvent) and normalizedTokenUsage (TokenUsage) are the two
    // actual billing units; neither may leak into the token counts.
    expect(usage.credits).toBe(2);
    expect(usage.normalizedTokenUsage).toBe(0.25);
    expect(usage.totalTokens).toBe(15);
  });
});

describe("resetKiroUsage", () => {
  it("clears everything one attempt reported, cost included", () => {
    const usage = freshUsage();
    usage.cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
    applyContextUsage(usage, 50, CONTEXT_WINDOW);
    applyMeteringCredits(usage, 7, "credit", "credits");
    finalizeKiroUsage(usage, fullWire(), neverEstimate);

    resetKiroUsage(usage);

    expect(usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      // Cost is derived wholly from the counts above, so leaving it behind would
      // leave the one figure nothing backs. A successful retry recomputes it;
      // an attempt that never gets that far must not report the previous
      // attempt's charge against these zeros.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("clears the retained unit forms so a later count cannot revive them", () => {
    const usage = freshUsage();
    applyMeteringCredits(usage, 4, "credit", "credits");

    resetKiroUsage(usage);
    // A retry that reports only a count must not inherit the previous attempt's
    // unit strings.
    applyMeteringCredits(usage, 1, undefined, undefined);

    expect(usage.credits).toBe(1);
    expect(usage.creditUnit).toBeUndefined();
    expect(usage.creditUnitForms).toBeUndefined();
  });

  it("leaves no priced cost behind when the next attempt reports nothing", () => {
    const usage = freshUsage();
    // The empty-response/echo-loop retry is decided AFTER the turn has been
    // finalized and priced, so a degenerate-but-priced attempt reaches here with
    // a real charge on `cost`. If the retry then fails terminally, the errored
    // turn is emitted with these zeroed counts — and must not still carry the
    // abandoned attempt's charge.
    finalizeKiroUsage(usage, fullWire(), neverEstimate);
    usage.cost = { input: 0.3, output: 0.75, cacheRead: 0.0024, cacheWrite: 0, total: 1.0524 };

    resetKiroUsage(usage);

    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect(usage.totalTokens).toBe(0);
  });

  it("stops a failed attempt's cache counts leaking into a clean retry", () => {
    const usage = freshUsage();
    // Attempt 1: cache-warm turn, then the stream fails and is retried.
    finalizeKiroUsage(usage, fullWire(), neverEstimate);
    applyMeteringCredits(usage, 9, "credit", "credits");
    expect(usage.cacheRead).toBe(8_000);

    resetKiroUsage(usage);

    // Attempt 2 reports no cache fields and no credits at all.
    finalizeKiroUsage(usage, { inputTokens: 10, outputTokens: 5 }, neverEstimate);

    expect(usage.cacheRead).toBe(0);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.provenance?.cache).toBeUndefined();
    expect(usage.credits).toBeUndefined();
    expect(usage.normalizedTokenUsage).toBeUndefined();
    // Critically, the stale 8000 cache-read tokens are not summed into this total.
    expect(usage.totalTokens).toBe(15);
  });
});
