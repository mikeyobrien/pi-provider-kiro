// ABOUTME: Tests for the per-turn provenance diagnostic shape.
// ABOUTME: Pins the stable type string a host matches on and the absent-vs-null contract.

import { describe, expect, it } from "vitest";
import {
  createKiroTurnProvenanceDiagnostic,
  KIRO_TURN_PROVENANCE_DIAGNOSTIC,
  type KiroUsageProvenance,
} from "../src/diagnostics.js";

const measured: KiroUsageProvenance = {
  input: "measured",
  output: "measured",
  totalTokens: "measured",
  cache: "measured",
};

function make(usage: KiroUsageProvenance = {}) {
  return createKiroTurnProvenanceDiagnostic({ usage });
}

describe("createKiroTurnProvenanceDiagnostic", () => {
  it("uses the stable type string a host matches on", () => {
    // Hard-coded on purpose: renaming the constant must not silently change the
    // wire-visible value a consumer keys off.
    expect(KIRO_TURN_PROVENANCE_DIAGNOSTIC).toBe("kiro_turn_provenance");
    expect(make().type).toBe("kiro_turn_provenance");
  });

  it("stays distinct from the error diagnostic type", () => {
    expect(make().type).not.toBe("kiro_api_error");
  });

  it("carries no error field on a successful turn", () => {
    // pi-ai's createAssistantMessageDiagnostic would synthesize
    // { name: "ThrownValue", message: "undefined" } here.
    const d = make();
    expect(d.error).toBeUndefined();
    expect("error" in d).toBe(false);
  });

  it("records a numeric timestamp", () => {
    expect(typeof make().timestamp).toBe("number");
  });

  it("passes through the usage provenance verbatim rather than reclassifying", () => {
    // The write sites in streamKiro own the measured/derived/estimated decision;
    // a second classifier here could disagree with the numbers it describes.
    expect(make(measured).details).toEqual({ usage: measured });
  });

  it("preserves an absent cache leg so a real 0% stays distinguishable", () => {
    const partial: KiroUsageProvenance = { input: "measured", output: "estimated" };
    const usage = make(partial).details?.usage as KiroUsageProvenance;
    expect(usage.cache).toBeUndefined();
    expect("cache" in usage).toBe(false);
  });

  it("snapshots the usage provenance instead of aliasing the caller's object", () => {
    // The object handed in is the provider's mutable per-attempt accumulator. A
    // shared reference would let a later write rewrite what this record claims
    // about a turn that already finished.
    const live: KiroUsageProvenance = { input: "measured", output: "estimated" };
    const d = make(live);
    expect(d.details?.usage).not.toBe(live);
    expect(d.details?.usage).toEqual(live);

    live.input = "derived";
    live.cache = "measured";
    expect(d.details?.usage).toEqual({ input: "measured", output: "estimated" });
  });
});
