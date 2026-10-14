// ABOUTME: Extracts XML-dialect tool calls from content text as a fallback.
// ABOUTME: Parses <invoke name="..."><parameter name="...">value</parameter></invoke> blocks.

export interface InvokeToolCall {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InvokeParseResult {
  toolCalls: InvokeToolCall[];
  cleanedText: string;
}

const INVOKE_OPEN_ANCHORED = /^<invoke name="([\w-]+)">/;
const INVOKE_OPEN_SEARCH = "<invoke name=";
const INVOKE_OPEN_ANYWHERE = /<invoke name="[\w-]+">/;
const PARAM_OPEN_ANCHORED = /^<parameter name="([^"]*)">/;
const INVOKE_CLOSE = "</invoke>";
const PARAM_CLOSE = "</parameter>";
const FENCE = "```";

interface ParsedBlock {
  name: string;
  arguments: Record<string, unknown>;
  /** Index just past the block's `</invoke>`. */
  end: number;
}

/**
 * Byte ranges covered by an *opened* fenced code block. Fences are counted
 * pairwise; a trailing unclosed fence extends to end of text. Used to reject
 * `<invoke>` blocks that appear inside documentation rather than as a real
 * (misrouted) tool call — model output that discusses this very bug quotes the
 * dialect verbatim, and executing a command out of a code sample would be
 * strictly worse than not recovering it.
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

/** Thrown when a block's markup cannot be attributed unambiguously. */
class AmbiguousDialectError extends Error {}

/**
 * Parses one `<invoke>` block starting at `start`, or returns null if the
 * markup there is not a complete, well-formed block.
 *
 * The block end is found structurally — by walking parameters — never by
 * searching for `</invoke>`. A naive search would stop at a `</invoke>` that
 * happens to sit inside a parameter value, truncating the value and then
 * accepting the truncation as if it were the whole argument.
 *
 * Strict by design: the body must consist of nothing but whitespace and
 * well-formed `<parameter name="...">...</parameter>` elements. Any other
 * content (prose, an ellipsis placeholder, a stray tag) rejects the block,
 * because a partial parse would either fabricate arguments or half-strip the
 * text.
 */
function parseBlockAt(text: string, start: number): ParsedBlock | null {
  const openMatch = INVOKE_OPEN_ANCHORED.exec(text.substring(start));
  if (!openMatch) return null;

  const args: Record<string, unknown> = {};
  let cursor = start + openMatch[0].length;

  while (true) {
    const remainder = text.substring(cursor);
    const leadingWhitespace = remainder.length - remainder.trimStart().length;
    if (leadingWhitespace > 0) cursor += leadingWhitespace;

    if (text.startsWith(INVOKE_CLOSE, cursor)) {
      const end = cursor + INVOKE_CLOSE.length;
      // A consumed block must end cleanly. This rejects a literal
      // `</parameter></invoke>` inside a value: accepting that prefix would
      // execute a silently truncated command and leave quote/tag debris behind.
      if (end < text.length && !/\s/.test(text[end])) return null;
      return { name: openMatch[1], arguments: args, end };
    }

    const paramMatch = PARAM_OPEN_ANCHORED.exec(text.substring(cursor));
    if (!paramMatch) return null;
    const valueStart = cursor + paramMatch[0].length;
    const valueEnd = text.indexOf(PARAM_CLOSE, valueStart);
    if (valueEnd < 0) return null;
    const value = text.substring(valueStart, valueEnd);
    // A parameter value that itself contains an `<invoke>` open tag makes the
    // block unattributable: nested markup could otherwise be harvested as a
    // call the model never made.
    if (INVOKE_OPEN_ANYWHERE.test(value)) throw new AmbiguousDialectError();
    // Values in this dialect are raw text, not JSON. Preserve every byte:
    // parsing or trimming can silently change a command that will be executed.
    args[paramMatch[1]] = value;
    cursor = valueEnd + PARAM_CLOSE.length;
  }
}

/**
 * Recovers tool calls that a model emitted as XML text instead of as structured
 * tool-use frames. Mirrors {@link parseBracketToolCalls}: returns the recovered
 * calls plus the text with each consumed `<invoke>` span spliced out. A block
 * that cannot be parsed in full is left in the text untouched.
 */
export function parseInvokeToolCalls(text: string): InvokeParseResult {
  const toolCalls: InvokeToolCall[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  const fences = fencedRanges(text);
  const untouched: InvokeParseResult = { toolCalls: [], cleanedText: text };

  let cursor = 0;
  while (cursor < text.length) {
    const openStart = text.indexOf(INVOKE_OPEN_SEARCH, cursor);
    if (openStart < 0) break;
    const containingFence = fences.find((range) => openStart >= range.start && openStart < range.end);
    if (containingFence) {
      cursor = containingFence.end;
      continue;
    }

    let block: ParsedBlock | null;
    try {
      block = parseBlockAt(text, openStart);
    } catch (e) {
      if (e instanceof AmbiguousDialectError) return untouched;
      throw e;
    }
    // A malformed opener can enclose later valid-looking markup as argument
    // data. Without a structural end, independence cannot be proven; abandon
    // all recovery rather than execute an embedded call.
    if (block === null) return untouched;

    // If apparent block end truncated a raw value containing closing-tag text,
    // real outer closers remain later in prose. Never execute that prefix.
    const nextOpen = text.indexOf(INVOKE_OPEN_SEARCH, block.end);
    const interstitialEnd = nextOpen < 0 ? text.length : nextOpen;
    const interstitial = text.substring(block.end, interstitialEnd);
    if (interstitial.includes(PARAM_CLOSE) || interstitial.includes(INVOKE_CLOSE)) return untouched;

    toolCalls.push({ toolUseId: crypto.randomUUID(), name: block.name, arguments: block.arguments });
    removals.push({ start: openStart, end: block.end });
    // Resume past the whole block: its parameter values are data, not markup.
    // With the nesting bail above this is belt-and-braces — any value holding a
    // full open tag has already abandoned the parse — so no test can currently
    // distinguish it from resuming at the search hit. Kept because it is the
    // structurally correct resume point, and the bail is the only thing making
    // the weaker one safe.
    cursor = block.end;
  }

  // Splice out consumed spans in reverse order so earlier indices stay valid.
  let cleanedText = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    const { start, end } = removals[i];
    cleanedText = cleanedText.substring(0, start) + cleanedText.substring(end);
  }

  return { toolCalls, cleanedText };
}

/**
 * A sentinel is a single short alphabetic word on its own line — the leaked
 * prefix Opus drops before `<invoke>`. Known values include `court` and `core`,
 * but the exact word varies across sessions.
 *
 * The regex is inlined to prevent esbuild from collapsing the constant and the
 * function into the same minified name (observed: both became `n`, the function
 * shadowed the regex, and `.test()` silently returned `undefined`).
 */
function isSentinelWord(word: string): boolean {
  return /^[a-z]{2,12}$/.test(word);
}

/** `<invoke` opens that sit outside fenced code, in source order. */
function invokeOpensOutsideFences(text: string): number[] {
  const fences = fencedRanges(text);
  const opens: number[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const openStart = text.indexOf(INVOKE_OPEN_SEARCH, cursor);
    if (openStart < 0) break;
    const containingFence = fences.find((range) => openStart >= range.start && openStart < range.end);
    if (containingFence) {
      cursor = containingFence.end;
      continue;
    }
    opens.push(openStart);
    cursor = openStart + INVOKE_OPEN_SEARCH.length;
  }
  return opens;
}

/** The leaked sentinel is its own line, immediately before the invoke tag. */
function precededBySentinelLine(text: string, openStart: number): string | null {
  const before = text.slice(0, openStart).trimEnd();
  const lineStart = before.lastIndexOf("\n") + 1;
  const word = before.slice(lineStart).trim();
  return isSentinelWord(word) ? word : null;
}

function stripSentinelLines(text: string, sentinels: Set<string>): string {
  return text
    .split("\n")
    .filter((line) => !sentinels.has(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Recovers the Opus leak: a lone short word (e.g. `court`, `core`) on its own
 * line immediately before every `<invoke>` block, with optional prose around
 * it. Blocks inside fences, or any invoke not prefixed by such a sentinel, are
 * left in the text.
 */
export function parseCourtPrefixedInvokeCalls(text: string): InvokeParseResult {
  const untouched: InvokeParseResult = { toolCalls: [], cleanedText: text };
  const opens = invokeOpensOutsideFences(text);
  if (opens.length === 0) return untouched;
  const sentinels = new Set<string>();
  for (const start of opens) {
    const word = precededBySentinelLine(text, start);
    if (!word) return untouched;
    sentinels.add(word);
  }
  const parsed = parseInvokeToolCalls(text);
  if (parsed.toolCalls.length !== opens.length) return untouched;
  return { toolCalls: parsed.toolCalls, cleanedText: stripSentinelLines(parsed.cleanedText, sentinels) };
}

export interface CourtGateStep {
  /** Prose that cannot be part of a leaked invoke. Safe to stream as text. */
  text: string;
  /** Completed invokes whose markup must not be streamed as text. */
  toolCalls: InvokeToolCall[];
}

type HeldConsumption = { kind: "wait" } | { kind: "release" } | { kind: "tool"; calls: InvokeToolCall[]; rest: string };

const INVOKE_OPEN_PREFIX = '<invoke name="';

/**
 * Holds a possible `court` + `<invoke>` leak out of the text stream until it
 * either completes as a registered tool call or proves it is ordinary prose.
 * Pi paints tool calls from tool-call events; streaming the markup first leaves
 * the raw XML on screen instead of the tool box.
 */
export function createCourtInvokeGate(isRegistered: (name: string) => boolean): {
  push(chunk: string): CourtGateStep;
  finish(): CourtGateStep;
} {
  let pending = "";
  const drain = (flush: boolean): CourtGateStep => {
    let text = "";
    const toolCalls: InvokeToolCall[] = [];
    while (pending.length > 0) {
      const { visible, held } = takeVisibleCourtPrefix(pending);
      text += visible;
      pending = held;
      if (!pending) break;
      const consumed = consumeHeldCourtInvoke(pending, isRegistered);
      if (consumed.kind === "wait") {
        if (!flush) break;
        text += pending;
        pending = "";
        break;
      }
      if (consumed.kind === "release") {
        text += pending;
        pending = "";
        break;
      }
      toolCalls.push(...consumed.calls);
      pending = consumed.rest;
    }
    return { text, toolCalls };
  };
  return {
    push(chunk: string) {
      pending += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

/** Split off a prefix that cannot grow into a lone sentinel line. */
function takeVisibleCourtPrefix(pending: string): { visible: string; held: string } {
  let lineStart = 0;
  while (lineStart < pending.length) {
    const nl = pending.indexOf("\n", lineStart);
    if (nl < 0) {
      const line = pending.slice(lineStart).trim();
      if (line.length > 0 && line.length <= 12 && /^[a-z]+$/.test(line))
        return { visible: pending.slice(0, lineStart), held: pending.slice(lineStart) };
      return { visible: pending, held: "" };
    }
    const line = pending.slice(lineStart, nl);
    if (isSentinelWord(line.trim()) && fenceAround(pending, lineStart) === "outside") {
      return { visible: pending.slice(0, lineStart), held: pending.slice(lineStart) };
    }
    lineStart = nl + 1;
  }
  return { visible: pending, held: "" };
}

function fenceAround(text: string, index: number): "outside" | "closed" | "open" {
  const fence = fencedRanges(text).find((range) => index >= range.start && index < range.end);
  if (!fence) return "outside";
  const closer = text.indexOf(FENCE, fence.start + FENCE.length);
  return closer >= 0 && closer < fence.end ? "closed" : "open";
}

function consumeHeldCourtInvoke(held: string, isRegistered: (name: string) => boolean): HeldConsumption {
  const firstLine = held.split("\n")[0];
  const word = firstLine.trim();
  if (!isSentinelWord(word)) return { kind: "release" };
  const sentinelAt = held.search(new RegExp(`^[ \\t]*${word}[ \\t]*$`, "m"));
  if (sentinelAt >= 0) {
    const fenced = fenceAround(held, sentinelAt);
    if (fenced === "closed") return { kind: "release" };
    if (fenced === "open") return { kind: "wait" };
  }
  if (!held.includes("\n")) return { kind: "wait" };
  const after = held.replace(new RegExp(`^[ \\t]*${word}[ \\t]*\\n`), "");
  if (after.trim() === "") return { kind: "wait" };
  const next = after.trimStart();
  if (INVOKE_OPEN_PREFIX.startsWith(next)) return { kind: "wait" };
  if (!next.startsWith(INVOKE_OPEN_PREFIX)) return { kind: "release" };
  const parsed = parseCourtPrefixedInvokeCalls(held);
  if (parsed.toolCalls.length === 0) return { kind: "wait" };
  if (!parsed.toolCalls.every((call) => isRegistered(call.name))) return { kind: "release" };
  return { kind: "tool", calls: parsed.toolCalls, rest: parsed.cleanedText };
}
