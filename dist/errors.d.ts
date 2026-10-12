export { parseRetryAfterMs } from "./retry.js";
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
export declare class KiroApiError extends Error {
    readonly status: number;
    readonly reasonCode?: string | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly providerAttempts?: KiroProviderAttempts | undefined;
    constructor(message: string, status: number, reasonCode?: string | undefined, retryAfterMs?: number | undefined, providerAttempts?: KiroProviderAttempts | undefined);
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
export declare function extractKiroReasonCode(errorText: string): string | undefined;
