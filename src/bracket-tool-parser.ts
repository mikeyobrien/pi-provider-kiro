// ABOUTME: Extracts bracket-style tool calls from content text as a fallback.
// ABOUTME: Parses [Called func_name with args: {...}] patterns from model output.

import { findJsonEnd } from "./event-parser.js";

export interface BracketToolCall {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BracketParseResult {
  toolCalls: BracketToolCall[];
  cleanedText: string;
}

const BRACKET_PATTERN = /\[Called\s+([\w-]+)\s+with\s+args:\s*/g;

export function parseBracketToolCalls(text: string): BracketParseResult {
  const toolCalls: BracketToolCall[] = [];
  const removals: Array<{ start: number; end: number }> = [];

  // Reset the regex lastIndex to ensure consistent behavior
  BRACKET_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = BRACKET_PATTERN.exec(text);
  while (match !== null) {
    const name = match[1];
    const jsonStart = match.index + match[0].length;

    const braceIdx = text.indexOf("{", jsonStart);
    if (braceIdx >= 0 && braceIdx === jsonStart) {
      const jsonEndIdx = findJsonEnd(text, braceIdx);
      if (jsonEndIdx >= 0) {
        const afterJson = text.indexOf("]", jsonEndIdx + 1);
        if (afterJson >= 0) {
          const between = text.substring(jsonEndIdx + 1, afterJson).trim();
          if (between.length === 0) {
            const jsonStr = text.substring(braceIdx, jsonEndIdx + 1);
            try {
              const args = JSON.parse(jsonStr);
              toolCalls.push({
                toolUseId: crypto.randomUUID(),
                name,
                arguments: args,
              });
              removals.push({ start: match.index, end: afterJson + 1 });
            } catch {
              // Malformed JSON — skip this match
            }
          }
        }
      }
    }
    match = BRACKET_PATTERN.exec(text);
  }

  // Build cleaned text by removing matched bracket patterns (reverse order to preserve indices)
  let cleanedText = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    const { start, end } = removals[i];
    cleanedText = cleanedText.substring(0, start) + cleanedText.substring(end);
  }

  return { toolCalls, cleanedText };
}
