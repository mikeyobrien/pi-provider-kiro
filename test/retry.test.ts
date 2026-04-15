// ABOUTME: Tests for retry decision logic and exponential backoff.
// ABOUTME: Covers all status codes, attempt boundaries, and delay calculations.

import { describe, expect, it } from "vitest";
import {
  exponentialBackoff,
  FIRST_TOKEN_TIMEOUT,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  MAX_RETRY_DELAY,
  retryConfig,
} from "../src/retry.js";

describe("exponentialBackoff", () => {
  it("returns baseMs for attempt 0", () => {
    expect(exponentialBackoff(0, 1000, 30000)).toBe(1000);
  });

  it("doubles delay for each attempt", () => {
    expect(exponentialBackoff(1, 1000, 30000)).toBe(2000);
    expect(exponentialBackoff(2, 1000, 30000)).toBe(4000);
    expect(exponentialBackoff(3, 1000, 30000)).toBe(8000);
  });

  it("caps delay at maxMs", () => {
    expect(exponentialBackoff(10, 1000, 30000)).toBe(30000);
  });

  it("works with custom base", () => {
    expect(exponentialBackoff(0, 500, 10000)).toBe(500);
    expect(exponentialBackoff(1, 500, 10000)).toBe(1000);
  });
});

describe("MAX_RETRY_DELAY", () => {
  it("is exported as 10000ms", () => {
    expect(MAX_RETRY_DELAY).toBe(10000);
  });
});

describe("isNonRetryableBodyError", () => {
  it("returns true for MONTHLY_REQUEST_COUNT", () => {
    expect(isNonRetryableBodyError("MONTHLY_REQUEST_COUNT exceeded")).toBe(true);
  });

  it("returns false for INSUFFICIENT_MODEL_CAPACITY (now retryable)", () => {
    expect(isNonRetryableBodyError("INSUFFICIENT_MODEL_CAPACITY")).toBe(false);
  });

  it("returns false for generic retryable messages", () => {
    expect(isNonRetryableBodyError("Rate limited")).toBe(false);
    expect(isNonRetryableBodyError("Internal Server Error")).toBe(false);
  });
});

describe("isCapacityError", () => {
  it("returns true for INSUFFICIENT_MODEL_CAPACITY", () => {
    expect(isCapacityError("INSUFFICIENT_MODEL_CAPACITY")).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isCapacityError("MONTHLY_REQUEST_COUNT")).toBe(false);
    expect(isCapacityError("Rate limited")).toBe(false);
  });
});

describe("isTooBigError", () => {
  it("returns true for 413 regardless of error text", () => {
    expect(isTooBigError(413, "")).toBe(true);
    expect(isTooBigError(413, "anything")).toBe(true);
  });

  it("returns true for 400 with CONTENT_LENGTH_EXCEEDS_THRESHOLD", () => {
    expect(isTooBigError(400, "CONTENT_LENGTH_EXCEEDS_THRESHOLD")).toBe(true);
  });

  it("returns true for 400 with 'Input is too long'", () => {
    expect(isTooBigError(400, "Input is too long.")).toBe(true);
    expect(isTooBigError(400, "Input is too long for model")).toBe(true);
  });

  it("returns true for 400 with 'Improperly formed'", () => {
    expect(isTooBigError(400, "Improperly formed request")).toBe(true);
  });

  it("returns false for 400 without matching pattern", () => {
    expect(isTooBigError(400, "Invalid parameter: modelId")).toBe(false);
  });

  it("returns false for non-413/400 status codes", () => {
    expect(isTooBigError(429, "CONTENT_LENGTH_EXCEEDS_THRESHOLD")).toBe(false);
    expect(isTooBigError(500, "Input is too long")).toBe(false);
  });
});

describe("FIRST_TOKEN_TIMEOUT", () => {
  it("is exported as 90000ms", () => {
    expect(FIRST_TOKEN_TIMEOUT).toBe(90000);
  });

  it("retryConfig.firstTokenTimeoutMs defaults to FIRST_TOKEN_TIMEOUT", () => {
    expect(retryConfig.firstTokenTimeoutMs).toBe(FIRST_TOKEN_TIMEOUT);
  });

  it("retryConfig.firstTokenTimeoutMs is mutable for testing", () => {
    const original = retryConfig.firstTokenTimeoutMs;
    retryConfig.firstTokenTimeoutMs = 100;
    expect(retryConfig.firstTokenTimeoutMs).toBe(100);
    retryConfig.firstTokenTimeoutMs = original;
  });
});
