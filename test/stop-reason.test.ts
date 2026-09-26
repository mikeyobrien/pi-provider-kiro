// ABOUTME: Tests for the modeled-to-pi stopReason translation.
// ABOUTME: Pins which wire members translate and which are deliberately declined.

import { describe, expect, it } from "vitest";
import { mapModeledStopReason } from "../src/stop-reason.js";

const WIRE_MEMBERS = [
  "CONTENT_FILTERED",
  "END_TURN",
  "MAX_TOKENS",
  "MODEL_CONTEXT_WINDOW_EXCEEDED",
  "PAUSE_TURN",
  "TOOL_USE",
  "UNKNOWN",
] as const;

describe("mapModeledStopReason", () => {
  it("maps the three members pi has a faithful slot for", () => {
    expect(mapModeledStopReason("END_TURN")).toBe("stop");
    expect(mapModeledStopReason("TOOL_USE")).toBe("toolUse");
    expect(mapModeledStopReason("MAX_TOKENS")).toBe("length");
  });

  it("declines the members this peer cannot express", () => {
    // Returning undefined is load-bearing: it is what keeps the caller's
    // fallback from passing off a local decision as the service's statement.
    for (const member of ["CONTENT_FILTERED", "PAUSE_TURN", "UNKNOWN"]) {
      expect(mapModeledStopReason(member)).toBeUndefined();
    }
  });

  it("declines the overflow member so it cannot invite a continuation", () => {
    // "length" would reach wasPreviousResponseTruncated() and send the same
    // already-overflowing context back; the loop would not converge.
    expect(mapModeledStopReason("MODEL_CONTEXT_WINDOW_EXCEEDED")).toBeUndefined();
  });

  it("declines an absent or unrecognized stop reason", () => {
    expect(mapModeledStopReason(undefined)).toBeUndefined();
    expect(mapModeledStopReason("")).toBeUndefined();
    expect(mapModeledStopReason("SOMETHING_NEW")).toBeUndefined();
    // Lowercase is not the wire spelling; accepting it would invent a mapping.
    expect(mapModeledStopReason("end_turn")).toBeUndefined();
  });

  it("does not resolve wire values through the lookup table's prototype", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(mapModeledStopReason(key)).toBeUndefined();
    }
  });

  it("never maps a member onto error or aborted", () => {
    // Both describe a turn that failed or was cancelled. Every modeled stop
    // reason arrives on a 200 with content already streamed, so routing one
    // there would turn a completed turn into a failed one.
    for (const member of WIRE_MEMBERS) {
      expect(["error", "aborted"]).not.toContain(mapModeledStopReason(member));
    }
  });
});
