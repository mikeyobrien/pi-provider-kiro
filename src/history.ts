// Feature 6: History Management

import type { KiroHistoryEntry, KiroToolSpec } from "./transform.js";

export const HISTORY_LIMIT = 850000;

/** Remove images from history entries — they've already been processed by the
 *  model in previous turns and re-sending them wastes context / causes 413s. */
export function stripHistoryImages(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  return history.map((entry) => {
    if (!entry.userInputMessage?.images) return entry;
    const { images, ...rest } = entry.userInputMessage;
    return { ...entry, userInputMessage: { ...rest } };
  });
}

export function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  // Strip leading entries that would make the history invalid
  while (history.length > 0 && (!history[0]?.userInputMessage || history[0].userInputMessage.userInputMessageContext?.toolResults))
    history = history.slice(1);
  const result: KiroHistoryEntry[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m) continue;
    // Skip assistant messages with no content and no tool uses (e.g. from API errors)
    if (m.assistantResponseMessage && !m.assistantResponseMessage.toolUses && !m.assistantResponseMessage.content)
      continue;
    if (m.assistantResponseMessage?.toolUses) {
      const next = history[i + 1];
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) result.push(m);
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1];
      if (prev?.assistantResponseMessage?.toolUses) result.push(m);
    } else {
      result.push(m);
    }
  }
  // Leading invalid entries already stripped above
  return result;
}

export function injectSyntheticToolCalls(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  const validIds = new Set<string>();
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.toolUseId) validIds.add(tu.toolUseId);
    }
  }
  const result: KiroHistoryEntry[] = [];
  for (const entry of history) {
    const toolResults = entry.userInputMessage?.userInputMessageContext?.toolResults;
    if (toolResults) {
      const orphaned = toolResults.filter((tr) => !validIds.has(tr.toolUseId));
      if (orphaned.length > 0) {
        result.push({
          assistantResponseMessage: {
            content: "Tool calls were made.",
            toolUses: orphaned.map((tr) => ({ name: "unknown_tool", toolUseId: tr.toolUseId, input: {} })),
          },
        });
        for (const tr of orphaned) validIds.add(tr.toolUseId);
      }
    }
    result.push(entry);
  }
  return result;
}

export function truncateHistory(history: KiroHistoryEntry[], limit: number): KiroHistoryEntry[] {
  let sanitized = sanitizeHistory(stripHistoryImages(history));
  let historySize = JSON.stringify(sanitized).length;
  while (historySize > limit && sanitized.length > 2) {
    sanitized.shift();
    while (sanitized.length > 0 && !sanitized[0]?.userInputMessage) sanitized.shift();
    sanitized = sanitizeHistory(sanitized);
    historySize = JSON.stringify(sanitized).length;
  }
  return injectSyntheticToolCalls(sanitized);
}

export function extractToolNamesFromHistory(history: KiroHistoryEntry[]): Set<string> {
  const names = new Set<string>();
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.name) names.add(tu.name);
    }
  }
  return names;
}

export function addPlaceholderTools(tools: KiroToolSpec[], history: KiroHistoryEntry[]): KiroToolSpec[] {
  const historyNames = extractToolNamesFromHistory(history);
  if (historyNames.size === 0) return tools;
  const existing = new Set(tools.map((t) => t.toolSpecification?.name).filter(Boolean));
  const missing = Array.from(historyNames).filter((n) => !existing.has(n));
  if (missing.length === 0) return tools;
  return [
    ...tools,
    ...missing.map((name) => ({
      toolSpecification: {
        name,
        description: "Tool",
        inputSchema: { json: { type: "object" as const, properties: {} } },
      },
    })),
  ];
}
