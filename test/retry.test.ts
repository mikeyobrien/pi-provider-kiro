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
  resolveStreamRetryDelay,
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

describe("resolveStreamRetryDelay", () => {
  it("falls back to the computed backoff when the server states no delay", () => {
    expect(resolveStreamRetryDelay(undefined, 1000, MAX_RETRY_DELAY)).toBe(1000);
  });

  it("prefers a stated delay longer than the computed backoff", () => {
    // The case the blind backoff got wrong: server says 5s, backoff says 1s, so
    // retrying on the backoff lands inside the throttle window and is rejected.
    expect(resolveStreamRetryDelay(5000, 1000, MAX_RETRY_DELAY)).toBe(5000);
  });

  it("prefers a stated delay shorter than the computed backoff", () => {
    // Server direction wins in both directions; it is not a floor on the backoff.
    expect(resolveStreamRetryDelay(500, 8000, MAX_RETRY_DELAY)).toBe(500);
  });

  it("clamps a stated delay to maxMs", () => {
    // Liveness guard: one frame must not be able to park the stream for an
    // arbitrary time. Truncating does mean we retry before this window elapses.
    expect(resolveStreamRetryDelay(60_000, 1000, MAX_RETRY_DELAY)).toBe(MAX_RETRY_DELAY);
  });

  it("passes through a stated delay exactly equal to maxMs", () => {
    expect(resolveStreamRetryDelay(MAX_RETRY_DELAY, 1000, MAX_RETRY_DELAY)).toBe(MAX_RETRY_DELAY);
  });

  it("honors an explicit zero as retry-now rather than treating it as absent", () => {
    // `0` is a real instruction and distinct from an omitted field. The retry
    // count still bounds how many times this can happen.
    expect(resolveStreamRetryDelay(0, 1000, MAX_RETRY_DELAY)).toBe(0);
  });

  it("ignores a negative stated delay", () => {
    expect(resolveStreamRetryDelay(-5000, 1000, MAX_RETRY_DELAY)).toBe(1000);
  });

  it("ignores non-finite stated delays", () => {
    expect(resolveStreamRetryDelay(Number.NaN, 1000, MAX_RETRY_DELAY)).toBe(1000);
    expect(resolveStreamRetryDelay(Number.POSITIVE_INFINITY, 1000, MAX_RETRY_DELAY)).toBe(1000);
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

  // "Improperly formed request." is Kiro's generic request-validation
  // rejection, not a size signal. Reporting it as a too-big error makes the
  // caller compact a history that was never the problem.
  it("returns false for 400 'Improperly formed request'", () => {
    expect(isTooBigError(400, '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}')).toBe(false);
    expect(isTooBigError(400, "Improperly formed request")).toBe(false);
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
