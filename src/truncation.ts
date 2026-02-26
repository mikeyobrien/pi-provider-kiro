// ABOUTME: Truncation detection and recovery notice for interrupted Kiro responses.
// ABOUTME: Detects when the previous assistant response was cut off and injects a continuation notice.

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

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
