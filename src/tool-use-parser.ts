// ABOUTME: Extracts <tool_use>{JSON}</tool_use> dialect tool calls from content text as a fallback.
// ABOUTME: Parses opus-class output that wraps a JSON tool descriptor in <tool_use> tags.

import { findJsonEnd } from "./bracket-tool-parser.js";

export interface ToolUseCall {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolUseParseResult {
  toolCalls: ToolUseCall[];
  cleanedText: string;
}

const OPEN_TAG = "<tool_use>";
const CLOSE_TAG = "</tool_use>";
const FENCE = "```";

/**
 * Byte ranges covered by an *opened* fenced code block. Mirrors the guard in
 * {@link parseInvokeToolCalls}: a `<tool_use>` block quoted inside a fenced
 * code sample — for instance model output that documents this very dialect —
 * must not be harvested and executed as a real (misrouted) tool call.
 */
function fencedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  while (true) {
    const open = text.indexOf(FENCE, searchFrom);
    if (open < 0) break;
    const close = text.indexOf(FENCE, open + FENCE.length);
    if (close < 0) {
      ranges.push({ start: open, end: text.length });
      break;
    }
    ranges.push({ start: open, end: close + FENCE.length });
    searchFrom = close + FENCE.length;
  }
  return ranges;
}

/**
 * Normalizes the several field spellings opus-class models use inside the
 * `<tool_use>` JSON descriptor into a `{ name, arguments }` pair, or returns
 * null if neither a name nor an argument object can be identified.
 *
 * Observed variants:
 *   { "tool_name": "...", "tool_input": { ... } }
 *   { "name": "...", "input": { ... } }
 *   { "name": "...", "arguments": { ... } }
 */
function normalizeOne(value: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const rawName = record.tool_name ?? record.name;
  if (typeof rawName !== "string" || rawName.length === 0) return null;

  const rawArgs = record.tool_input ?? record.input ?? record.arguments;
  // An absent argument object is legitimate (a zero-arg tool). A present but
  // non-object argument value is malformed and rejects the descriptor rather
  // than fabricating an empty argument set.
  if (rawArgs === undefined) {
    return { name: rawName, arguments: {} };
  }
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) return null;

  return { name: rawName, arguments: rawArgs as Record<string, unknown> };
}

/**
 * Extracts every tool descriptor from a parsed `<tool_use>` JSON payload.
 *
 * Handles both a bare single descriptor and the array-wrapped forms some
 * models emit, where the payload is `{ "tool_calls": [ {…}, {…} ] }` or
 * `{ "calls": [ … ] }`. Returns an empty array when nothing well-formed is
 * present, which the caller treats as "leave this block untouched".
 */
function extractDescriptors(value: unknown): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const wrapped = record.tool_calls ?? record.calls;
    if (Array.isArray(wrapped)) {
      const out: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      for (const entry of wrapped) {
        const one = normalizeOne(entry);
        if (one === null) return []; // A malformed entry rejects the whole block.
        out.push(one);
      }
      return out;
    }
  }
  const single = normalizeOne(value);
  return single ? [single] : [];
}

/**
 * Recovers tool calls that a model emitted as `<tool_use>{JSON}</tool_use>`
 * text instead of as structured tool-use frames. Mirrors
 * {@link parseBracketToolCalls} and {@link parseInvokeToolCalls}: returns the
 * recovered calls plus the text with each consumed `<tool_use>` span spliced
 * out. A block that cannot be parsed in full is left in the text untouched.
 */
export function parseToolUseCalls(text: string): ToolUseParseResult {
  const toolCalls: ToolUseCall[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  const fences = fencedRanges(text);

  let cursor = 0;
  while (cursor < text.length) {
    const openStart = text.indexOf(OPEN_TAG, cursor);
    if (openStart < 0) break;

    const containingFence = fences.find((range) => openStart >= range.start && openStart < range.end);
    if (containingFence) {
      cursor = containingFence.end;
      continue;
    }

    const bodyStart = openStart + OPEN_TAG.length;
    const closeIdx = text.indexOf(CLOSE_TAG, bodyStart);
    if (closeIdx < 0) break; // No closing tag: nothing well-formed remains.

    // Locate the JSON object inside the block by balanced braces, so a `}`
    // inside a string value does not prematurely end extraction.
    const braceStart = text.indexOf("{", bodyStart);
    if (braceStart < 0 || braceStart > closeIdx) {
      cursor = closeIdx + CLOSE_TAG.length;
      continue;
    }
    const braceEnd = findJsonEnd(text, braceStart);
    if (braceEnd < 0 || braceEnd > closeIdx) {
      cursor = closeIdx + CLOSE_TAG.length;
      continue;
    }

    // The block body must be nothing but whitespace around the JSON object.
    const beforeJson = text.substring(bodyStart, braceStart).trim();
    const afterJson = text.substring(braceEnd + 1, closeIdx).trim();
    if (beforeJson.length > 0 || afterJson.length > 0) {
      cursor = closeIdx + CLOSE_TAG.length;
      continue;
    }

    let descriptors: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    try {
      descriptors = extractDescriptors(JSON.parse(text.substring(braceStart, braceEnd + 1)));
    } catch {
      descriptors = [];
    }
    if (descriptors.length === 0) {
      cursor = closeIdx + CLOSE_TAG.length;
      continue;
    }

    for (const descriptor of descriptors) {
      toolCalls.push({
        toolUseId: crypto.randomUUID(),
        name: descriptor.name,
        arguments: descriptor.arguments,
      });
    }
    removals.push({ start: openStart, end: closeIdx + CLOSE_TAG.length });
    cursor = closeIdx + CLOSE_TAG.length;
  }

  // Splice out consumed spans in reverse order so earlier indices stay valid.
  let cleanedText = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    const { start, end } = removals[i];
    cleanedText = cleanedText.substring(0, start) + cleanedText.substring(end);
  }

  return { toolCalls, cleanedText };
}
