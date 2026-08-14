// ABOUTME: Tests for the per-turn provenance diagnostic shape and stop-reason recording.
// ABOUTME: Pins the type string kermes matches on and the absent-vs-null contract.

import { describe, expect, it } from "vitest";
import {
  createKiroTurnProvenanceDiagnostic,
  isModeledContextOverflowStopReason,
  KIRO_MODELED_STOP_REASONS,
  KIRO_TURN_PROVENANCE_DIAGNOSTIC,
  mapModeledStopReason,
} from "../src/diagnostics.js";
import type { KiroUsageProvenance } from "../src/token-usage.js";

const measured: KiroUsageProvenance = {
  input: "measured",
  output: "measured",
  totalTokens: "measured",
  cache: "measured",
};

function make(overrides: Partial<Parameters<typeof createKiroTurnProvenanceDiagnostic>[0]> = {}) {
  return createKiroTurnProvenanceDiagnostic({
    stopReason: "stop",
    stopReasonSource: "inferred",
    ...overrides,
  });
}

describe("createKiroTurnProvenanceDiagnostic", () => {
  it("uses the stable type string kermes matches on", () => {
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
    // finalizeKiroUsage owns the measured/derived/estimated precedence; a second
    // classifier here could disagree with the numbers it describes.
    expect(make({ usage: measured }).details?.usage).toEqual(measured);
  });

  it("preserves an absent cache leg so a real 0% stays distinguishable", () => {
    const partial: KiroUsageProvenance = { input: "measured", output: "estimated" };
    const usage = make({ usage: partial }).details?.usage as KiroUsageProvenance;
    expect(usage.cache).toBeUndefined();
    expect("cache" in usage).toBe(false);
  });

  it("omits usage entirely when the turn recorded no provenance", () => {
    expect("usage" in (make().details ?? {})).toBe(false);
  });

  it("snapshots the usage provenance instead of aliasing the caller's object", () => {
    // The object handed in lives on `usage.provenance`, elsewhere on the same
    // message. A shared reference would let a later write rewrite what this
    // record claims about a turn that already finished.
    const live: KiroUsageProvenance = { input: "measured", output: "estimated" };
    const d = make({ usage: live });
    expect(d.details?.usage).not.toBe(live);
    expect(d.details?.usage).toEqual(live);

    live.input = "derived";
    live.cache = "measured";
    expect(d.details?.usage).toEqual({ input: "measured", output: "estimated" });
  });

  it("reports the emitted stop reason with the source the caller supplied", () => {
    expect(make({ stopReason: "toolUse", stopReasonSource: "inferred" }).details?.stopReason).toEqual({
      emitted: "toolUse",
      source: "inferred",
    });
  });

  it("does not upgrade source to modeled just because a modeled value arrived", () => {
    // The service can report a stop reason the emitted value does not follow.
    // Reading presence as authorship would label a local guess as measured.
    const d = make({ stopReason: "stop", stopReasonSource: "inferred", rawStopReason: "END_TURN" });
    const stopReason = d.details?.stopReason as Record<string, unknown>;
    expect(stopReason.source).toBe("inferred");
    expect(stopReason.modeled).toBe("END_TURN");
  });

  it("records source as modeled when the caller says the emitted value followed the wire", () => {
    const d = make({ stopReason: "stop", stopReasonSource: "modeled", rawStopReason: "END_TURN" });
    expect((d.details?.stopReason as Record<string, unknown>).source).toBe("modeled");
  });

  it("passes stopDetails through verbatim", () => {
    const details = { reason: "something", nested: { a: 1 } };
    const d = make({ rawStopReason: "END_TURN", stopDetails: details });
    expect((d.details?.stopReason as Record<string, unknown>).details).toEqual(details);
  });

  it("omits modeled and details rather than nulling them when absent", () => {
    const stopReason = make().details?.stopReason as Record<string, unknown>;
    expect("modeled" in stopReason).toBe(false);
    expect("details" in stopReason).toBe(false);
    expect("contextOverflow" in stopReason).toBe(false);
  });

  it("flags a context overflow that arrived as a successful stop reason", () => {
    // MODEL_CONTEXT_WINDOW_EXCEEDED rides a 200 with no error body, so the
    // prose-matching isContextOverflow() path never sees it. Without this flag
    // the turn looks like a normal early completion.
    const d = make({
      stopReason: "stop",
      rawStopReason: KIRO_MODELED_STOP_REASONS.contextWindowExceeded,
    });
    const stopReason = d.details?.stopReason as Record<string, unknown>;
    expect(stopReason.contextOverflow).toBe(true);
    expect(stopReason.emitted).toBe("stop");
  });

  it("does not flag overflow for other modeled stop reasons", () => {
    for (const raw of Object.values(KIRO_MODELED_STOP_REASONS)) {
      if (raw === KIRO_MODELED_STOP_REASONS.contextWindowExceeded) continue;
      const stopReason = make({ rawStopReason: raw }).details?.stopReason as Record<string, unknown>;
      expect(stopReason.contextOverflow).toBeUndefined();
    }
  });

  it("names the complete wire stop-reason vocabulary", () => {
    // Exhaustive by intent: a consumer is told to match `modeled` against these
    // members rather than write the strings itself, so a missing member forces a
    // hand-written literal. None is reliably recoverable from the emitted value:
    // the overflow and CONTENT_FILTERED ride *successful* metadataEvents no error
    // path sees; MAX_TOKENS is emitted as "stop" rather than pi's "length";
    // UNKNOWN must stay distinct from no modeled value arriving; END_TURN is
    // emitted as "length" when no contextUsage frame arrives; and TOOL_USE is
    // emitted as "stop" when every tool call was dropped as unparseable.
    // Source of truth: StopReason in KiroRuntimeServiceModel tokenTypes.smithy.
    expect(KIRO_MODELED_STOP_REASONS).toEqual({
      contextWindowExceeded: "MODEL_CONTEXT_WINDOW_EXCEEDED",
      contentFiltered: "CONTENT_FILTERED",
      pauseTurn: "PAUSE_TURN",
      maxTokens: "MAX_TOKENS",
      unknown: "UNKNOWN",
      endTurn: "END_TURN",
      toolUse: "TOOL_USE",
    });
  });

  it("carries a refusal's stopDetails through, since it rides a successful turn", () => {
    const refusal = { refusal: { category: "CYBER", explanation: "no", recommendedModel: "other" } };
    const d = make({
      stopReason: "stop",
      rawStopReason: KIRO_MODELED_STOP_REASONS.contentFiltered,
      stopDetails: refusal,
    });
    const stopReason = d.details?.stopReason as Record<string, unknown>;
    expect(stopReason.modeled).toBe("CONTENT_FILTERED");
    expect(stopReason.details).toEqual(refusal);
    // A refusal is not an overflow; only the overflow gets the compaction flag.
    expect(stopReason.contextOverflow).toBeUndefined();
  });

  it("carries PAUSE_TURN through even though this peer has no stopReason for it", () => {
    // Wire origin of pi 0.83.0's "pending". Recording it keeps the distinction
    // available before the peer gains a slot for it.
    const d = make({ stopReason: "stop", rawStopReason: KIRO_MODELED_STOP_REASONS.pauseTurn });
    expect((d.details?.stopReason as Record<string, unknown>).modeled).toBe("PAUSE_TURN");
  });

  it("survives a JSON round-trip so it persists with the session", () => {
    const d = make({
      usage: measured,
      stopReason: "toolUse",
      rawStopReason: "TOOL_USE",
      stopDetails: { note: "x" },
    });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe("isModeledContextOverflowStopReason", () => {
  it("recognizes the overflow stop reason", () => {
    expect(isModeledContextOverflowStopReason("MODEL_CONTEXT_WINDOW_EXCEEDED")).toBe(true);
    expect(isModeledContextOverflowStopReason(KIRO_MODELED_STOP_REASONS.contextWindowExceeded)).toBe(true);
  });

  it("rejects other stop reasons and an absent one", () => {
    for (const raw of ["END_TURN", "MAX_TOKENS", "PAUSE_TURN", undefined]) {
      expect(isModeledContextOverflowStopReason(raw)).toBe(false);
    }
  });
});

describe("mapModeledStopReason", () => {
  it("maps the three members pi has a faithful slot for", () => {
    expect(mapModeledStopReason(KIRO_MODELED_STOP_REASONS.endTurn)).toBe("stop");
    expect(mapModeledStopReason(KIRO_MODELED_STOP_REASONS.toolUse)).toBe("toolUse");
    expect(mapModeledStopReason(KIRO_MODELED_STOP_REASONS.maxTokens)).toBe("length");
  });

  it("declines the members this peer cannot express", () => {
    // Returning undefined is load-bearing: it is what keeps the caller reporting
    // `source: "inferred"` instead of passing off a local decision as modeled.
    for (const member of [
      KIRO_MODELED_STOP_REASONS.contentFiltered,
      KIRO_MODELED_STOP_REASONS.pauseTurn,
      KIRO_MODELED_STOP_REASONS.unknown,
    ]) {
      expect(mapModeledStopReason(member)).toBeUndefined();
    }
  });

  it("declines the overflow member so it cannot invite a continuation", () => {
    // "length" would reach wasPreviousResponseTruncated() and ask the model to
    // continue, growing the context that just overflowed.
    expect(mapModeledStopReason(KIRO_MODELED_STOP_REASONS.contextWindowExceeded)).toBeUndefined();
  });

  it("declines an absent or unrecognized stop reason", () => {
    expect(mapModeledStopReason(undefined)).toBeUndefined();
    expect(mapModeledStopReason("")).toBeUndefined();
    expect(mapModeledStopReason("SOMETHING_NEW")).toBeUndefined();
    // Lowercase is not the wire spelling; accepting it would invent a mapping.
    expect(mapModeledStopReason("end_turn")).toBeUndefined();
  });

  it("only ever returns a member of pi's vocabulary", () => {
    const piVocabulary = ["stop", "length", "toolUse", "error", "aborted"];
    for (const member of Object.values(KIRO_MODELED_STOP_REASONS)) {
      const mapped = mapModeledStopReason(member);
      if (mapped !== undefined) expect(piVocabulary).toContain(mapped);
    }
  });

  it("never maps a member onto error or aborted", () => {
    // Both describe a turn that failed or was cancelled. Every modeled stop
    // reason arrives on a 200 with content already streamed, so routing one
    // there would turn a completed turn into a failed one.
    for (const member of Object.values(KIRO_MODELED_STOP_REASONS)) {
      expect(["error", "aborted"]).not.toContain(mapModeledStopReason(member));
    }
  });
});
