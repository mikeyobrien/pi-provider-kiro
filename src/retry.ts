// ABOUTME: Retry decision logic and exponential backoff for Kiro API requests.
// ABOUTME: Centralizes retry strategy selection based on HTTP status codes.

export const FIRST_TOKEN_TIMEOUT = 15_000;

// Mutable config for values that tests need to override
export const retryConfig = {
  firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT,
};

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  strategy: "reduce" | "backoff" | "none";
}

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];

export function decideRetry(status: number, errorText: string, attempt: number, maxRetries: number): RetryDecision {
  if (attempt >= maxRetries) return { shouldRetry: false, delayMs: 0, strategy: "none" };

  // 413 or 400 with size-related error text → reduce request size
  if (status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => errorText.includes(p)))) {
    return { shouldRetry: true, delayMs: 0, strategy: "reduce" };
  }

  // 429 rate limited → backoff with 1s base
  if (status === 429) {
    return { shouldRetry: true, delayMs: exponentialBackoff(attempt, 1000, 30000), strategy: "backoff" };
  }

  // 5xx server errors → backoff with 1s base
  if (status >= 500 && status < 600) {
    return { shouldRetry: true, delayMs: exponentialBackoff(attempt, 1000, 30000), strategy: "backoff" };
  }

  // 403 transient auth race → shorter backoff with 500ms base
  if (status === 403) {
    return { shouldRetry: true, delayMs: exponentialBackoff(attempt, 500, 30000), strategy: "backoff" };
  }

  return { shouldRetry: false, delayMs: 0, strategy: "none" };
}
