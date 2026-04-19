// ABOUTME: Truncation detection and recovery notice for interrupted Kiro responses.
// ABOUTME: Detects when the previous assistant response was cut off and injects a continuation notice.

import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

export const TRUNCATION_NOTICE =
  "[NOTE: Your previous response was cut off due to length limits. Please continue from where you left off.]";

export function wasPreviousResponseTruncated(messages: Message[]): boolean {
  // Find the most recent assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return (messages[i] as AssistantMessage).stopReason === "length";
    }
  }
  return false;
}

/**
 * Remove messages to fit within a budget while keeping tool_use/tool_result pairs intact.
 * When a message must be removed, its paired counterpart is also removed:
 *   - AssistantMessage with ToolCalls → all matching ToolResultMessages
 *   - ToolResultMessage → the AssistantMessage containing the matching ToolCall
 *
 * Messages are removed from the front (oldest first), preserving the most recent context.
 */
export function truncateMessages(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages) return messages;

  // Build a map of toolCallId → indices for paired removal
  const toolCallIdToAssistantIdx = new Map<string, number>();
  const toolResultIdToIdx = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      for (const content of assistantMsg.content) {
        if ((content as ToolCall).type === "toolCall") {
          toolCallIdToAssistantIdx.set((content as ToolCall).id, i);
        }
      }
    } else if (msg.role === "toolResult") {
      toolResultIdToIdx.set((msg as ToolResultMessage).toolCallId, i);
    }
  }

  // Collect indices to remove, starting from the front
  const toRemove = new Set<number>();

  for (let i = 0; i < messages.length && messages.length - toRemove.size > maxMessages; i++) {
    if (toRemove.has(i)) continue;
    toRemove.add(i);

    const msg = messages[i];
    if (msg.role === "assistant") {
      // Also remove all paired tool results
      const assistantMsg = msg as AssistantMessage;
      for (const content of assistantMsg.content) {
        if ((content as ToolCall).type === "toolCall") {
          const resultIdx = toolResultIdToIdx.get((content as ToolCall).id);
          if (resultIdx !== undefined) toRemove.add(resultIdx);
        }
      }
    } else if (msg.role === "toolResult") {
      // Also remove the paired assistant message (and its other tool results)
      const toolResultMsg = msg as ToolResultMessage;
      const assistantIdx = toolCallIdToAssistantIdx.get(toolResultMsg.toolCallId);
      if (assistantIdx !== undefined && !toRemove.has(assistantIdx)) {
        toRemove.add(assistantIdx);
        // Remove all tool results for that assistant message
        const assistantMsg = messages[assistantIdx] as AssistantMessage;
        for (const content of assistantMsg.content) {
          if ((content as ToolCall).type === "toolCall") {
            const otherResultIdx = toolResultIdToIdx.get((content as ToolCall).id);
            if (otherResultIdx !== undefined) toRemove.add(otherResultIdx);
          }
        }
      }
    }
  }

  return messages.filter((_, i) => !toRemove.has(i));
}
