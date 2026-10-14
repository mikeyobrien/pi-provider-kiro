// ABOUTME: Tests for XML-dialect tool call extraction from content text.
// ABOUTME: Validates <invoke name="..."><parameter name="...">…</parameter></invoke> parsing.

import { describe, expect, it } from "vitest";
import { hasUnclosedInvoke, parseInvokeToolCalls, stripUnclosedInvoke } from "../src/invoke-tool-parser.js";
import { RECORD_279_COMMAND, RECORD_279_SUMMARY, RECORD_279_TEXT } from "./helpers/invoke-fixture.js";

describe("parseInvokeToolCalls", () => {
  it("extracts a single invoke with one parameter and cleans the text", () => {
    const text = 'Running it now.\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("shell");
    expect(result.toolCalls[0].arguments).toEqual({ command: "ls -la" });
    expect(result.cleanedText).toBe("Running it now.\n");
  });

  it("preserves a multi-line parameter value byte-for-byte (record 279)", () => {
    const result = parseInvokeToolCalls(RECORD_279_TEXT);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("shell");
    // Byte-identical, not merely equivalent: no unescaping, no whitespace
    // normalization, no entity decoding anywhere along the path.
    expect(result.toolCalls[0].arguments.command).toBe(RECORD_279_COMMAND);
    expect(result.toolCalls[0].arguments.summary).toBe(RECORD_279_SUMMARY);
    expect(String(result.toolCalls[0].arguments.command)).toContain("2>/dev/null > /tmp/cr3.json");
    expect(String(result.toolCalls[0].arguments.command).split("\n")).toHaveLength(13);
    expect(result.cleanedText).toBe("");
  });

  it("preserves leading and trailing whitespace inside a parameter value", () => {
    // Trimming looks harmless and is a no-op on the record 279 fixture, but it
    // silently corrupts payloads whose edges are significant — a heredoc body,
    // an indented patch, a file whose final newline matters. Pinned explicitly
    // so the byte-exactness contract is not merely incidental to one fixture.
    const value = "\n  cat <<'EOF' > /tmp/x\n    indented\nEOF\n\n";
    const text = `<invoke name="shell">\n<parameter name="command">${value}</parameter>\n</invoke>`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments.command).toBe(value);
  });

  it("handles multiple parameters whose values contain > and }", () => {
    const text =
      '<invoke name="shell">\n' +
      '<parameter name="command">echo "{a: 1}" > /tmp/x.json && test 3 -gt 2</parameter>\n' +
      '<parameter name="summary">write {} and > safely</parameter>\n' +
      "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({
      command: 'echo "{a: 1}" > /tmp/x.json && test 3 -gt 2',
      summary: "write {} and > safely",
    });
  });

  it("extracts two invoke blocks from one text block", () => {
    const text =
      '<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n' +
      'then\n<invoke name="task_comment">\n<parameter name="id">t-1</parameter>\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[1].name).toBe("task_comment");
    expect(result.toolCalls[1].arguments).toEqual({ id: "t-1" });
    expect(result.cleanedText).toBe("\nthen\n");
  });

  it("preserves a JSON-looking parameter value as raw text", () => {
    const value = '["https://code.amazon.com/reviews/CR-1"]';
    const text = `<invoke name="ReadInternalWebsites">\n<parameter name="inputs">${value}</parameter>\n</invoke>`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls[0].arguments.inputs).toBe(value);
  });

  it("preserves a JSON object parameter including edge whitespace", () => {
    const value = '  {"path":"a.txt","content":"x"}\n';
    const text = `<invoke name="write">\n<parameter name="args">${value}</parameter>\n</invoke>`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls[0].arguments.args).toBe(value);
  });

  it("does not coerce scalar-looking values", () => {
    // `true` is a real shell command; `42` could be a literal string argument.
    const text =
      '<invoke name="shell">\n' +
      '<parameter name="command">true</parameter>\n' +
      '<parameter name="timeout">42</parameter>\n' +
      "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls[0].arguments).toEqual({ command: "true", timeout: "42" });
  });

  it("keeps a JSON-looking-but-invalid value as raw text", () => {
    const text = '<invoke name="shell">\n<parameter name="command">{not json</parameter>\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls[0].arguments).toEqual({ command: "{not json" });
  });

  it("abandons the text when a parameter value contains nested invoke markup", () => {
    // The dangerous shape: a legitimate call whose argument *contains* the
    // dialect as data — a command that greps for it, or writes a test fixture
    // containing it. Two defects lurk here. A `</parameter>` belonging to the
    // nested markup can cut the outer value short, so the outer call would run
    // a truncated command; and the nested tag would be harvested as a second,
    // independent call that the model never asked for. Neither is acceptable,
    // and the correct extent is genuinely unknowable, so nothing is recovered
    // and the text is left whole for a human to act on.
    const text =
      '<invoke name="shell">\n' +
      '<parameter name="command">printf \'<invoke name="shell">' +
      '<parameter name="command">rm -rf /</parameter></invoke>\' > sample.txt</parameter>\n' +
      '<parameter name="summary">write a doc sample</parameter>\n' +
      "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("never harvests an embedded call as an independent tool call", () => {
    // Narrower probe on the second half of the defect: even if the outer block
    // were somehow discarded, the embedded `rm -rf /` must not survive as a
    // recovered call.
    const text =
      '<invoke name="shell">\n' +
      '<parameter name="command">echo \'<invoke name="shell">' +
      '<parameter name="command">rm -rf /</parameter></invoke>\'</parameter>\n' +
      "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls.map((t) => t.arguments.command)).not.toContain("rm -rf /");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("leaves text untouched when a value contains ambiguous parameter markup", () => {
    const text =
      '<invoke name="shell">\n' + "<parameter name=\"command\">printf '</parameter>'</parameter>\n" + "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("leaves text untouched when a value contains a complete invoke closing sequence", () => {
    const text =
      '<invoke name="shell">\n' +
      "<parameter name=\"command\">printf '</parameter></invoke>'</parameter>\n" +
      "</invoke>";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("recovers a value that contains a bare closing invoke tag", () => {
    // `</invoke>` alone in a value is unambiguous: the block end is found by
    // walking parameters, not by searching for the closing tag, so this stays
    // recoverable and byte-exact.
    const command = "grep -rn '</invoke>' src/";
    const text = `<invoke name="shell">\n<parameter name="command">${command}</parameter>\n</invoke>`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments.command).toBe(command);
    expect(result.cleanedText).toBe("");
  });

  it("recovers a value containing an invoke open tag that is not the full dialect", () => {
    // A grep for the tag prefix is not nested markup — no quoted name, no
    // close — so it must not trip the ambiguity bail.
    const command = `grep -rn '<invoke name=' src/`;
    const text = `<invoke name="shell">\n<parameter name="command">${command}</parameter>\n</invoke>`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments.command).toBe(command);
  });

  it("abandons all recovery when malformed markup precedes a valid-looking invoke", () => {
    const text =
      '<invoke name="shell">\n' +
      '<parameter name="command">printf \'<invoke name="shell">' +
      '<parameter name="command">rm -rf /</parameter></invoke>\'</parameter>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("leaves text untouched for an unterminated invoke", () => {
    const text = '<invoke name="shell">\n<parameter name="command">ls</parameter>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("leaves text untouched for an unterminated parameter", () => {
    const text = '<invoke name="shell">\n<parameter name="command">ls\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("rejects an invoke whose body holds anything but parameters", () => {
    // Never half-strip: a body with prose in it is not a call we can faithfully
    // reconstruct, so the whole block is left alone.
    const text = '<invoke name="shell">\nrun something clever\n<parameter name="command">ls</parameter>\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("recovers a zero-parameter invoke", () => {
    const text = '<invoke name="mcp">\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it("emits an unknown tool name verbatim without validating it", () => {
    // Same contract as parseBracketToolCalls: the parser has no tool registry.
    // An unknown name becomes a toolCall and the agent loop reports the error,
    // which is strictly better than a silent stall.
    const text = '<invoke name="not_a_real_tool">\n<parameter name="x">1</parameter>\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("not_a_real_tool");
  });

  it("ignores an invoke inside a fenced code block", () => {
    // Documentation about this very bug quotes the dialect verbatim — three
    // such records exist in the session corpus that motivated this parser.
    // Executing a command out of a code sample is worse than not recovering,
    // so fenced regions are excluded.
    const text = ["Here is the leak shape:", "```", RECORD_279_TEXT, "```", "Want me to file a card?"].join("\n");
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("ignores an invoke after an unclosed fence", () => {
    const text = `Example:\n\`\`\`\n${RECORD_279_TEXT}`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("still recovers an unfenced invoke that follows a closed code block", () => {
    const text = `Here is the log:\n\`\`\`\nsome output\n\`\`\`\n${RECORD_279_TEXT}`;
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments.command).toBe(RECORD_279_COMMAND);
  });

  it("returns empty for text with no invoke blocks", () => {
    const text = "Just prose mentioning parameters and invocations.";
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it("handles empty text", () => {
    const result = parseInvokeToolCalls("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe("");
  });

  it("assigns unique toolUseIds to each recovered call", () => {
    const text = '<invoke name="a">\n</invoke>\n<invoke name="b">\n</invoke>';
    const result = parseInvokeToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolUseId).not.toBe(result.toolCalls[1].toolUseId);
  });
});

// Dynamic import for ESM-only export
const { createCourtInvokeGate } = await import("../src/invoke-tool-parser.js");

describe("unclosed invoke leak", () => {
  it("detects a sentinel-prefixed invoke that never closes", () => {
    const text = '先改这个类。\n\ncourt\n<invoke name="edit">\n<parameter name="path">/tmp/a.py</parameter>';
    expect(hasUnclosedInvoke(text)).toBe(true);
    expect(stripUnclosedInvoke(text)).toBe("先改这个类。");
  });

  it("leaves a closed invoke alone", () => {
    const text = '<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>';
    expect(hasUnclosedInvoke(text)).toBe(false);
    expect(stripUnclosedInvoke(text)).toBe(text);
  });

  it("ignores an unclosed invoke quoted inside a fence", () => {
    const text = '示例：\n```\n<invoke name="edit">\n```\n就这些。';
    expect(hasUnclosedInvoke(text)).toBe(false);
  });
});

describe("createCourtInvokeGate — streaming", () => {
  const registered = (name: string) => ["edit", "bash", "read", "write"].includes(name);

  it("recovers court-prefixed invoke across realistic streaming chunks", () => {
    const gate = createCourtInvokeGate(registered);
    const chunks = [
      "我整体替换 922-1023。新版加入阶段跟踪 + 自动补发。\n\n",
      "court",
      "\n",
      '<invoke name="edit">\n',
      '<parameter name="path">/some/file.py</parameter>\n',
      '<parameter name="new_string">code</parameter>\n',
      "</invoke>",
    ];
    const allText: string[] = [];
    const allCalls: unknown[] = [];
    for (const chunk of chunks) {
      const step = gate.push(chunk);
      if (step.text) allText.push(step.text);
      allCalls.push(...step.toolCalls);
    }
    const final = gate.finish();
    if (final.text) allText.push(final.text);
    allCalls.push(...final.toolCalls);

    expect(allCalls).toHaveLength(1);
    expect((allCalls[0] as any).name).toBe("edit");
    const joined = allText.join("");
    expect(joined).not.toContain("court");
    expect(joined).not.toContain("<invoke");
  });

  it("recovers core-prefixed invoke across realistic streaming chunks", () => {
    const gate = createCourtInvokeGate(registered);
    const chunks = [
      "先执行一下。\n\n",
      "core",
      "\n",
      '<invoke name="bash">\n',
      '<parameter name="command">echo hello</parameter>\n',
      "</invoke>",
    ];
    const allText: string[] = [];
    const allCalls: unknown[] = [];
    for (const chunk of chunks) {
      const step = gate.push(chunk);
      if (step.text) allText.push(step.text);
      allCalls.push(...step.toolCalls);
    }
    const final = gate.finish();
    if (final.text) allText.push(final.text);
    allCalls.push(...final.toolCalls);

    expect(allCalls).toHaveLength(1);
    expect((allCalls[0] as any).name).toBe("bash");
    const joined = allText.join("");
    expect(joined).not.toContain("core");
    expect(joined).not.toContain("<invoke");
  });

  it("releases unregistered tool as text even with sentinel prefix", () => {
    const gate = createCourtInvokeGate(registered);
    const step = gate.push("court\n" + '<invoke name="unknown_tool">\n<parameter name="x">1</parameter>\n</invoke>');
    const final = gate.finish();
    const text = step.text + final.text;
    expect(step.toolCalls.length + final.toolCalls.length).toBe(0);
    expect(text).toContain("court");
  });
});
