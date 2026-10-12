/**
 * Kiro's published add-on credit rate (https://kiro.dev/pricing/). Used as the
 * conversion default so an enabled config needs no rate at all.
 */
export declare const DEFAULT_USD_PER_CREDIT = 0.04;
/** Match Pi's prompt-cache TTL and Anthropic's default cache lifetime. */
export declare const DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS: number;
/** Resolved estimation policy. Both estimates are independently opt-in. */
export interface KiroUsageTracking {
    estimateDollarValue: boolean;
    usdPerCredit: number;
    estimateCacheUsage: boolean;
    estimatedCacheTimeout: number;
}
/**
 * Load estimation policy from pi's settings file.
 *
 * Each estimate fails closed independently on malformed input. Settings contents
 * are never logged because the file may contain credentials for other providers.
 */
export declare function loadKiroUsageTracking(agentDir?: string): KiroUsageTracking;
/**
 * Estimated USD-equivalent value of one turn's credits, or `undefined` when the
 * record cannot be trusted.
 *
 * This is a conversion of Kiro's own credit count, NOT a billed amount: credits
 * included in a subscription may carry no marginal charge at all.
 */
export declare function estimateKiroCreditCost(tracking: KiroUsageTracking, metering: {
    credits?: number;
    unit?: string;
} | null | undefined): number | undefined;
/** pi's agent directory, honoring the same override pi itself reads. */
export declare function getPiAgentDir(): string;
