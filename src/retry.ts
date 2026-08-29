// ABOUTME: Stream recovery helpers and Kiro-specific error classification.
// ABOUTME: Keeps provider-local retry logic limited to auth refresh and stream quirks.

import { kiroModels } from "./models.js";

// kiro-cli uses 5-minute read/operation timeouts (DEFAULT_TIMEOUT_DURATION)
// and 5-minute stalled stream grace period. 90s matches the TUI's
// INITIAL_RESPONSE_TIMEOUT_MS for the first event from the backend.
export const FIRST_TOKEN_TIMEOUT = 90_000;
/** Maximum wait for the runtime endpoint to return HTTP response headers. */
export const REQUEST_HEADER_TIMEOUT = 90_000;

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
  requestHeaderTimeoutMs: REQUEST_HEADER_TIMEOUT,
};

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

export const MAX_RETRY_DELAY = 10_000;

/**
 * Machine reason codes returned by the Kiro API, plus the one prose marker the
 * service emits without a code (`INPUT_TOO_LONG`).
 *
 * Single source of truth for the provider's error vocabulary: the pattern lists
 * and predicates below are derived from it, and it is re-exported from the
 * package entry point so consumers can classify a code without holding an error
 * instance — e.g. reading a persisted log line. These are the service's own
 * codes, deliberately not renamed or mapped into a provider taxonomy.
 */
export const KIRO_REASON_CODES = Object.freeze({
  /** Request body exceeded the service's size threshold. */
  CONTENT_LENGTH_EXCEEDS_THRESHOLD: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  /** Prose-only size rejection; the service sends no reason code for this one. */
  INPUT_TOO_LONG: "Input is too long",
  /** Monthly request quota exhausted — hard limit, not transient. */
  MONTHLY_REQUEST_COUNT: "MONTHLY_REQUEST_COUNT",
  /** Model capacity temporarily unavailable — transient, worth retrying. */
  INSUFFICIENT_MODEL_CAPACITY: "INSUFFICIENT_MODEL_CAPACITY",
  /**
   * Generic request-validation rejection, returned for a malformed body of any
   * size (empty `content`, history referencing tools absent from the catalog).
   * Not a size signal: classifying it as "too big" makes the caller compact a
   * history that was never the problem, a loop it can never satisfy.
   */
  REQUEST_BODY_INVALID: "REQUEST_BODY_INVALID",
} as const);

export type KiroReasonCode = (typeof KIRO_REASON_CODES)[keyof typeof KIRO_REASON_CODES];

// Size markers only — REQUEST_BODY_INVALID is excluded on purpose (see above).
export const TOO_BIG_PATTERNS: readonly string[] = Object.freeze([
  KIRO_REASON_CODES.CONTENT_LENGTH_EXCEEDS_THRESHOLD,
  KIRO_REASON_CODES.INPUT_TOO_LONG,
]);
export const NON_RETRYABLE_BODY_PATTERNS: readonly string[] = Object.freeze([KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT]);
export const CAPACITY_PATTERN = KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY;
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
