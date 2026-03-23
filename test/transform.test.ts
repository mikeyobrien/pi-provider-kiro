import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  getContentText,
  normalizeMessages,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  truncate,
} from "../src/transform.js";

const ts = Date.now();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: ts });
const assistant = (text: string, opts?: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "kiro-api",
  provider: "kiro",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp: ts,
  ...opts,
});
const toolResult = (id: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

describe("Feature 5: Message Transformation", () => {
  describe("sanitizeSurrogates", () => {
    it("removes unpaired high surrogate", () => {
      expect(sanitizeSurrogates("a\uD800b")).toBe("ab");
    });
    it("removes unpaired low surrogate", () => {
      expect(sanitizeSurrogates("a\uDC00b")).toBe("ab");
    });
    it("preserves properly paired surrogates (emoji)", () => {
      expect(sanitizeSurrogates("Hello 🙈 World")).toBe("Hello 🙈 World");
    });
    it("leaves normal text unchanged", () => {
      expect(sanitizeSurrogates("hello")).toBe("hello");
    });
  });

  describe("truncate", () => {
    it("returns text unchanged if under limit", () => {
      expect(truncate("short", 100)).toBe("short");
    });
    it("truncates with marker when over limit", () => {
      const r = truncate("a".repeat(100), 50);
      expect(r).toContain("[TRUNCATED]");
      expect(r.length).toBeLessThan(100);
    });
    it("preserves start and end", () => {
      const r = truncate(`START${"x".repeat(100)}END`, 30);
      expect(r).toMatch(/^START/);
      expect(r).toMatch(/END$/);
    });
  });

  describe("normalizeMessages", () => {
    it("filters errored assistant messages", () => {
      const msgs: Message[] = [user("hi"), assistant("oops", { stopReason: "error" }), user("retry")];
      expect(normalizeMessages(msgs)).toHaveLength(2);
    });
    it("filters aborted assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("x", { stopReason: "aborted" })])).toHaveLength(1);
    });
    it("keeps successful assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("ok")])).toHaveLength(2);
    });
  });

  describe("getContentText", () => {
    it("extracts from user string", () => {
      expect(getContentText(user("hello"))).toBe("hello");
    });
    it("extracts from tool result", () => {
      expect(getContentText(toolResult("tc1", "result"))).toBe("result");
    });
    it("extracts from assistant with thinking+text", () => {
      const msg = assistant("");
      msg.content = [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ];
      const text = getContentText(msg);
      expect(text).toContain("hmm");
      expect(text).toContain("answer");
    });
  });

  describe("convertToolsToKiro", () => {
    it("converts pi tools to Kiro specs", () => {
      const tools: Tool[] = [
        {
          name: "bash",
          description: "Run cmd",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ];
      const r = convertToolsToKiro(tools);
      expect(r[0].toolSpecification.name).toBe("bash");
      expect(r[0].toolSpecification.inputSchema.json).toEqual(tools[0].parameters);
    });
  });

  describe("convertImagesToKiro", () => {
    it("converts images with format from mimeType", () => {
      const r = convertImagesToKiro([{ mimeType: "image/png", data: "b64" }]);
      expect(r[0]).toEqual({ format: "png", source: { bytes: "b64" } });
    });
  });

  describe("buildHistory", () => {
    it("returns empty history for single user message", () => {
      const { history } = buildHistory([user("Hello")], "M");
      expect(history).toHaveLength(0);
    });

    it("prepends system prompt to first user message", () => {
      const msgs: Message[] = [user("first"), assistant("reply"), user("second")];
      const { history, systemPrepended } = buildHistory(msgs, "M", "Be helpful");
      expect(systemPrepended).toBe(true);
      expect(history[0].userInputMessage?.content).toMatch(/^Be helpful/);
    });

    it("converts assistant tool calls", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.assistantResponseMessage?.toolUses);
      expect(entry?.assistantResponseMessage?.toolUses?.[0].name).toBe("bash");
    });

    it("batches consecutive tool results", () => {
      const a = assistant("");
      a.content = [
        { type: "toolCall", id: "tc1", name: "a", arguments: {} },
        { type: "toolCall", id: "tc2", name: "b", arguments: {} },
      ];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "r1"), toolResult("tc2", "r2"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      expect(entry?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2);
    });

    it("truncates tool results exceeding limit", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "x".repeat(TOOL_RESULT_LIMIT + 1000)), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      const text = entry?.userInputMessage?.userInputMessageContext?.toolResults?.[0].content[0].text ?? "";
      expect(text).toContain("[TRUNCATED]");
    });
  });
});
