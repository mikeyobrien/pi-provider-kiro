import { describe, expect, it } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import { parseKiroEvent } from "../src/event-parser.js";

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

  describe("parseKiroEvent", () => {
    it("parses content event", () => {
      expect(parseKiroEvent({ content: "Hello " })).toEqual({ type: "content", data: "Hello " });
    });

    it("parses toolUse event", () => {
      const e = parseKiroEvent({ name: "bash", toolUseId: "tc1", input: '{"cmd":"ls"}' });
      expect(e?.type).toBe("toolUse");
      expect(e?.type === "toolUse" && e.data.name).toBe("bash");
    });

    it("parses toolUse with stop", () => {
      const e = parseKiroEvent({ name: "bash", toolUseId: "tc1", input: "", stop: true });
      expect(e?.type === "toolUse" && e.data.stop).toBe(true);
    });

    it("parses toolUseInput", () => {
      expect(parseKiroEvent({ input: '"ls"}' })).toEqual({ type: "toolUseInput", data: { input: '"ls"}' } });
    });

    it("parses toolUseStop", () => {
      expect(parseKiroEvent({ stop: true })).toEqual({ type: "toolUseStop", data: { stop: true } });
    });

    it("parses contextUsage", () => {
      expect(parseKiroEvent({ contextUsagePercentage: 42.5 })).toEqual({
        type: "contextUsage",
        data: { contextUsagePercentage: 42.5 },
      });
    });

    it("parses followupPrompt event", () => {
      const e = parseKiroEvent({ followupPrompt: "What would you like to do next?" });
      expect(e).toEqual({ type: "followupPrompt", data: "What would you like to do next?" });
    });

    it("parses usage event", () => {
      const e = parseKiroEvent({ usage: { inputTokens: 100, outputTokens: 50 } });
      expect(e?.type).toBe("usage");
      expect(e?.type === "usage" && e.data.inputTokens).toBe(100);
      expect(e?.type === "usage" && e.data.outputTokens).toBe(50);
    });

    it("returns null for unrecognized shape", () => {
      expect(parseKiroEvent({ unknown: true })).toBeNull();
    });

    it("treats empty object input as empty string for toolUse placeholder", () => {
      const e = parseKiroEvent({ name: "write", toolUseId: "tc1", input: {} });
      expect(e?.type).toBe("toolUse");
      // Empty object placeholder must become "" so toolUseInput concatenation works
      expect(e?.type === "toolUse" && e.data.input).toBe("");
    });

    it("preserves non-empty object input as JSON string", () => {
      const e = parseKiroEvent({ name: "bash", toolUseId: "tc1", input: { cmd: "ls" } });
      expect(e?.type).toBe("toolUse");
      expect(e?.type === "toolUse" && e.data.input).toBe('{"cmd":"ls"}');
    });
  });
});
