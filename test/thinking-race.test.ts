import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { ThinkingTagParser } from "../src/thinking-parser.js";

function makeOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "kiro-api",
    provider: "kiro",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function run(chunks: string[]): Promise<{ events: AssistantMessageEvent[]; output: AssistantMessage }> {
  const output = makeOutput();
  const stream = createAssistantMessageEventStream();
  const parser = new ThinkingTagParser(output, stream);
  for (const c of chunks) parser.processChunk(c);
  parser.finalize();
  stream.end();
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, output };
}

function deltas(events: AssistantMessageEvent[], type: string): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => (e as { delta?: string }).delta)
    .join("");
}

describe("Thinking parser race conditions", () => {
  // ---- Race 1: stream truncated while thinking content is in hold-back zone ----

  it("short thinking content (<12 chars) emitted as thinking when stream ends mid-block", async () => {
    // <thinking>hi  — stream ends, no closing tag ever arrives
    // "hi" is 2 chars, well under MAX_CLOSE_TAG_LEN (12)
    // thinkingBlockIndex never gets set because safeLen is always 0
    const { events } = await run(["<thinking>hi"]);

    const thinkingContent = deltas(events, "thinking_delta");
    const textContent = deltas(events, "text_delta");

    // Thinking content should NOT leak into visible text
    expect(textContent).toBe("");
    expect(thinkingContent).toBe("hi");
  });

  it("thinking content exactly at hold-back length (12 chars) emitted as thinking on finalize", async () => {
    const { events } = await run(["<thinking>exactly12chr"]);

    expect(deltas(events, "text_delta")).toBe("");
    expect(deltas(events, "thinking_delta")).toBe("exactly12chr");
  });

  it("thinking content just over hold-back (13 chars) is fully emitted as thinking", async () => {
    // 13 chars: safeLen=1, so 1 char emitted during streaming, rest on finalize
    const { events } = await run(["<thinking>exactly13chars"]);

    expect(deltas(events, "text_delta")).toBe("");
    expect(deltas(events, "thinking_delta")).toBe("exactly13chars");
  });

  // ---- Race 2: chunk boundary splits affect content categorization ----

  it("same content produces same output regardless of chunk boundaries (single chunk)", async () => {
    const { events: eventsA } = await run(["<thinking>thought</thinking>\n\nAnswer"]);
    const { events: eventsB } = await run(["<thinking>", "thought", "</thinking>", "\n\nAnswer"]);
    const { events: eventsC } = await run(["<thin", "king>tho", "ught</thi", "nking>\n\n", "Answer"]);

    // All three should produce identical thinking + text content
    for (const events of [eventsA, eventsB, eventsC]) {
      expect(deltas(events, "thinking_delta")).toBe("thought");
      expect(deltas(events, "text_delta")).toBe("Answer");
    }
  });

  // ---- Race 3: finalize with partial end tag in buffer ----

  it("partial end tag in buffer at stream end doesn't swallow text content", async () => {
    // Stream sends thinking content + partial end tag, then dies
    // The partial "</thinki" should be part of thinking, not lost
    const { events, output } = await run(["<thinking>deep thoughts</thinki"]);

    const thinkingContent = deltas(events, "thinking_delta");
    const textContent = deltas(events, "text_delta");

    // All content should be accounted for (nothing lost)
    expect(thinkingContent + textContent).toBe("deep thoughts</thinki");
    // It should be thinking content since we're still inside the thinking block
    expect(thinkingContent).toContain("deep thoughts");
  });

  // ---- Race 4: text after thinking entirely in hold-back zone ----

  it("short text after thinking block is emitted (not stuck in hold-back)", async () => {
    const { events } = await run(["<thinking>thought</thinking>\n\nOK"]);

    expect(deltas(events, "thinking_delta")).toBe("thought");
    expect(deltas(events, "text_delta")).toBe("OK");
  });

  it("text after thinking arriving in separate chunk is emitted", async () => {
    const { events } = await run(["<thinking>thought</thinking>\n\n", "OK"]);

    expect(deltas(events, "thinking_delta")).toBe("thought");
    expect(deltas(events, "text_delta")).toBe("OK");
  });

  // ---- Race 5: empty thinking block ----

  it("empty thinking block followed by text", async () => {
    const { events } = await run(["<thinking></thinking>\n\nAnswer"]);

    expect(deltas(events, "text_delta")).toBe("Answer");
    // No thinking content to emit, but thinking_end should still fire
    expect(events.some((e) => e.type === "thinking_end")).toBe(true);
  });

  // ---- Race 6: thinking block with only whitespace ----

  it("whitespace-only thinking content preserved as thinking", async () => {
    const { events } = await run(["<thinking>   </thinking>\n\nAnswer"]);

    expect(deltas(events, "thinking_delta")).toBe("   ");
    expect(deltas(events, "text_delta")).toBe("Answer");
  });

  // ---- Race 7: multiple thinking blocks ----

  it("second thinking block tags don't corrupt text output", async () => {
    const { events } = await run(["<thinking>first</thinking>\n\nMiddle text<thinking>second</thinking>\n\nEnd"]);

    expect(deltas(events, "thinking_delta")).toBe("first");
    // Second <thinking> block should appear as literal text (only first block parsed)
    const text = deltas(events, "text_delta");
    expect(text).toContain("Middle text");
    expect(text).toContain("End");
  });

  // ---- Race 8: thinking tag at very end of chunk with text in next chunk ----

  it("closing thinking tag at chunk boundary with text in next chunk", async () => {
    const { events } = await run(["<thinking>thought</thinking>", "\n\nThe answer is 42"]);

    expect(deltas(events, "thinking_delta")).toBe("thought");
    expect(deltas(events, "text_delta")).toBe("The answer is 42");
  });

  // ---- Race 9: single-char chunks through entire thinking block ----

  it("single-character chunks through thinking block", async () => {
    const content = "<thinking>AB</thinking>\n\nCD";
    const chunks = content.split(""); // one char per chunk
    const { events } = await run(chunks);

    expect(deltas(events, "thinking_delta")).toBe("AB");
    expect(deltas(events, "text_delta")).toBe("CD");
  });
});
