import { describe, expect, it } from "vitest";
import {
  addPlaceholderTools,
  extractToolNamesFromHistory,
  HISTORY_LIMIT,
  injectSyntheticToolCalls,
  sanitizeHistory,
  stripHistoryImages,
  truncateHistory,
} from "../src/history.js";
import type { KiroHistoryEntry, KiroImage, KiroToolResult, KiroToolSpec, KiroToolUse } from "../src/transform.js";

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

    it("strips leading toolResults entry and keeps subsequent valid entries (truncation bug)", () => {
      // Reproduces the 25% context wipe bug: after truncation the first entry is a
      // toolResults user message; the old code returned [] nuking all remaining history.
      const h = [
        userEntry("tool results", [{ toolUseId: "tc1", content: [{ text: "done" }], status: "success" }]),
        userEntry("what time is it?"),
        assistantEntry("It is noon."),
      ];
      const r = sanitizeHistory(h);
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].userInputMessage).toBeDefined();
      expect(r[0].userInputMessage?.userInputMessageContext?.toolResults).toBeUndefined();
    });

    it("strips leading assistant entry and keeps subsequent valid entries", () => {
      // After truncation the first surviving entry may be an assistant message when
      // the paired user message was shifted out.
      const h = [
        assistantEntry("stale assistant"),
        userEntry("new user message"),
        assistantEntry("response"),
      ];
      const r = sanitizeHistory(h);
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].userInputMessage).toBeDefined();
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

  describe("stripHistoryImages", () => {
    it("removes images from user input messages in history", () => {
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: {
            content: "Look at this image",
            modelId: "M",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: "base64data" } }],
          },
        },
        assistantEntry("I see the image"),
      ];
      const stripped = stripHistoryImages(h);
      expect(stripped[0].userInputMessage?.images).toBeUndefined();
      expect(stripped[0].userInputMessage?.content).toBe("Look at this image");
      expect(stripped[1].assistantResponseMessage?.content).toBe("I see the image");
    });

    it("preserves entries without images unchanged", () => {
      const h: KiroHistoryEntry[] = [userEntry("hello"), assistantEntry("hi")];
      const stripped = stripHistoryImages(h);
      expect(stripped).toEqual(h);
    });

    it("removes images from tool result messages in history", () => {
      const h: KiroHistoryEntry[] = [
        userEntry("go"),
        assistantEntry("ok", [{ name: "screenshot", toolUseId: "tc1", input: {} }]),
        {
          userInputMessage: {
            content: "Tool results provided.",
            modelId: "M",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: "screenshot-data" } }],
            userInputMessageContext: {
              toolResults: [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" as const }],
            },
          },
        },
      ];
      const stripped = stripHistoryImages(h);
      expect(stripped[2].userInputMessage?.images).toBeUndefined();
      expect(stripped[2].userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(1);
    });

    it("does not mutate the original history array", () => {
      const images = [{ format: "png", source: { bytes: "data" } }];
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: { content: "hi", modelId: "M", origin: "AI_EDITOR", images },
        },
      ];
      stripHistoryImages(h);
      expect(h[0].userInputMessage?.images).toEqual(images);
    });
  });

  describe("truncateHistory with images", () => {
    it("strips images from history entries during truncation", () => {
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: {
            content: "Look at this",
            modelId: "M",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: "x".repeat(1000) } }],
          },
        },
        assistantEntry("I see it"),
        userEntry("thanks"),
        assistantEntry("welcome"),
      ];
      const result = truncateHistory(h, HISTORY_LIMIT);
      // All image data should be stripped from history
      for (const entry of result) {
        expect(entry.userInputMessage?.images).toBeUndefined();
      }
    });

    it("converges when a single image entry exceeds the limit", () => {
      const hugeImage = "x".repeat(2_000_000); // 2MB base64
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: {
            content: "Look at this huge image",
            modelId: "M",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: hugeImage } }],
          },
        },
        assistantEntry("I analyzed the image"),
        userEntry("what did you see?"),
        assistantEntry("A cat"),
      ];
      const result = truncateHistory(h, HISTORY_LIMIT);
      const resultSize = JSON.stringify(result).length;
      expect(resultSize).toBeLessThanOrEqual(HISTORY_LIMIT);
      // Should still have entries (not wiped out)
      expect(result.length).toBeGreaterThan(0);
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
});
