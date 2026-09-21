// ABOUTME: Tests for <tool_use>{JSON}</tool_use> dialect tool call extraction from content text.
// ABOUTME: Validates the field-spelling variants opus-class models emit and the fenced-code guard.

import { describe, expect, it } from "vitest";
import { parseToolUseCalls } from "../src/tool-use-parser.js";

describe("parseToolUseCalls", () => {
  it("extracts a tool_name/tool_input descriptor and cleans the text", () => {
    const text =
      'Reading it now.\n<tool_use>\n{"tool_name": "read_file", "tool_input": {"file_path": "/tmp/x.txt"}}\n</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].arguments).toEqual({ file_path: "/tmp/x.txt" });
    expect(result.cleanedText).toBe("Reading it now.\n");
  });

  it("extracts a name/input descriptor", () => {
    const text = '<tool_use>{"name": "write_file", "input": {"path": "b.txt", "content": "hello"}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write_file");
    expect(result.toolCalls[0].arguments).toEqual({ path: "b.txt", content: "hello" });
    expect(result.cleanedText).toBe("");
  });

  it("extracts a name/arguments descriptor", () => {
    const text = '<tool_use>{"name": "bash", "arguments": {"cmd": "ls -la"}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].arguments).toEqual({ cmd: "ls -la" });
  });

  it("extracts multiple tool_use blocks", () => {
    const text =
      '<tool_use>{"name": "read", "input": {"path": "a.txt"}}</tool_use> then ' +
      '<tool_use>{"name": "write", "input": {"path": "b.txt"}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[1].name).toBe("write");
    expect(result.cleanedText).toBe(" then ");
  });

  it("treats an absent argument object as a zero-arg call", () => {
    const text = '<tool_use>{"name": "list_tools"}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("list_tools");
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it("preserves braces inside string values via balanced-brace scanning", () => {
    const text = '<tool_use>{"name": "bash", "input": {"cmd": "echo \\"{}\\""}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({ cmd: 'echo "{}"' });
  });

  it("unwraps a tool_calls array wrapper", () => {
    const text =
      '<tool_use>\n{"tool_calls": [{"tool_name": "read_file", "input": {"path": "/tmp/x.txt"}}]}\n</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].arguments).toEqual({ path: "/tmp/x.txt" });
    expect(result.cleanedText).toBe("");
  });

  it("unwraps multiple entries in a tool_calls array", () => {
    const text =
      '<tool_use>{"tool_calls": [{"name": "read", "input": {"path": "a"}}, {"name": "write", "input": {"path": "b"}}]}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[1].name).toBe("write");
  });

  it("rejects a tool_calls array containing a malformed entry", () => {
    const text = '<tool_use>{"tool_calls": [{"name": "read", "input": {}}, {"input": {}}]}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("returns untouched when no tool_use blocks are present", () => {
    const text = "Just regular prose with no tool calls.";
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("ignores a tool_use block inside a fenced code sample", () => {
    const text =
      'Here is how the dialect looks:\n\n```\n<tool_use>{"name": "bash", "input": {"cmd": "rm -rf /"}}</tool_use>\n```\n\nDo not run it.';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("rejects a descriptor with a non-object argument value", () => {
    const text = '<tool_use>{"name": "bash", "input": "ls"}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("rejects a descriptor missing a name", () => {
    const text = '<tool_use>{"input": {"path": "a.txt"}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("skips a block whose body is not solely a JSON object", () => {
    const text = '<tool_use>call this: {"name": "bash", "input": {}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("skips malformed JSON gracefully", () => {
    const text = "<tool_use>{not valid json}</tool_use>";
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("handles empty text", () => {
    const result = parseToolUseCalls("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe("");
  });

  it("assigns unique toolUseIds to each call", () => {
    const text = '<tool_use>{"name": "a", "input": {}}</tool_use><tool_use>{"name": "b", "input": {}}</tool_use>';
    const result = parseToolUseCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolUseId).not.toBe(result.toolCalls[1].toolUseId);
  });
});
