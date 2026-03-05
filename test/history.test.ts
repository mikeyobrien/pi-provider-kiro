import { describe, expect, it } from "vitest";
import {
  addPlaceholderTools,
  extractToolNamesFromHistory,
  HISTORY_LIMIT,
  historyByteBudget,
  injectSyntheticToolCalls,
  sanitizeHistory,
  truncateHistory,
} from "../src/history.js";
import type { KiroHistoryEntry, KiroToolResult, KiroToolSpec, KiroToolUse } from "../src/transform.js";

const userEntry = (content: string, toolResults?: KiroToolResult[]): KiroHistoryEntry => ({
  userInputMessage: {
    content,
    modelId: "M",
    origin: "AI_EDITOR",
    ...(toolResults ? { userInputMessageContext: { toolResults } } : {}),
  },
});

const assistantEntry = (content: string, toolUses?: KiroToolUse[]): KiroHistoryEntry => ({
  assistantResponseMessage: { content, ...(toolUses ? { toolUses } : {}) },
});

const toolSpec = (name: string): KiroToolSpec => ({
  toolSpecification: { name, description: "d", inputSchema: { json: { type: "object", properties: {} } } },
});

describe("Feature 6: History Management", () => {
  describe("sanitizeHistory", () => {
    it("keeps well-formed user→assistant pairs", () => {
      const h = [userEntry("hi"), assistantEntry("hello")];
      expect(sanitizeHistory(h)).toHaveLength(2);
    });

    it("drops assistant toolUses without following toolResult", () => {
      const h = [
        userEntry("go"),
        assistantEntry("ok", [{ name: "bash", toolUseId: "tc1", input: {} }]),
        userEntry("next"),
      ];
      const r = sanitizeHistory(h);
      expect(r.find((e) => e.assistantResponseMessage?.toolUses)).toBeUndefined();
    });

    it("keeps assistant toolUses when followed by toolResult", () => {
      const h = [
        userEntry("go"),
        assistantEntry("ok", [{ name: "bash", toolUseId: "tc1", input: {} }]),
        userEntry("results", [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" }]),
      ];
      expect(sanitizeHistory(h)).toHaveLength(3);
    });

    it("drops orphaned toolResult without preceding toolUses", () => {
      const h = [userEntry("results", [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" }])];
      expect(sanitizeHistory(h)).toHaveLength(0);
    });

    it("ensures first entry is a userInputMessage", () => {
      const h = [assistantEntry("stale"), userEntry("hi")];
      const r = sanitizeHistory(h);
      if (r.length > 0) expect(r[0].userInputMessage).toBeDefined();
    });

    it("drops assistant messages with empty content and no tool uses (API error entries)", () => {
      const errorEntry = { assistantResponseMessage: { content: "" } };
      const h = [userEntry("hi"), errorEntry, userEntry("continue")];
      const r = sanitizeHistory(h);
      expect(r.find((e) => e.assistantResponseMessage?.content === "")).toBeUndefined();
    });

    it("drops assistant messages with undefined content and no tool uses", () => {
      const errorEntry: KiroHistoryEntry = { assistantResponseMessage: { content: "" } };
      const h = [userEntry("hi"), errorEntry, userEntry("continue")];
      const r = sanitizeHistory(h);
      expect(
        r.find(
          (e) =>
            e.assistantResponseMessage && !e.assistantResponseMessage.toolUses && !e.assistantResponseMessage.content,
        ),
      ).toBeUndefined();
    });
  });

  describe("injectSyntheticToolCalls", () => {
    it("injects synthetic assistant entry for orphaned tool results", () => {
      const h = [userEntry("results", [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" }])];
      const r = injectSyntheticToolCalls(h);
      const synthetic = r.find((e) =>
        e.assistantResponseMessage?.toolUses?.some((t: KiroToolUse) => t.name === "unknown_tool"),
      );
      expect(synthetic).toBeDefined();
    });

    it("does not inject when tool calls already exist", () => {
      const h = [
        assistantEntry("ok", [{ name: "bash", toolUseId: "tc1", input: {} }]),
        userEntry("results", [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" }]),
      ];
      const r = injectSyntheticToolCalls(h);
      expect(
        r.find((e) => e.assistantResponseMessage?.toolUses?.some((t: KiroToolUse) => t.name === "unknown_tool")),
      ).toBeUndefined();
    });
  });

  describe("truncateHistory", () => {
    it("returns history unchanged if under limit", () => {
      const h = [userEntry("hi"), assistantEntry("hello")];
      expect(truncateHistory(h, HISTORY_LIMIT)).toHaveLength(2);
    });

    it("removes oldest entries when over limit", () => {
      const big = Array.from({ length: 100 }, (_, _i) => [
        userEntry(`msg ${"x".repeat(10000)}`),
        assistantEntry(`reply ${"y".repeat(10000)}`),
      ]).flat();
      const r = truncateHistory(big, 50000);
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(50000);
      if (r.length > 0) expect(r[0].userInputMessage).toBeDefined();
    });
  });

  describe("extractToolNamesFromHistory", () => {
    it("extracts tool names from assistant entries", () => {
      const h = [
        assistantEntry("ok", [{ name: "bash", toolUseId: "tc1", input: {} }]),
        assistantEntry("ok", [{ name: "read", toolUseId: "tc2", input: {} }]),
      ];
      const names = extractToolNamesFromHistory(h);
      expect(names).toContain("bash");
      expect(names).toContain("read");
    });

    it("returns empty set for no tool uses", () => {
      expect(extractToolNamesFromHistory([userEntry("hi")])).toEqual(new Set());
    });
  });

  describe("addPlaceholderTools", () => {
    it("adds stub for tools referenced in history but not in current tools", () => {
      const tools = [toolSpec("bash")];
      const h = [assistantEntry("ok", [{ name: "old_tool", toolUseId: "tc1", input: {} }])];
      const r = addPlaceholderTools(tools, h);
      expect(r.find((t) => t.toolSpecification.name === "old_tool")).toBeDefined();
      expect(r).toHaveLength(2);
    });

    it("does not duplicate existing tools", () => {
      const tools = [toolSpec("bash")];
      const h = [assistantEntry("ok", [{ name: "bash", toolUseId: "tc1", input: {} }])];
      expect(addPlaceholderTools(tools, h)).toHaveLength(1);
    });

    it("returns tools unchanged when history has no tool uses", () => {
      const tools = [toolSpec("bash")];
      expect(addPlaceholderTools(tools, [userEntry("hi")])).toEqual(tools);
    });
  });

  describe("historyByteBudget", () => {
    it("derives byte budget from context window (70% * 4 bytes/token)", () => {
      expect(historyByteBudget(200000)).toBe(560000);
      expect(historyByteBudget(128000)).toBe(358400);
      expect(historyByteBudget(32000)).toBe(89600);
    });

    it("returns 0 for 0 context window", () => {
      expect(historyByteBudget(0)).toBe(0);
    });
  });
});
