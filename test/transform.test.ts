import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { kiroConversationEntries, validateKiroConversation } from "../src/history-validator.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  getContentText,
  normalizeMessages,
  relocateDisplacedToolResults,
  sanitizeSurrogates,
  stripTopLevelCombinators,
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

    it("strips a top-level anyOf from a tool's input schema but keeps its object body", () => {
      // Mirrors pi's agent_browser_action shape: object body + a 2-member
      // top-level anyOf. Kiro's Claude/Bedrock backend 400s on the top-level
      // combinator (TOOL_SCHEMA_INVALID), so it must be stripped on the wire.
      const tools: Tool[] = [
        {
          name: "agent_browser_action",
          description: "Browse",
          parameters: {
            type: "object",
            properties: { url: { type: "string" }, selector: { type: "string" } },
            required: ["url"],
            anyOf: [{ required: ["url"] }, { required: ["selector"] }],
          } as unknown as Tool["parameters"],
        },
      ];
      const json = convertToolsToKiro(tools)[0].toolSpecification.inputSchema.json;
      expect(json.anyOf).toBeUndefined();
      expect(json.oneOf).toBeUndefined();
      expect(json.allOf).toBeUndefined();
      expect(json.type).toBe("object");
      expect(json.properties).toEqual({ url: { type: "string" }, selector: { type: "string" } });
      expect(json.required).toEqual(["url"]);
    });
  });

  describe("stripTopLevelCombinators", () => {
    it("drops a top-level anyOf but preserves the object body (properties + required)", () => {
      const schema = {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
        anyOf: [{ required: ["a"] }, { required: ["b"] }],
      };
      const out = stripTopLevelCombinators(schema);
      expect(out.anyOf).toBeUndefined();
      expect(out.type).toBe("object");
      expect(out.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
      expect(out.required).toEqual(["a"]);
    });

    it("collapses a pure top-level anyOf to its first object branch", () => {
      const schema = {
        anyOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }, { type: "string" }],
      };
      const out = stripTopLevelCombinators(schema);
      expect(out.anyOf).toBeUndefined();
      expect(out.type).toBe("object");
      expect(out.properties).toEqual({ x: { type: "string" } });
      expect(out.required).toEqual(["x"]);
    });

    it("collapses a pure top-level combinator with no object branch to a permissive object", () => {
      const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
      const out = stripTopLevelCombinators(schema);
      expect(out.oneOf).toBeUndefined();
      expect(out.type).toBe("object");
      expect(out.additionalProperties).toBe(true);
    });

    it("passes a schema with no top-level combinator through unchanged", () => {
      const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
      const out = stripTopLevelCombinators(schema);
      expect(out).toEqual(schema);
      // Same reference: nothing was rewritten.
      expect(out).toBe(schema);
    });

    it("leaves a NESTED combinator (inside a property) untouched", () => {
      const schema = {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["value"],
      };
      const out = stripTopLevelCombinators(schema);
      // No top-level combinator to strip -> unchanged, nested anyOf preserved.
      expect(out).toEqual(schema);
      expect((out.properties as Record<string, unknown>).value).toEqual({
        anyOf: [{ type: "string" }, { type: "number" }],
      });
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

    it("merges consecutive user messages instead of inserting synthetic padding", () => {
      const msgs: Message[] = [user("first"), user("second"), assistant("reply"), user("third")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic assistant padding — consecutive users are merged
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
      // First user message should contain both user contents merged
      expect(history[0].userInputMessage?.content).toContain("first");
      expect(history[0].userInputMessage?.content).toContain("second");
    });

    it("merges tool results into previous user message instead of inserting synthetic padding", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      // user -> user(tool results) — should merge, not pad
      const msgs: Message[] = [user("go"), user("more"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic padding entries
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
    });

    it("leaves the prior real user message byte-identical when tool results merge into it", () => {
      // A toolResult directly after a user turn, with no assistant entry between,
      // takes the merge branch: the results attach to the existing user entry
      // rather than creating a new one. The merged entry's text must stay
      // exactly what the user wrote — regression for the carrier prose that
      // used to be appended onto it.
      const msgs: Message[] = [user("go"), toolResult("tc1", "ok"), assistant("done"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const carrier = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);

      expect(carrier?.userInputMessage?.content).toBe("go");
      expect(carrier?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(1);
      expect(JSON.stringify(history)).not.toContain("Tool results provided");
    });

    it("gives a standalone tool-result entry empty content, not carrier prose", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      // The tool result lands after an assistant entry, so it becomes its own
      // entry rather than merging.
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "ok"), assistant("done"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const carrier = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);

      expect(carrier?.userInputMessage?.content).toBe("");
      expect(carrier?.userInputMessage?.userInputMessageContext?.toolResults?.[0].toolUseId).toBe("tc1");
      expect(JSON.stringify(history)).not.toContain("Tool results provided");
    });

    it("keeps the system prompt intact on a user message that also carries tool results", () => {
      const msgs: Message[] = [user("go"), toolResult("tc1", "ok"), assistant("done"), user("next")];
      const { history } = buildHistory(msgs, "M", "SYSTEM");
      const carrier = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);

      expect(carrier?.userInputMessage?.content).toBe("SYSTEM\n\ngo");
    });

    it("merges a run of tool results into one user entry without repeating carrier text", () => {
      const msgs: Message[] = [
        user("go"),
        toolResult("tc1", "one"),
        toolResult("tc2", "two"),
        assistant("done"),
        user("next"),
      ];
      const { history } = buildHistory(msgs, "M");
      const carrier = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);

      expect(carrier?.userInputMessage?.content).toBe("go");
      expect(carrier?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2);
    });

    it("never contains synthetic padding in long agentic sessions", () => {
      const msgs: Message[] = [user("start")];
      for (let i = 0; i < 20; i++) {
        const a = assistant(`step ${i}`);
        a.content = [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { cmd: "ls" } }];
        msgs.push(a);
        msgs.push(toolResult(`tc${i}`, `output ${i}`));
      }
      msgs.push(user("done"));
      const { history } = buildHistory(msgs, "M", "Be helpful");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No single-char synthetic padding
      const padding = history.filter(
        (h) =>
          (h.assistantResponseMessage &&
            h.assistantResponseMessage.content.length > 0 &&
            h.assistantResponseMessage.content.length <= 3 &&
            !h.assistantResponseMessage.toolUses) ||
          (h.userInputMessage &&
            h.userInputMessage.content.length > 0 &&
            h.userInputMessage.content.length <= 3 &&
            !h.userInputMessage.userInputMessageContext?.toolResults),
      );
      expect(padding).toHaveLength(0);
    });

    it("maintains valid alternating user/assistant pattern via merging", () => {
      const msgs: Message[] = [user("a"), user("b"), user("c"), assistant("reply"), user("d")];
      const { history } = buildHistory(msgs, "M");
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        // No two consecutive user or assistant entries
        if (curr.userInputMessage) expect(next.assistantResponseMessage).toBeDefined();
        if (curr.assistantResponseMessage) expect(next.userInputMessage).toBeDefined();
      }
    });

    // -------------------------------------------------------------------
    // Reasoning is excluded from the assistant text channel.
    //
    // `buildHistory` used to prepend `<thinking>...</thinking>` onto
    // `assistantResponseMessage.content`, putting literal markup into the
    // string the model reads back as its own prior speech. First-party Kiro
    // Agent's `extractTextContent` type-filters to `text` blocks, so it never
    // emits that markup; it carries reasoning in a typed `reasoningContent`
    // field instead. These pin the text channel only.
    //
    // MUTATION PROBE: restore the concatenation in `transform.ts`
    //   armContent = `<thinking>${...}</thinking>\n\n${armContent}`
    // and the first test goes red.
    // -------------------------------------------------------------------
    describe("reasoning blocks", () => {
      it("keeps the text and emits no <thinking> markup", () => {
        const withThinking = assistant("");
        withThinking.content = [
          { type: "thinking", thinking: "let me consider the options" },
          { type: "text", text: "The answer is 4." },
        ];
        const { history } = buildHistory([user("what is 2+2"), withThinking, user("thanks")], "M");
        const arm = history.find((h) => h.assistantResponseMessage)?.assistantResponseMessage;
        expect(arm?.content).toBe("The answer is 4.");
        expect(arm?.content).not.toContain("<thinking>");
        expect(arm?.content).not.toContain("let me consider the options");
      });

      it("retains a thinking-only turn with empty content rather than dropping it", () => {
        const thinkingOnly = assistant("");
        thinkingOnly.content = [{ type: "thinking", thinking: "still deciding" }];
        const { history } = buildHistory([user("first"), thinkingOnly, user("second")], "M");
        const arm = history.filter((h) => h.assistantResponseMessage);
        expect(arm).toHaveLength(1);
        expect(arm[0].assistantResponseMessage?.content).toBe("");
        // Dropping it would collapse `first` and `second` into two consecutive
        // user entries and break ALTERNATING_MESSAGES, which this provider now
        // checks pre-send. `second` is the current message, so the invariant is
        // only observable on the whole conversation.
        const conversation = kiroConversationEntries(history, {
          content: "second",
          modelId: "M",
          origin: "KIRO_CLI",
        });
        expect(validateKiroConversation(conversation).valid).toBe(true);
      });

      it("leaves toolUses untouched and content markup-free", () => {
        const withBoth = assistant("");
        withBoth.content = [
          { type: "thinking", thinking: "need to compute" },
          { type: "toolCall", id: "tc1", name: "calc", arguments: { expr: "2+2" } },
        ];
        const { history } = buildHistory([user("compute"), withBoth, toolResult("tc1", "4"), user("thanks")], "M");
        const arm = history.find((h) => h.assistantResponseMessage)?.assistantResponseMessage;
        expect(arm?.toolUses).toHaveLength(1);
        expect(arm?.toolUses?.[0].toolUseId).toBe("tc1");
        expect(arm?.content).not.toContain("<thinking>");
        expect(arm?.content).not.toContain("need to compute");
      });

      it("still drops an assistant turn that carried no blocks at all", () => {
        const empty = assistant("");
        empty.content = [];
        const { history } = buildHistory([user("hi"), empty], "M");
        expect(history.filter((h) => h.assistantResponseMessage)).toHaveLength(0);
      });
    });
  });

  describe("relocateDisplacedToolResults", () => {
    const call = (...ids: string[]): AssistantMessage =>
      assistant("", {
        content: ids.map((id) => ({ type: "toolCall" as const, id, name: "t", arguments: {} })),
        stopReason: "toolUse",
      });
    const shape = (messages: Message[]) =>
      messages.map((m) => (m.role === "toolResult" ? `result(${(m as ToolResultMessage).toolCallId})` : m.role));

    it("is a no-op when every result already follows its call", () => {
      const input: Message[] = [user("hi"), call("A"), toolResult("A", "out"), user("thanks")];
      const out = relocateDisplacedToolResults(input);
      expect(shape(out)).toEqual(shape(input));
      // Same objects, not just the same shape — nothing is rebuilt or rewritten.
      expect(out).toEqual(input);
    });

    it("is a no-op on a multi-call turn whose results already follow in order", () => {
      const input: Message[] = [user("hi"), call("A", "B"), toolResult("A", "a"), toolResult("B", "b")];
      expect(shape(relocateDisplacedToolResults(input))).toEqual(["user", "assistant", "result(A)", "result(B)"]);
    });

    it("moves a displaced result back behind the assistant that issued it", () => {
      // The live skew: two concurrent executions interleaved into one transcript.
      const out = relocateDisplacedToolResults([
        user("start"),
        call("A"),
        user("continue"),
        call("B"),
        toolResult("A", "REAL_A"),
      ]);
      expect(shape(out)).toEqual(["user", "assistant", "result(A)", "user", "assistant"]);
      // The user's interjection is preserved verbatim, just later on the wire.
      expect((out[3] as UserMessage).content).toBe("continue");
    });

    it("reorders a multi-call turn's results to the order the turn declared them", () => {
      const out = relocateDisplacedToolResults([
        user("hi"),
        call("A", "B"),
        toolResult("B", "b"),
        toolResult("A", "a"),
      ]);
      // Contiguous behind their turn, in declaration order, so the next message
      // carries exactly that turn's results.
      expect(shape(out)).toEqual(["user", "assistant", "result(A)", "result(B)"]);
    });

    it("matches by id — a result is never pulled behind a different tool use", () => {
      const out = relocateDisplacedToolResults([user("hi"), call("A"), call("B"), toolResult("B", "b")]);
      // `B`'s result must stay behind `B`. Moving it behind `A` would satisfy a
      // positional pairing test while putting the wrong output on the wire.
      expect(shape(out)).toEqual(["user", "assistant", "assistant", "result(B)"]);
    });

    it("leaves a result whose call appears nowhere in place", () => {
      // `injectSyntheticToolCalls` owns this shape; relocation must not touch it.
      const out = relocateDisplacedToolResults([user("hi"), call("A"), toolResult("A", "a"), toolResult("Z", "z")]);
      expect(shape(out)).toEqual(["user", "assistant", "result(A)", "result(Z)"]);
    });

    it("never drops or duplicates a message", () => {
      const input: Message[] = [
        user("start"),
        call("A"),
        user("continue"),
        call("B"),
        toolResult("A", "a"),
        toolResult("B", "b"),
      ];
      const out = relocateDisplacedToolResults(input);
      expect(out).toHaveLength(input.length);
      for (const m of input) expect(out).toContain(m);
    });

    it("merges a relocated carrier and a real user turn without fabricating separators", () => {
      // The carrier now has `content: ""`, so an unconditional `\n\n` join would
      // put `"\n\ncontinue"` on the wire for a user who typed `continue`.
      const { history } = buildHistory(
        relocateDisplacedToolResults([user("start"), call("A"), user("continue"), call("B"), toolResult("A", "a")]),
        "M",
      );
      const carrier = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      expect(carrier?.userInputMessage?.content).toBe("continue");
    });

    it("still separates two real consecutive user utterances", () => {
      // A trailing user turn becomes the CURRENT message, so a third message is
      // needed to force both utterances into history.
      const { history } = buildHistory([user("first"), user("second"), assistant("ok"), user("third")], "M");
      expect(history[0]?.userInputMessage?.content).toBe("first\n\nsecond");
    });
  });
});
