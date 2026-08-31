// ABOUTME: Typed error for Kiro runtime HTTP failures, carrying the class the
// ABOUTME: throw site already computed so consumers need not re-parse the message.

/**
 * Known reason-code markers to scan for when the body is not parseable JSON.
 *
 * Deliberately module-private and deliberately NOT named `KIRO_REASON_CODES`:
 * this is only a fallback marker list for `extractKiroReasonCode`, not a public
 * vocabulary. The literals it shares with `src/retry.ts` (`TOO_BIG_PATTERNS`,
 * `NON_RETRYABLE_BODY_PATTERNS`, `CAPACITY_PATTERN`) are matched there for
 * *classification*, which is a separate concern — `Input is too long` is a
 * classification marker with no reason code, and `REQUEST_BODY_INVALID` is a
 * reason code that must never classify as too-big.
 *
 * Not exhaustive: `reasonCode` is a passthrough of whatever the body carried, so
 * an unrecognized code still reaches the consumer verbatim.
 */
const REASON_CODE_MARKERS = [
  "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  "MONTHLY_REQUEST_COUNT",
  "INSUFFICIENT_MODEL_CAPACITY",
  "REQUEST_BODY_INVALID",
] as const;

/** Retries this provider already performed internally before giving up. */
export interface KiroProviderAttempts {
  /** 403 credential-refresh retries (`exponentialBackoff(n, 500, MAX_RETRY_DELAY)`). */
  credentialRefresh: number;
  /** INSUFFICIENT_MODEL_CAPACITY retries (`capacityRetryConfig`, 5s base / 30s ceiling). */
  capacity: number;
}

/**
 * A Kiro runtime HTTP failure with its classification preserved.
 *
 * `message` is deliberately identical to the string this provider has always
 * thrown: `pi-ai`'s `isContextOverflow()`, `pi-coding-agent`'s outer auto-retry,
 * and downstream consumers all match on that text. The typed fields are
 * strictly additive — read them instead of re-parsing `message`.
 *
 * Note `streamKiro` does not reject with this error: per the pi-ai stream
 * contract it encodes failures into the returned stream. The typed fields reach
 * consumers through the terminal `error` event's
 * `AssistantMessage.diagnostics` entry of type `kiro_api_error`, whose
 * `details` mirror `status` / `reasonCode` / `retryAfterMs` / `providerAttempts`.
 */
export class KiroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasonCode?: string,
    readonly retryAfterMs?: number,
    readonly providerAttempts?: KiroProviderAttempts,
  ) {
    super(message);
    this.name = "KiroApiError";
  }
}

/**
 * Pull Kiro's reason code out of an error body.
 *
 * Prefers the parsed JSON `reason` field, which is what Kiro actually sends
 * (`{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`).
 * Falls back to scanning for a known marker so a plain-text or
 * event-stream-wrapped body still classifies.
 *
 * Returns undefined rather than guessing when the body carries no code: a
 * bare 413 or `Input is too long` has no reason code, and inventing one would
 * make an absent classification indistinguishable from a real one.
 */
export function extractKiroReasonCode(errorText: string): string | undefined {
  if (!errorText) return undefined;
  const trimmed = errorText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { reason?: unknown; reasonCode?: unknown };
      const reason = parsed.reason ?? parsed.reasonCode;
      if (typeof reason === "string" && reason.length > 0) return reason;
    } catch {
      // Fall through to marker scan — a truncated or wrapped body is still useful.
    }
  }
  return REASON_CODE_MARKERS.find((code) => errorText.includes(code));
}

/**
 * Read a retry delay from response headers, in milliseconds.
 *
 * Handles `retry-after-ms` (milliseconds), `retry-after` (delay-seconds or
 * HTTP-date per RFC 9110), and `x-ratelimit-reset-after` (seconds). Tolerates a
 * missing/partial `headers` object because test doubles and non-fetch
 * transports do not always provide one.
 */
export function parseRetryAfterMs(headers: Headers | undefined, now: number = Date.now()): number | undefined {
  const get = headers?.get?.bind(headers);
  if (!get) return undefined;

  // Each header is an independent candidate: a malformed value in one must not
  // suppress a usable value in a later one.
  const ms = nonNegativeNumber(get("retry-after-ms"));
  if (ms !== undefined) return Math.round(ms);

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      // A numeric value is delay-seconds, never a date. Skip Date.parse, which
      // reads "-5" as a year.
      if (seconds >= 0) return Math.round(seconds * 1000);
    } else {
      const date = Date.parse(retryAfter);
      // A past date means "retry now", not a negative delay.
      if (!Number.isNaN(date)) return Math.max(0, date - now);
    }
  }

  const resetAfter = nonNegativeNumber(get("x-ratelimit-reset-after"));
  if (resetAfter !== undefined) return Math.round(resetAfter * 1000);

  return undefined;
}

/**
 * Parse a header value as a finite, non-negative number.
 * Returns undefined for an absent header (`Number(null)` is 0, which would
 * otherwise read as a legitimate zero delay) and for a malformed value.
 */
function nonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
