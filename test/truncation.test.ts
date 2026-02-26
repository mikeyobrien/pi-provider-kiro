// ABOUTME: Tests for truncation detection and recovery notice injection.
// ABOUTME: Validates wasPreviousResponseTruncated and TRUNCATION_NOTICE.

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "../src/truncation.js";

const ts = Date.now();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistant(stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "some response" }],
    api: "kiro-api",
    provider: "kiro",
    model: "test",
    usage: zeroUsage,
    stopReason,
    timestamp: ts,
  };
}

describe("wasPreviousResponseTruncated", () => {
  it("returns true when last assistant message has stopReason 'length'", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: ts },
      makeAssistant("length"),
      { role: "user", content: "Continue", timestamp: ts },
    ];
    expect(wasPreviousResponseTruncated(messages)).toBe(true);
  });

  it("returns false when last assistant message has stopReason 'stop'", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: ts },
      makeAssistant("stop"),
      { role: "user", content: "Next", timestamp: ts },
    ];
    expect(wasPreviousResponseTruncated(messages)).toBe(false);
  });

  it("returns false when there are no assistant messages", () => {
    const messages: Message[] = [{ role: "user", content: "Hello", timestamp: ts }];
    expect(wasPreviousResponseTruncated(messages)).toBe(false);
  });

  it("returns false for empty messages array", () => {
    expect(wasPreviousResponseTruncated([])).toBe(false);
  });

  it("checks the most recent assistant, not earlier ones", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: ts },
      makeAssistant("length"),
      { role: "user", content: "Continue", timestamp: ts },
      makeAssistant("stop"),
      { role: "user", content: "Thanks", timestamp: ts },
    ];
    expect(wasPreviousResponseTruncated(messages)).toBe(false);
  });

  it("returns true when the most recent assistant was truncated with messages after", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: ts },
      makeAssistant("stop"),
      { role: "user", content: "Continue", timestamp: ts },
      makeAssistant("length"),
      { role: "user", content: "Keep going", timestamp: ts },
    ];
    expect(wasPreviousResponseTruncated(messages)).toBe(true);
  });
});

describe("TRUNCATION_NOTICE", () => {
  it("is a non-empty string", () => {
    expect(TRUNCATION_NOTICE.length).toBeGreaterThan(0);
  });

  it("mentions truncation or continuation", () => {
    const lower = TRUNCATION_NOTICE.toLowerCase();
    expect(lower.includes("truncat") || lower.includes("continu") || lower.includes("cut off")).toBe(true);
  });
});
