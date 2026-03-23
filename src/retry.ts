// ABOUTME: Stream recovery helpers and Kiro-specific error classification.
// ABOUTME: Keeps provider-local retry logic limited to auth refresh and stream quirks.

// kiro-cli uses 5-minute read/operation timeouts (DEFAULT_TIMEOUT_DURATION)
// and 5-minute stalled stream grace period. 90s matches the TUI's
// INITIAL_RESPONSE_TIMEOUT_MS for the first event from the backend.
export const FIRST_TOKEN_TIMEOUT = 90_000;

// Mutable config for values that tests need to override
export const retryConfig = {
  firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT,
};

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

export const MAX_RETRY_DELAY = 10_000;

export const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT", "INSUFFICIENT_MODEL_CAPACITY"];

/** Check whether an HTTP error represents a "request too large" condition. */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => errorText.includes(p)));
}

/** Check whether the response body contains a Kiro-specific non-retryable marker. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => errorText.includes(p));
}
