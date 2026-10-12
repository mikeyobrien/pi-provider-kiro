import type { KiroHistoryEntry, KiroToolSpec } from "./transform.js";
export declare const HISTORY_LIMIT = 850000;
/** The context window size (in tokens) that HISTORY_LIMIT was calibrated for. */
export declare const HISTORY_LIMIT_CONTEXT_WINDOW = 200000;
/** Maximum combined base64 characters retained for one historical image-bearing turn. */
export declare const HISTORY_IMAGE_BASE64_LIMIT: number;
/**
 * Keep at most the newest bounded image-bearing history entry.
 *
 * Older images are removed to bound request growth. If the newest image set is
 * itself too large, remove it as well rather than substituting an older image
 * that no longer matches a follow-up such as "look at that image again".
 */
export declare function stripHistoryImages(history: KiroHistoryEntry[], keepNewestBounded?: boolean): KiroHistoryEntry[];
export declare function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[];
export declare function injectSyntheticToolCalls(history: KiroHistoryEntry[]): KiroHistoryEntry[];
export declare function prepareHistory(history: KiroHistoryEntry[], keepNewestBoundedImage?: boolean): KiroHistoryEntry[];
/** Fail before sending rather than silently discarding conversation context. */
export declare function assertHistoryWithinLimit(history: KiroHistoryEntry[], limit: number): void;
export declare function extractToolNamesFromHistory(history: KiroHistoryEntry[]): Set<string>;
export declare function addPlaceholderTools(tools: KiroToolSpec[], history: KiroHistoryEntry[]): KiroToolSpec[];
