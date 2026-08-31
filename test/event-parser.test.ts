import { describe, expect, it } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import { parseKiroEvent, parseKiroEventByShape, parseKiroExceptionFrame } from "../src/event-parser.js";

describe("Feature 8: Stream Event Parsing", () => {
  describe("findJsonEnd", () => {
    it("finds end of simple object", () => {
      expect(findJsonEnd('{"content":"hello"}rest', 0)).toBe(18);
    });

    it("handles nested braces", () => {
      expect(findJsonEnd('{"input":{"cmd":"ls"}}rest', 0)).toBe(21);
    });

    it("handles escaped quotes", () => {
      expect(findJsonEnd('{"content":"say \\"hi\\""}rest', 0)).toBe(23);
    });

    it("returns -1 for incomplete JSON", () => {
      expect(findJsonEnd('{"content":"hel', 0)).toBe(-1);
    });

    it("respects start offset", () => {
      expect(findJsonEnd('garbage{"content":"hi"}', 7)).toBe(22);
    });
  });

  describe("parseKiroEvent — modeled key routing", () => {
    it("routes assistantResponseEvent to content", () => {
      expect(parseKiroEvent("assistantResponseEvent", { content: "Hello " })).toEqual({
        type: "content",
        data: "Hello ",
      });
    });

    it("routes reasoningContentEvent text to thinkingText", () => {
      expect(parseKiroEvent("reasoningContentEvent", { text: "Considering options" })).toEqual({
        type: "thinkingText",
        data: "Considering options",
      });
    });

    it("routes reasoningContentEvent signature to thinkingSignature", () => {
      expect(parseKiroEvent("reasoningContentEvent", { signature: "opaque-signature" })).toEqual({
        type: "thinkingSignature",
        data: "opaque-signature",
      });
    });

    it("ignores a reasoningContentEvent carrying only redactedContent", () => {
      expect(parseKiroEvent("reasoningContentEvent", { redactedContent: "encrypted" })).toEqual({
        type: "ignored",
        data: { key: "reasoningContentEvent" },
      });
    });

    it("routes toolUseEvent with name+toolUseId to toolUse", () => {
      const e = parseKiroEvent("toolUseEvent", { name: "bash", toolUseId: "tc1", input: '{"cmd":"ls"}' });
      expect(e?.type).toBe("toolUse");
      expect(e?.type === "toolUse" && e.data.name).toBe("bash");
    });

    it("routes toolUseEvent continuation frames to toolUseInput", () => {
      expect(parseKiroEvent("toolUseEvent", { input: '"ls"}' })).toEqual({
        type: "toolUseInput",
        data: { input: '"ls"}' },
      });
    });

    it("routes toolUseEvent stop frame to toolUseStop", () => {
      expect(parseKiroEvent("toolUseEvent", { stop: true })).toEqual({ type: "toolUseStop", data: { stop: true } });
    });

    it("routes contextUsageEvent to contextUsage", () => {
      expect(parseKiroEvent("contextUsageEvent", { contextUsagePercentage: 42.5 })).toEqual({
        type: "contextUsage",
        data: { contextUsagePercentage: 42.5 },
      });
    });

    it("treats empty object input as empty string for toolUse placeholder", () => {
      const e = parseKiroEvent("toolUseEvent", { name: "write", toolUseId: "tc1", input: {} });
      expect(e?.type).toBe("toolUse");
      // Empty object placeholder must become "" so toolUseInput concatenation works
      expect(e?.type === "toolUse" && e.data.input).toBe("");
    });

    it("preserves non-empty object input as JSON string", () => {
      const e = parseKiroEvent("toolUseEvent", { name: "bash", toolUseId: "tc1", input: { cmd: "ls" } });
      expect(e?.type).toBe("toolUse");
      expect(e?.type === "toolUse" && e.data.input).toBe('{"cmd":"ls"}');
    });

    it("explicitly ignores known members with no consumer", () => {
      for (const key of ["codeReferenceEvent", "documentCitationEvent", "toolResultEvent"]) {
        expect(parseKiroEvent(key, {})).toEqual({ type: "ignored", data: { key } });
      }
    });

    it("returns null for an unrecognized key with an unrecognized payload", () => {
      expect(parseKiroEvent("brandNewEvent", { unknown: true })).toBeNull();
    });

    it("routes an error member delivered under its exception class name", () => {
      // Same dual vocabulary as `:exception-type` (see parseKiroExceptionFrame).
      // On the event-frame path there is no literal case label for the class
      // name, so without the token lookup in `default:` the payload
      // `{message, reason}` matches nothing in the shape ladder and the frame is
      // dropped — the original class loss, one layer over.
      const e = parseKiroEvent("ThrottlingException", {
        message: "Too many requests",
        reason: "INSUFFICIENT_MODEL_CAPACITY",
        retryAfterMilliseconds: 4500,
      });
      expect(e).toEqual({
        type: "error",
        data: {
          error: "ThrottlingException",
          message: "Too many requests",
          kind: "throttling",
          reason: "INSUFFICIENT_MODEL_CAPACITY",
          retryAfterMilliseconds: 4500,
        },
      });
      expect(parseKiroEvent("ServiceUnavailableException", { message: "down" })?.type).toBe("error");
    });
  });

  describe("parseKiroEvent — metadataEvent token usage", () => {
    // MetadataEvent = {tokenUsage?, stopReason?, stopDetails?}; TokenUsage =
    // {uncachedInputTokens, outputTokens, totalTokens, cacheRead..., cacheWrite...,
    // contextUsagePercentage?}. Previously no branch matched this shape at all.
    it("produces a usage event from a modeled metadataEvent frame", () => {
      const e = parseKiroEvent("metadataEvent", {
        tokenUsage: {
          uncachedInputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
          cacheReadInputTokens: 120,
          cacheWriteInputTokens: 30,
          contextUsagePercentage: 12.5,
        },
        stopReason: "END_TURN",
      });
      expect(e).toEqual({
        type: "usage",
        data: {
          inputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
          cacheReadInputTokens: 120,
          cacheWriteInputTokens: 30,
          contextUsagePercentage: 12.5,
          rawStopReason: "END_TURN",
        },
      });
    });

    it("omits absent token fields rather than emitting undefined", () => {
      const e = parseKiroEvent("metadataEvent", { stopReason: "MAX_TOKENS" });
      expect(e).toEqual({ type: "usage", data: { rawStopReason: "MAX_TOKENS" } });
      expect(e?.type === "usage" && Object.keys(e.data)).toEqual(["rawStopReason"]);
    });

    it("passes stopDetails through verbatim", () => {
      const e = parseKiroEvent("metadataEvent", { stopDetails: { refusal: { reason: "POLICY" } } });
      expect(e?.type === "usage" && e.data.stopDetails).toEqual({ refusal: { reason: "POLICY" } });
    });

    it("surfaces normalizedTokenUsage, which is not a raw credit count", () => {
      // TokenUsage.normalizedTokenUsage is MPS-normalized usage derived from
      // credit information. It is modeled alongside the token counts, so it must
      // not be dropped at the boundary, and it must not be confused with
      // MeteringEvent.usage (raw credits).
      const e = parseKiroEvent("metadataEvent", {
        tokenUsage: { uncachedInputTokens: 10, outputTokens: 2, totalTokens: 12, normalizedTokenUsage: 3.5 },
      });
      expect(e).toEqual({
        type: "usage",
        data: { inputTokens: 10, outputTokens: 2, totalTokens: 12, normalizedTokenUsage: 3.5 },
      });
    });

    it("returns null for an empty metadataEvent", () => {
      expect(parseKiroEvent("metadataEvent", {})).toBeNull();
    });
  });

  describe("parseKiroEvent — meteringEvent is credits, not tokens", () => {
    // MeteringEvent = {usage?: number; unit?: string; unitPlural?: string}.
    it("surfaces meteringEvent as a credit count", () => {
      expect(parseKiroEvent("meteringEvent", { usage: 3, unit: "credit", unitPlural: "credits" })).toEqual({
        type: "metering",
        data: { credits: 3, unit: "credit", unitPlural: "credits" },
      });
    });

    it("never reads token fields off the numeric usage value", () => {
      const e = parseKiroEvent("meteringEvent", { usage: 7 });
      expect(e?.type).toBe("metering");
      expect(e?.type === "usage").toBe(false);
    });
  });

  describe("parseKiroEvent — error members keep their modeled class", () => {
    // These four members target @error shapes, so the service frames them as
    // `:message-type: exception` (see parseKiroExceptionFrame). The event-frame
    // branches below exist so a non-conforming server that sends them as
    // ordinary events is classified identically rather than dropped.
    it("classifies the error member as internalServer", () => {
      expect(parseKiroEvent("error", { message: "boom" })).toEqual({
        type: "error",
        data: { error: "InternalServerException", message: "boom", kind: "internalServer" },
      });
    });

    it("classifies throttlingError and preserves retryAfterMilliseconds", () => {
      expect(
        parseKiroEvent("throttlingError", {
          message: "Too many requests",
          reason: "INSUFFICIENT_MODEL_CAPACITY",
          retryAfterMilliseconds: 4500,
        }),
      ).toEqual({
        type: "error",
        data: {
          error: "ThrottlingException",
          message: "Too many requests",
          kind: "throttling",
          reason: "INSUFFICIENT_MODEL_CAPACITY",
          retryAfterMilliseconds: 4500,
        },
      });
    });

    it("classifies validationError and serviceUnavailableError distinctly", () => {
      expect(parseKiroEvent("validationError", { message: "bad input" })?.type === "error").toBe(true);
      const v = parseKiroEvent("validationError", { message: "bad input" });
      expect(v?.type === "error" && v.data.kind).toBe("validation");
      const s = parseKiroEvent("serviceUnavailableError", { message: "down" });
      expect(s?.type === "error" && s.data.kind).toBe("serviceUnavailable");
    });

    it("still accepts the legacy free-form error field", () => {
      const e = parseKiroEvent("error", { error: "ThrottlingException", message: "slow down" });
      expect(e).toEqual({
        type: "error",
        data: { error: "ThrottlingException", message: "slow down", kind: "internalServer" },
      });
    });
  });

  describe("parseKiroExceptionFrame — the real wire framing for error members", () => {
    it("maps every error member to its modeled exception class", () => {
      expect(parseKiroExceptionFrame("error", { message: "boom" })).toEqual({
        error: "InternalServerException",
        message: "boom",
        kind: "internalServer",
      });
      expect(parseKiroExceptionFrame("validationError", { message: "bad" })?.kind).toBe("validation");
      expect(parseKiroExceptionFrame("serviceUnavailableError", { message: "down" })?.kind).toBe("serviceUnavailable");
    });

    it("preserves reason and retryAfterMilliseconds for throttlingError", () => {
      expect(
        parseKiroExceptionFrame("throttlingError", {
          message: "Too many requests",
          reason: "INSUFFICIENT_MODEL_CAPACITY",
          retryAfterMilliseconds: 4500,
        }),
      ).toEqual({
        error: "ThrottlingException",
        message: "Too many requests",
        kind: "throttling",
        reason: "INSUFFICIENT_MODEL_CAPACITY",
        retryAfterMilliseconds: 4500,
      });
    });

    it("returns null for a non-error member so the caller keeps the raw body", () => {
      expect(parseKiroExceptionFrame("metadataEvent", { tokenUsage: {} })).toBeNull();
      expect(parseKiroExceptionFrame("SomeFutureException", { message: "x" })).toBeNull();
    });

    it("accepts the exception CLASS name as the :exception-type token", () => {
      // The service is not required to put the union member name in
      // `:exception-type`. The hand-written bridge in the generated client for
      // this same service accepts either form for all four members
      // (sse-middleware.ts `buildStreamException`), so both are observed
      // vocabulary. Keying only on the member name would classify
      // `ThrottlingException` as `kind: "unknown"` and drop the throttle
      // classification that retry policy depends on.
      expect(
        parseKiroExceptionFrame("ThrottlingException", {
          message: "Too many requests",
          reason: "INSUFFICIENT_MODEL_CAPACITY",
          retryAfterMilliseconds: 4500,
        }),
      ).toEqual({
        error: "ThrottlingException",
        message: "Too many requests",
        kind: "throttling",
        reason: "INSUFFICIENT_MODEL_CAPACITY",
        retryAfterMilliseconds: 4500,
      });
      expect(parseKiroExceptionFrame("InternalServerException", { message: "boom" })?.kind).toBe("internalServer");
      expect(parseKiroExceptionFrame("ValidationException", { message: "bad" })?.kind).toBe("validation");
      expect(parseKiroExceptionFrame("ServiceUnavailableException", { message: "down" })?.kind).toBe(
        "serviceUnavailable",
      );
    });

    it("classifies a header-only exception frame from its token alone", () => {
      // An unreadable body leaves an empty payload; the class still comes from
      // the header, so the member must not degrade to unknown.
      expect(parseKiroExceptionFrame("throttlingError", {})).toEqual({
        error: "ThrottlingException",
        kind: "throttling",
      });
    });

    it("does not treat an Object.prototype key as a modeled member", () => {
      // `:exception-type` is chosen by the service, so the member table must be
      // read by own property. A bare index resolves inherited members, and the
      // resulting truthy hit yields kind/error undefined — the caller then skips
      // its unmodeled-member fallback and loses the name entirely, which is the
      // exact class loss this routing removes.
      for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
        expect(parseKiroExceptionFrame(key, { message: "x" })).toBeNull();
      }
    });
  });

  describe("parseKiroEventByShape — fail-open fallback", () => {
    it("is used for a member name this client does not know yet", () => {
      // The reachable case: the service adds a member, so the frame carries a
      // real `:event-type` this build has never seen. A literal `$unknown`
      // event frame does NOT reach the parser — the Smithy marshaller drops any
      // event frame whose deserialized result has a `$unknown` property, and the
      // deserializer keys its result by the header value.
      expect(parseKiroEvent("brandNewEvent", { content: "hi" })).toEqual({ type: "content", data: "hi" });
    });

    it("recognizes followupPrompt, which has no modeled union member", () => {
      expect(parseKiroEventByShape({ followupPrompt: "What next?" })).toEqual({
        type: "followupPrompt",
        data: "What next?",
      });
    });

    it("recognizes a metadata-shaped payload", () => {
      expect(parseKiroEventByShape({ tokenUsage: { outputTokens: 12 } })).toEqual({
        type: "usage",
        data: { outputTokens: 12 },
      });
    });

    it("treats a numeric usage as metering", () => {
      expect(parseKiroEventByShape({ usage: 2 })).toEqual({ type: "metering", data: { credits: 2 } });
    });

    it("returns null for an unrecognized shape", () => {
      expect(parseKiroEventByShape({ unknown: true })).toBeNull();
    });
  });
});
