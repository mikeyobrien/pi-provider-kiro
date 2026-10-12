import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KiroUsageData } from "./event-parser.js";
import type { KiroUsageTracking } from "./usage-tracking.js";
type Usage = AssistantMessage["usage"] & {
    cacheEstimated?: boolean;
};
/**
 * Estimate repeated prompt tokens as cache reads, then record the successful
 * turn as the next baseline. Mutates `usage` only when every conservative guard
 * passes. Real wire cache counters always win.
 */
export declare function applyCacheEstimate(conversationId: string, usage: Usage, wireUsage: KiroUsageData | null, config: KiroUsageTracking, now?: number): number;
/** Clear estimator state between tests. */
export declare function resetCacheEstimatorForTests(): void;
export {};
