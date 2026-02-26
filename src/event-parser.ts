// ABOUTME: Kiro stream event parsing for JSON-based streaming responses.
// ABOUTME: Extracts typed events from raw buffered stream data.

export type KiroStreamEvent =
  | { type: "content"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: { inputTokens?: number; outputTokens?: number } };

export function findJsonEnd(text: string, start: number): number {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

export function parseKiroEvent(parsed: Record<string, unknown>): KiroStreamEvent | null {
  if (parsed.content !== undefined) return { type: "content", data: parsed.content as string };
  if (parsed.name && parsed.toolUseId) {
    const input =
      typeof parsed.input === "string"
        ? parsed.input
        : parsed.input &&
            typeof parsed.input === "object" &&
            Object.keys(parsed.input as Record<string, unknown>).length > 0
          ? JSON.stringify(parsed.input)
          : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        stop: parsed.stop as boolean | undefined,
      },
    };
  }
  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: "toolUseInput",
      data: { input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input) },
    };
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined)
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  if (parsed.contextUsagePercentage !== undefined)
    return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage as number } };
  if (parsed.followupPrompt !== undefined) return { type: "followupPrompt", data: parsed.followupPrompt as string };
  if (parsed.usage !== undefined) {
    const u = parsed.usage as Record<string, unknown>;
    return {
      type: "usage",
      data: { inputTokens: u.inputTokens as number | undefined, outputTokens: u.outputTokens as number | undefined },
    };
  }
  return null;
}

// Known JSON key patterns that start Kiro event objects. Using specific
// patterns avoids matching stray '{"' sequences in the binary AWS Event
// Stream framing that wraps each JSON payload.
const EVENT_PATTERNS = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"followupPrompt":',
  '{"usage":',
  '{"toolUseId":',
  '{"unit":',
];

function findNextEventStart(buffer: string, from: number): number {
  let earliest = -1;
  for (const pattern of EVENT_PATTERNS) {
    const idx = buffer.indexOf(pattern, from);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

export function parseKiroEvents(buffer: string): { events: KiroStreamEvent[]; remaining: string } {
  const events: KiroStreamEvent[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) break;

    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      // Incomplete JSON at end of buffer — preserve for next call
      return { events, remaining: buffer.substring(jsonStart) };
    }

    try {
      const parsed = JSON.parse(buffer.substring(jsonStart, jsonEnd + 1));
      const event = parseKiroEvent(parsed);
      if (event) events.push(event);
    } catch {
      /* skip brace-balanced but non-JSON content */
    }
    pos = jsonEnd + 1;
  }

  return { events, remaining: "" };
}
