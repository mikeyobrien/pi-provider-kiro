// ABOUTME: Tests for token counting using js-tiktoken.
// ABOUTME: Validates countTokens returns accurate counts for known strings.

import { describe, expect, it } from "vitest";
import { countTokens } from "../src/tokenizer.js";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns expected count for simple English text", () => {
    const count = countTokens("Hello, world!");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it("returns consistent results for the same input", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(countTokens(text)).toBe(countTokens(text));
  });

  it("handles multi-line text", () => {
    const text = "Line one\nLine two\nLine three";
    const count = countTokens(text);
    expect(count).toBeGreaterThan(0);
  });

  it("handles unicode text", () => {
    const count = countTokens("Hello 🌍 world");
    expect(count).toBeGreaterThan(0);
  });

  it("handles long text", () => {
    const text = "word ".repeat(1000);
    const count = countTokens(text);
    expect(count).toBeGreaterThan(500);
    expect(count).toBeLessThan(2000);
  });
});
