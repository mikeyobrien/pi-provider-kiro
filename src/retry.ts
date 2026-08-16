// ABOUTME: Stream recovery helpers and Kiro-specific error classification.
// ABOUTME: Keeps provider-local retry logic limited to auth refresh and stream quirks.

import { kiroModels } from "./models.js";

// kiro-cli uses 5-minute read/operation timeouts (DEFAULT_TIMEOUT_DURATION)
// and 5-minute stalled stream grace period. 90s matches the TUI's
// INITIAL_RESPONSE_TIMEOUT_MS for the first event from the backend.
export const FIRST_TOKEN_TIMEOUT = 90_000;

export function firstTokenTimeoutForModel(modelId: string): number {
  // Allow test overrides via retryConfig.firstTokenTimeoutMs
  if (retryConfig.firstTokenTimeoutMs !== FIRST_TOKEN_TIMEOUT) {
    return retryConfig.firstTokenTimeoutMs;
  }
  const model = kiroModels.find((m) => m.id === modelId);
  return model?.firstTokenTimeout ?? FIRST_TOKEN_TIMEOUT;
}

// Mutable config for values that tests need to override
export const retryConfig = {
  firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT,
};

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

export const MAX_RETRY_DELAY = 10_000;

/**
 * Resolve the wait before a mid-stream retry, preferring a server-stated delay.
 *
 * A modeled `ThrottlingException` carries `retryAfterMilliseconds`: the service
 * stating how long its throttle window is. Computing our own exponential
 * backoff instead retries *inside* that window, which is throttled again — the
 * retry attempt is spent rather than used, and the caller pays the full retry
 * budget without ever getting a response. When the server states a delay, that
 * value wins over the computed backoff.
 *
 * The stated delay is clamped to `maxMs`. That cap is a liveness guard: an
 * unbounded server-controlled sleep would let one frame park the stream for
 * arbitrarily long. The tradeoff is real and deliberate — a stated delay longer
 * than `maxMs` is truncated, so for those we still retry before the window
 * elapses, exactly as before. The cap bounds the damage; it does not make a
 * long throttle window fully honored.
 *
 * Absent, negative, and non-finite values are not usable delays and fall back to
 * the computed backoff. An explicit `0` is a real instruction ("retry now") and
 * is honored as such — distinct from absent — since the retry count remains
 * bounded by the caller's `maxRetries`.
 */
export function resolveStreamRetryDelay(
  retryAfterMilliseconds: number | undefined,
  backoffMs: number,
  maxMs: number,
): number {
  if (retryAfterMilliseconds === undefined) return backoffMs;
  if (!Number.isFinite(retryAfterMilliseconds) || retryAfterMilliseconds < 0) return backoffMs;
  return Math.min(retryAfterMilliseconds, maxMs);
}

// Size markers only. "Improperly formed request." is Kiro's generic
// request-validation rejection (reason `REQUEST_BODY_INVALID`) — it is returned
// for a malformed body of any size, including an empty `content` field or a
// history referencing tools absent from the catalog. Classifying it as
// "too big" made every such 400 surface as `context_length_exceeded`, which
// sends the caller into a compaction loop it can never satisfy: the request is
// invalid, not oversized, so no amount of history reduction fixes it.
export const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";
export const CAPACITY_MAX_RETRIES = 3;
export const CAPACITY_BASE_DELAY_MS = 5_000;

// Mutable capacity config for testing
export const capacityRetryConfig = {
  maxRetries: CAPACITY_MAX_RETRIES,
  baseDelayMs: CAPACITY_BASE_DELAY_MS,
};

/** Check whether an HTTP error represents a "request too large" condition. */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => errorText.includes(p)));
}

/** Check whether the response body contains a Kiro-specific non-retryable marker. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => errorText.includes(p));
}

/** Check whether the error is a transient capacity issue worth retrying. */
export function isCapacityError(errorText: string): boolean {
  return errorText.includes(CAPACITY_PATTERN);
}
