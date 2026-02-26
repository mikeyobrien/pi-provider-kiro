// ABOUTME: Tests for bracket-style tool call extraction from content text.
// ABOUTME: Validates parsing of [Called func_name with args: {...}] patterns.

import { describe, expect, it } from "vitest";
import { parseBracketToolCalls } from "../src/bracket-tool-parser.js";

describe("parseBracketToolCalls", () => {
  it("extracts a single bracket tool call", () => {
    const text = 'Some text [Called bash with args: {"cmd": "ls"}] more text';
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].arguments).toEqual({ cmd: "ls" });
    expect(result.cleanedText).toBe("Some text  more text");
  });

  it("extracts multiple bracket tool calls", () => {
    const text =
      '[Called read with args: {"path": "a.txt"}] then [Called write with args: {"path": "b.txt", "content": "hello"}]';
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[1].name).toBe("write");
    expect(result.toolCalls[1].arguments).toEqual({ path: "b.txt", content: "hello" });
  });

  it("returns empty when no bracket tool calls found", () => {
    const text = "Just regular text with [brackets] but no tool calls";
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("handles nested braces in arguments", () => {
    const text = '[Called bash with args: {"cmd": "echo \\"{}\\""}]';
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
  });

  it("handles malformed JSON gracefully", () => {
    const text = "[Called bash with args: {not valid json}] rest";
    const result = parseBracketToolCalls(text);
    // Malformed JSON should be skipped
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("handles empty text", () => {
    const result = parseBracketToolCalls("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe("");
  });

  it("assigns unique toolUseIds to each call", () => {
    const text = "[Called a with args: {}] [Called b with args: {}]";
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolUseId).not.toBe(result.toolCalls[1].toolUseId);
  });

  it("handles tool call with underscores in name", () => {
    const text = '[Called my_tool_name with args: {"x": 1}]';
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("my_tool_name");
  });

  it("handles tool call with dashes in name", () => {
    const text = '[Called my-tool with args: {"x": 1}]';
    const result = parseBracketToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("my-tool");
  });
});
