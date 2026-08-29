import { describe, expect, it } from "vitest";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  extractToolNamesFromHistory,
  HISTORY_IMAGE_BASE64_LIMIT,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  injectSyntheticToolCalls,
  prepareHistory,
  sanitizeHistory,
  stripHistoryImages,
} from "../src/history.js";
import type { KiroHistoryEntry, KiroToolResult, KiroToolSpec, KiroToolUse } from "../src/transform.js";

const userEntry = (content: string, toolResults?: KiroToolResult[]): KiroHistoryEntry => ({
  userInputMessage: {
    content,
    modelId: "M",
    origin: "KIRO_CLI",
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
      const h = [assistantEntry("stale assistant"), userEntry("new user message"), assistantEntry("response")];
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

  describe("prepareHistory and history budget", () => {
    it("preserves valid history at the limit", () => {
      const h = [userEntry("hi"), assistantEntry("hello")];
      const prepared = prepareHistory(h);
      const size = JSON.stringify(prepared).length;

      expect(prepared).toEqual(h);
      expect(() => assertHistoryWithinLimit(prepared, size)).not.toThrow();
    });

    it("raises overflow instead of dropping a compacted anchor and tool-only suffix", () => {
      const result = (id: string): KiroToolResult => ({
        toolUseId: id,
        content: [{ text: "x".repeat(300) }],
        status: "success",
      });
      // Tool-result carriers ship empty `content` — the payload is toolResults.
      const h = [
        userEntry("SYSTEM PROMPT\n\n<summary>ORIGINAL TASK</summary>"),
        assistantEntry("", [{ name: "read", toolUseId: "tc1", input: {} }]),
        userEntry("", [result("tc1")]),
        assistantEntry("", [{ name: "read", toolUseId: "tc2", input: {} }]),
        userEntry("", [result("tc2")]),
      ];
      const prepared = prepareHistory(h);
      const size = JSON.stringify(prepared).length;

      expect(prepared).toHaveLength(h.length);
      expect(prepared[0].userInputMessage?.content).toContain("ORIGINAL TASK");
      expect(() => assertHistoryWithinLimit(prepared, size - 1)).toThrow(/context_length_exceeded/);
      expect(() => assertHistoryWithinLimit(prepared, size - 1)).toThrow(`${size} chars / ${h.length} entries`);
    });

    it("scales the non-lossy budget with the model context window", () => {
      const entrySize = 10000;
      const count = Math.ceil(HISTORY_LIMIT / entrySize) + 10;
      const prepared = prepareHistory(
        Array.from({ length: count }, (_, i) => [
          userEntry(`msg-${i} ${"x".repeat(entrySize)}`),
          assistantEntry(`reply-${i} ${"y".repeat(entrySize)}`),
        ]).flat(),
      );
      const scaledLimit = Math.floor((1_000_000 / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT);

      expect(() => assertHistoryWithinLimit(prepared, HISTORY_LIMIT)).toThrow(/context_length_exceeded/);
      expect(() => assertHistoryWithinLimit(prepared, scaledLimit)).not.toThrow();
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
    const imageEntry = (content: string, bytes: string): KiroHistoryEntry => ({
      userInputMessage: {
        content,
        modelId: "M",
        origin: "KIRO_CLI",
        images: [{ format: "png", source: { bytes } }],
      },
    });

    it("keeps only the newest image-bearing history entry", () => {
      const h = [imageEntry("old", "old-image"), assistantEntry("old reply"), imageEntry("new", "new-image")];
      const stripped = stripHistoryImages(h);

      expect(stripped[0].userInputMessage?.images).toBeUndefined();
      expect(stripped[0].userInputMessage?.content).toBe("old");
      expect(stripped[2].userInputMessage?.images?.[0]?.source.bytes).toBe("new-image");
    });

    it("preserves entries without images unchanged", () => {
      const h: KiroHistoryEntry[] = [userEntry("hello"), assistantEntry("hi")];
      expect(stripHistoryImages(h)).toEqual(h);
    });

    it("keeps the newest bounded tool-result image and its tool payload", () => {
      const h: KiroHistoryEntry[] = [
        userEntry("go"),
        assistantEntry("ok", [{ name: "screenshot", toolUseId: "tc1", input: {} }]),
        {
          userInputMessage: {
            content: "",
            modelId: "M",
            origin: "KIRO_CLI",
            images: [{ format: "png", source: { bytes: "screenshot-data" } }],
            userInputMessageContext: {
              toolResults: [{ toolUseId: "tc1", content: [{ text: "ok" }], status: "success" as const }],
            },
          },
        },
      ];
      const stripped = stripHistoryImages(h);
      expect(stripped[2].userInputMessage?.images?.[0]?.source.bytes).toBe("screenshot-data");
      expect(stripped[2].userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(1);
    });

    it("drops the newest image set when it exceeds the explicit byte bound", () => {
      const stripped = stripHistoryImages([imageEntry("huge", "x".repeat(HISTORY_IMAGE_BASE64_LIMIT + 1))]);
      expect(stripped[0].userInputMessage?.images).toBeUndefined();
    });

    it("strips every image when the active model is text-only", () => {
      const stripped = stripHistoryImages([imageEntry("old", "old"), imageEntry("new", "new")], false);
      expect(stripped.every((entry) => entry.userInputMessage?.images === undefined)).toBe(true);
    });

    it("does not mutate the original history array", () => {
      const images = [{ format: "png", source: { bytes: "data" } }];
      const h: KiroHistoryEntry[] = [{ userInputMessage: { content: "hi", modelId: "M", origin: "KIRO_CLI", images } }];
      stripHistoryImages(h);
      expect(h[0].userInputMessage?.images).toEqual(images);
    });
  });

  describe("prepareHistory with images", () => {
    it("preserves only the newest bounded image in prepared history", () => {
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: {
            content: "Old image",
            modelId: "M",
            origin: "KIRO_CLI",
            images: [{ format: "png", source: { bytes: "old-image" } }],
          },
        },
        assistantEntry("I saw the old image"),
        {
          userInputMessage: {
            content: "New image",
            modelId: "M",
            origin: "KIRO_CLI",
            images: [{ format: "png", source: { bytes: "new-image" } }],
          },
        },
        assistantEntry("I saw the new image"),
      ];
      const result = prepareHistory(h);
      expect(result[0].userInputMessage?.images).toBeUndefined();
      expect(result[2].userInputMessage?.images?.[0]?.source.bytes).toBe("new-image");
    });

    it("removes a huge image before enforcing the limit", () => {
      const hugeImage = "x".repeat(2_000_000); // 2MB base64
      const h: KiroHistoryEntry[] = [
        {
          userInputMessage: {
            content: "Look at this huge image",
            modelId: "M",
            origin: "KIRO_CLI",
            images: [{ format: "png", source: { bytes: hugeImage } }],
          },
        },
        assistantEntry("I analyzed the image"),
        userEntry("what did you see?"),
        assistantEntry("A cat"),
      ];
      const result = prepareHistory(h);
      const resultSize = JSON.stringify(result).length;
      expect(() => assertHistoryWithinLimit(result, HISTORY_LIMIT)).not.toThrow();
      expect(resultSize).toBeLessThanOrEqual(HISTORY_LIMIT);
      expect(result[0].userInputMessage?.images).toBeUndefined();
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
