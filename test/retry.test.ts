// ABOUTME: Tests for retry decision logic and exponential backoff.
// ABOUTME: Covers all status codes, attempt boundaries, and delay calculations.

import { describe, expect, it } from "vitest";
import {
  CAPACITY_PATTERN,
  exponentialBackoff,
  extractKiroReason,
  FIRST_TOKEN_TIMEOUT,
  isCapacityError,
  isNonRetryableBodyError,
  isRateLimitError,
  isTooBigError,
  KIRO_REASON_CODES,
  MAX_RETRY_DELAY,
  NON_RETRYABLE_BODY_PATTERNS,
  parseRetryAfterFromHeaders,
  parseRetryAfterMs,
  RATE_LIMIT_PATTERNS,
  REQUEST_RATE_FALLBACK_DELAY_MS,
  rateLimitBackoff,
  rateLimitRetryConfig,
  resolveRequestRateRetryDelay,
  retryConfig,
  TOO_BIG_PATTERNS,
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

describe("KIRO_REASON_CODES", () => {
  it("exposes the service's codes verbatim", () => {
    expect(KIRO_REASON_CODES).toEqual({
      CONTENT_LENGTH_EXCEEDS_THRESHOLD: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
      INPUT_TOO_LONG: "Input is too long",
      MONTHLY_REQUEST_COUNT: "MONTHLY_REQUEST_COUNT",
      INSUFFICIENT_MODEL_CAPACITY: "INSUFFICIENT_MODEL_CAPACITY",
      USER_REQUEST_RATE_EXCEEDED: "USER_REQUEST_RATE_EXCEEDED",
      REQUEST_BODY_INVALID: "REQUEST_BODY_INVALID",
    });
  });

  it("is frozen so consumers cannot mutate the shared vocabulary", () => {
    expect(Object.isFrozen(KIRO_REASON_CODES)).toBe(true);
    expect(Object.isFrozen(TOO_BIG_PATTERNS)).toBe(true);
    expect(Object.isFrozen(NON_RETRYABLE_BODY_PATTERNS)).toBe(true);
    expect(Object.isFrozen(RATE_LIMIT_PATTERNS)).toBe(true);
  });

  it("is the source the pattern lists derive from", () => {
    expect(TOO_BIG_PATTERNS).toEqual([
      KIRO_REASON_CODES.CONTENT_LENGTH_EXCEEDS_THRESHOLD,
      KIRO_REASON_CODES.INPUT_TOO_LONG,
    ]);
    expect(NON_RETRYABLE_BODY_PATTERNS).toEqual([KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT]);
    expect(CAPACITY_PATTERN).toBe(KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY);
  });

  // REQUEST_BODY_INVALID is published as vocabulary but must not be a size
  // marker: treating it as one sends the caller into an unsatisfiable
  // compaction loop over a history that was never the problem.
  it("keeps REQUEST_BODY_INVALID out of every classification list", () => {
    expect(TOO_BIG_PATTERNS).not.toContain(KIRO_REASON_CODES.REQUEST_BODY_INVALID);
    expect(NON_RETRYABLE_BODY_PATTERNS).not.toContain(KIRO_REASON_CODES.REQUEST_BODY_INVALID);
    expect(isTooBigError(400, KIRO_REASON_CODES.REQUEST_BODY_INVALID)).toBe(false);
  });
});

describe("request-window retry classification", () => {
  it("reads only an exact JSON reason field", () => {
    expect(extractKiroReason('{"message":"slow down","reason":"USER_REQUEST_RATE_EXCEEDED"}')).toBe(
      KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED,
    );
    expect(extractKiroReason('{"reasonCode":"USER_REQUEST_RATE_EXCEEDED"}')).toBeUndefined();
    expect(extractKiroReason("USER_REQUEST_RATE_EXCEEDED")).toBeUndefined();
    expect(extractKiroReason('{"reason":123}')).toBeUndefined();
    expect(extractKiroReason("not json")).toBeUndefined();
  });

  it("parses each supported header with explicit units", () => {
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    expect(parseRetryAfterFromHeaders(new Headers({ "x-ratelimit-reset-after": "1.5" }))).toBe(1500);

    const now = Date.parse("2026-08-29T00:00:00Z");
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after": "Sat, 29 Aug 2026 00:00:02 GMT" }), now)).toBe(2000);
  });

  it("lets a later valid header win after malformed or negative candidates", () => {
    expect(
      parseRetryAfterFromHeaders(
        new Headers({
          "retry-after-ms": "not-a-number",
          "retry-after": "-5",
          "x-ratelimit-reset-after": "2",
        }),
      ),
    ).toBe(2000);
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after-ms": "Infinity" }))).toBeUndefined();
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after": "-1" }))).toBeUndefined();
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after": "1e308", "x-ratelimit-reset-after": "2" }))).toBe(
      2000,
    );
    expect(parseRetryAfterFromHeaders(new Headers({ "x-ratelimit-reset-after": "1e308" }))).toBeUndefined();
  });

  it("treats an elapsed HTTP date as retry-now", () => {
    const now = Date.parse("2026-08-29T00:00:00Z");
    expect(parseRetryAfterFromHeaders(new Headers({ "retry-after": "Fri, 28 Aug 2026 23:59:59 GMT" }), now)).toBe(0);
  });

  it("falls back to 10 seconds and caps longer server hints at 10 seconds", () => {
    expect(REQUEST_RATE_FALLBACK_DELAY_MS).toBe(10_000);
    expect(resolveRequestRateRetryDelay(undefined)).toEqual({ delayMs: 10_000, capped: false });
    expect(resolveRequestRateRetryDelay(new Headers({ "retry-after-ms": "15000" }))).toEqual({
      delayMs: 10_000,
      advertisedDelayMs: 15_000,
      capped: true,
    });
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

describe("isRateLimitError", () => {
  it("classifies any 429 as a rate rejection", () => {
    expect(isRateLimitError(429, "")).toBe(true);
    expect(isRateLimitError(429, "Too many requests, please wait before trying again.")).toBe(true);
  });

  it("classifies the reason code regardless of status", () => {
    expect(isRateLimitError(400, KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED)).toBe(true);
    expect(isRateLimitError(500, "Too many requests")).toBe(true);
  });

  it("leaves unrelated failures alone", () => {
    expect(isRateLimitError(403, "ExpiredTokenException")).toBe(false);
    expect(isRateLimitError(400, KIRO_REASON_CODES.REQUEST_BODY_INVALID)).toBe(false);
    expect(isRateLimitError(500, "internal error")).toBe(false);
  });

  it("exposes the reason code through the pattern list", () => {
    expect(RATE_LIMIT_PATTERNS).toContain(KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED);
  });

  it("overlaps with hard quota, which callers must exclude first", () => {
    // Monthly quota also arrives as 429; the caller checks
    // isNonRetryableBodyError() before isRateLimitError() for that reason.
    const monthly = KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT;
    expect(isRateLimitError(429, monthly)).toBe(true);
    expect(isNonRetryableBodyError(monthly)).toBe(true);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
    expect(parseRetryAfterMs("1.5")).toBe(1500);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(parseRetryAfterMs("Sat, 29 Aug 2026 10:00:05 GMT", now)).toBe(5000);
  });

  it("clamps a past HTTP-date to zero", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(parseRetryAfterMs("Sat, 29 Aug 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("rateLimitBackoff", () => {
  it("jitters within a growing window instead of a fixed ramp", () => {
    const { baseDelayMs } = rateLimitRetryConfig;
    expect(rateLimitBackoff(0, undefined, () => 0)).toBe(baseDelayMs);
    // Attempt 2 window is base*4; full jitter spans [base, base*4].
    expect(rateLimitBackoff(2, undefined, () => 0)).toBe(baseDelayMs);
    expect(rateLimitBackoff(2, undefined, () => 1)).toBe(baseDelayMs * 4);
    expect(rateLimitBackoff(2, undefined, () => 0.5)).toBe(baseDelayMs * 2.5);
  });

  it("never exceeds maxDelayMs", () => {
    expect(rateLimitBackoff(30, undefined, () => 1)).toBe(rateLimitRetryConfig.maxDelayMs);
  });

  it("treats Retry-After as a floor and adds jitter on top", () => {
    expect(rateLimitBackoff(0, 5000, () => 0)).toBe(5000);
    expect(rateLimitBackoff(0, 5000, () => 1)).toBe(5000 + rateLimitRetryConfig.baseDelayMs);
  });

  it("caps a Retry-After beyond the ceiling", () => {
    expect(rateLimitBackoff(0, rateLimitRetryConfig.maxDelayMs + 10_000, () => 1)).toBe(
      rateLimitRetryConfig.maxDelayMs,
    );
  });

  it("spreads two simultaneous rejections apart", () => {
    // Same attempt number, different draws — the point of full jitter.
    const a = rateLimitBackoff(3, undefined, () => 0.1);
    const b = rateLimitBackoff(3, undefined, () => 0.9);
    expect(a).not.toBe(b);
  });
});
