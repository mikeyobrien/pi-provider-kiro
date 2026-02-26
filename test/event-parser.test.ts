import { describe, expect, it } from "vitest";
import { findJsonEnd, parseKiroEvent, parseKiroEvents } from "../src/event-parser.js";

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

  describe("parseKiroEvents", () => {
    it("parses single event", () => {
      const { events, remaining } = parseKiroEvents('{"content":"hello"}');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "content", data: "hello" });
      expect(remaining).toBe("");
    });

    it("parses multiple events in one chunk", () => {
      const { events } = parseKiroEvents('{"content":"a"}{"content":"b"}{"content":"c"}');
      expect(events).toHaveLength(3);
    });

    it("returns remaining for incomplete JSON", () => {
      const { events, remaining } = parseKiroEvents('{"content":"done"}{"content":"incomp');
      expect(events).toHaveLength(1);
      expect(remaining).toContain("incomp");
    });

    it("handles mixed event types", () => {
      const buf = '{"content":"hi"}{"name":"bash","toolUseId":"t1","input":"{}"}{"contextUsagePercentage":50}';
      const { events } = parseKiroEvents(buf);
      expect(events.map((e) => e.type)).toEqual(["content", "toolUse", "contextUsage"]);
    });

    it("skips garbage between events", () => {
      const { events } = parseKiroEvents('garbage{"content":"hi"}more');
      expect(events).toHaveLength(1);
    });

    it("returns empty for empty buffer", () => {
      const { events } = parseKiroEvents("");
      expect(events).toHaveLength(0);
    });

    it("parses JSON events with keys in non-standard order", () => {
      const buf = '{"toolUseId":"tc1","name":"write","input":"{\\"path\\":\\"f.txt\\"}","stop":true}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("toolUse");
      expect(events[0].type === "toolUse" && events[0].data.name).toBe("write");
      expect(events[0].type === "toolUse" && events[0].data.toolUseId).toBe("tc1");
    });

    it("skips events where known key is not the first key", () => {
      // Pattern-based search requires known keys to be first (matching Kiro API behavior)
      const buf = '{"timestamp":123,"content":"hello"}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(0);
    });

    it("parses stop event when toolUseId is the first key", () => {
      const buf = '{"toolUseId":"tc1","stop":true}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "toolUseStop", data: { stop: true } });
    });

    it("handles multiple events with standard key orders", () => {
      const buf =
        '{"content":"hi"}{"toolUseId":"tc1","name":"bash","input":"{}","stop":true}{"contextUsagePercentage":50}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.type)).toEqual(["content", "toolUse", "contextUsage"]);
    });

    it("parses followupPrompt event in stream", () => {
      const buf = '{"content":"hi"}{"followupPrompt":"Next?"}{"contextUsagePercentage":10}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(3);
      expect(events[1]).toEqual({ type: "followupPrompt", data: "Next?" });
    });

    it("parses usage event in stream", () => {
      const buf = '{"content":"hi"}{"usage":{"inputTokens":200,"outputTokens":80}}{"contextUsagePercentage":10}';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(3);
      expect(events[1].type).toBe("usage");
    });

    it("followupPrompt and usage events don't interfere with other events", () => {
      const buf = '{"followupPrompt":"Next?"}{"usage":{"inputTokens":1}}{"content":"hi"}';
      const { events } = parseKiroEvents(buf);
      expect(events.map((e) => e.type)).toEqual(["followupPrompt", "usage", "content"]);
    });

    it("ignores stray braces in binary stream framing", () => {
      // Simulates Kiro's binary event framing which contains stray '{' before JSON
      const buf = '\x00\x83{   \\9:event-type assistantResponseEvent{"content":"hello"}\x00\x84';
      const { events, remaining } = parseKiroEvents(buf);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "content", data: "hello" });
      expect(remaining).toBe("");
    });

    it("handles multiple events with binary framing between them", () => {
      const buf = '\x00{  framing{"content":"a"}\x00{  framing{"content":"b"}\x00';
      const { events } = parseKiroEvents(buf);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "content", data: "a" });
      expect(events[1]).toEqual({ type: "content", data: "b" });
    });
  });
});
