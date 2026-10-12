export declare const FIRST_TOKEN_TIMEOUT = 90000;
/** Maximum wait for the runtime endpoint to return HTTP response headers. */
export declare const REQUEST_HEADER_TIMEOUT = 90000;
export declare function firstTokenTimeoutForModel(modelId: string): number;
export declare const retryConfig: {
    firstTokenTimeoutMs: number;
    requestHeaderTimeoutMs: number;
};
export declare function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number;
export declare const MAX_RETRY_DELAY = 10000;
/** Fallback used when a request-window response carries no valid server hint. */
export declare const REQUEST_RATE_FALLBACK_DELAY_MS = 10000;
/** Pull the service's exact JSON `reason` field without retaining or returning the body. */
export declare function extractKiroReason(errorText: string): string | undefined;
/**
 * Read a server-advertised wait in milliseconds.
 *
 * `retry-after-ms` is milliseconds, numeric `retry-after` and
 * `x-ratelimit-reset-after` are seconds, and an HTTP-date `retry-after` is
 * relative to `nowMs`. Each header is an independent candidate, so an invalid
 * earlier value does not hide a valid later one. A past HTTP date means retry
 * now.
 */
export declare function parseRetryAfterMs(headers: Headers | undefined, nowMs?: number): number | undefined;
export declare function resolveRequestRateRetryDelay(headers: Headers | undefined, nowMs?: number): {
    delayMs: number;
    advertisedDelayMs?: number;
    capped: boolean;
};
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
export declare const KIRO_REASON_CODES: Readonly<{
    /** Request body exceeded the service's size threshold. */
    readonly CONTENT_LENGTH_EXCEEDS_THRESHOLD: "CONTENT_LENGTH_EXCEEDS_THRESHOLD";
    /** Prose-only size rejection; the service sends no reason code for this one. */
    readonly INPUT_TOO_LONG: "Input is too long";
    /** Monthly request quota exhausted — hard limit, not transient. */
    readonly MONTHLY_REQUEST_COUNT: "MONTHLY_REQUEST_COUNT";
    /** Model capacity temporarily unavailable — transient, worth retrying. */
    readonly INSUFFICIENT_MODEL_CAPACITY: "INSUFFICIENT_MODEL_CAPACITY";
    /** Short-window request throttle — retry only within the provider budget. */
    readonly USER_REQUEST_RATE_EXCEEDED: "USER_REQUEST_RATE_EXCEEDED";
    /**
     * Generic request-validation rejection, returned for a malformed body of any
     * size (empty `content`, history referencing tools absent from the catalog).
     * Not a size signal: classifying it as "too big" makes the caller compact a
     * history that was never the problem, a loop it can never satisfy.
     */
    readonly REQUEST_BODY_INVALID: "REQUEST_BODY_INVALID";
}>;
export type KiroReasonCode = (typeof KIRO_REASON_CODES)[keyof typeof KIRO_REASON_CODES];
export declare const TOO_BIG_PATTERNS: readonly string[];
export declare const NON_RETRYABLE_BODY_PATTERNS: readonly string[];
export declare const CAPACITY_PATTERN: "INSUFFICIENT_MODEL_CAPACITY";
export declare const CAPACITY_MAX_RETRIES = 3;
export declare const CAPACITY_BASE_DELAY_MS = 5000;
export declare const capacityRetryConfig: {
    maxRetries: number;
    baseDelayMs: number;
};
/** Check whether an HTTP error represents a "request too large" condition. */
export declare function isTooBigError(status: number, errorText: string): boolean;
/** Check whether the response body contains a Kiro-specific non-retryable marker. */
export declare function isNonRetryableBodyError(errorText: string): boolean;
/** Check whether the error is a transient capacity issue worth retrying. */
export declare function isCapacityError(errorText: string): boolean;
