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
/** Fallback used when a request-window response carries no valid server hint. */
export const REQUEST_RATE_FALLBACK_DELAY_MS = 10_000;

/** Pull the service's exact JSON `reason` field without retaining or returning the body. */
export function extractKiroReason(errorText: string): string | undefined {
  if (!errorText) return undefined;
  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const reason = (parsed as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.length > 0 ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a server-advertised wait in milliseconds.
 *
 * `retry-after-ms` is milliseconds, numeric `retry-after` and
 * `x-ratelimit-reset-after` are seconds, and an HTTP-date `retry-after` is
 * relative to `nowMs`. Each header is an independent candidate, so an invalid
 * earlier value does not hide a valid later one. A past HTTP date means retry
 * now.
 */
export function parseRetryAfterFromHeaders(
  headers: Headers | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const get = headers?.get?.bind(headers);
  if (!get) return undefined;

  const milliseconds = nonNegativeNumber(get("retry-after-ms"));
  if (milliseconds !== undefined) return Math.round(milliseconds);

  const retryAfter = get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      // Numeric Retry-After is delay-seconds, never a date. In particular,
      // do not let Date.parse reinterpret a negative delay as a year.
      if (seconds >= 0) {
        const delayMs = seconds * 1000;
        if (Number.isFinite(delayMs)) return Math.round(delayMs);
      }
    } else {
      const dateMs = Date.parse(retryAfter);
      if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
    }
  }

  const resetAfterSeconds = nonNegativeNumber(get("x-ratelimit-reset-after"));
  if (resetAfterSeconds !== undefined) {
    const delayMs = resetAfterSeconds * 1000;
    if (Number.isFinite(delayMs)) return Math.round(delayMs);
  }

  return undefined;
}

export function resolveRequestRateRetryDelay(
  headers: Headers | undefined,
  nowMs: number = Date.now(),
): { delayMs: number; advertisedDelayMs?: number; capped: boolean } {
  const advertisedDelayMs = parseRetryAfterFromHeaders(headers, nowMs);
  const requestedDelayMs = advertisedDelayMs ?? REQUEST_RATE_FALLBACK_DELAY_MS;
  return {
    delayMs: Math.min(requestedDelayMs, MAX_RETRY_DELAY),
    ...(advertisedDelayMs !== undefined ? { advertisedDelayMs } : {}),
    capped: requestedDelayMs > MAX_RETRY_DELAY,
  };
}

function nonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

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
   * Per-user request rate exceeded — transient. The service returns it as HTTP
   * 429 and it is scoped to the account, not to a model or a process, so every
   * concurrent caller sees it at once. Retrying after a delay is the only
   * remedy; the request itself is well-formed.
   */
  USER_REQUEST_RATE_EXCEEDED: "USER_REQUEST_RATE_EXCEEDED",
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

/**
 * Rate-limit markers. The reason code is authoritative; the prose form is the
 * message body the service pairs with it, kept so a 429 whose body was
 * truncated or redacted still classifies.
 */
export const RATE_LIMIT_PATTERNS: readonly string[] = Object.freeze([
  KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED,
  "Too many requests",
]);

export const RATE_LIMIT_MAX_RETRIES = 8;
export const RATE_LIMIT_BASE_DELAY_MS = 1_000;
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Mutable rate-limit config for testing and for user-side tuning. */
export const rateLimitRetryConfig = {
  maxRetries: RATE_LIMIT_MAX_RETRIES,
  baseDelayMs: RATE_LIMIT_BASE_DELAY_MS,
  maxDelayMs: RATE_LIMIT_MAX_DELAY_MS,
};

/**
 * Check whether the response is an account-level rate rejection.
 *
 * The status alone is enough: the service only uses 429 for rate/quota, and the
 * hard-quota case (`MONTHLY_REQUEST_COUNT`) is filtered by the caller through
 * `isNonRetryableBodyError` before this runs. The body patterns additionally
 * catch a rate rejection surfaced under a different status.
 */
export function isRateLimitError(status: number, errorText: string): boolean {
  return status === 429 || RATE_LIMIT_PATTERNS.some((p) => errorText.includes(p));
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both forms defined
 * by RFC 9110: delay-seconds and an HTTP-date. Returns undefined when absent or
 * unparseable so the caller falls back to computed backoff.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const raw = headerValue.trim();
  if (raw === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, Math.round(seconds * 1000));
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

/**
 * Delay before the next rate-limit attempt.
 *
 * Uses full jitter — a uniform draw over the whole window rather than a fixed
 * ramp — because every concurrent request of a parallel fan-out is rejected by
 * the same account-level limit at the same instant. A deterministic backoff
 * would retry them all together and reproduce the burst that caused the
 * rejection. A server-supplied `Retry-After` is honored as a floor, with jitter
 * added on top for the same reason.
 */
export function rateLimitBackoff(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const { baseDelayMs, maxDelayMs } = rateLimitRetryConfig;
  const window = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const jittered = baseDelayMs + random() * Math.max(0, window - baseDelayMs);
  if (retryAfterMs === undefined) return Math.round(jittered);
  const spread = Math.min(baseDelayMs, Math.max(0, maxDelayMs - retryAfterMs));
  return Math.round(Math.min(maxDelayMs, retryAfterMs + random() * spread));
}
