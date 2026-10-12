import { type KiroHistoryEntry } from "./transform.js";
/** Identifiers for the seven invariants. Names match kiro-agent's
 *  `ValidationRule` enum so diagnostics are greppable across both codebases. */
export declare enum KiroValidationRule {
    STARTS_WITH_USER_MESSAGE = "STARTS_WITH_USER_MESSAGE",
    ENDS_WITH_USER_MESSAGE = "ENDS_WITH_USER_MESSAGE",
    ALTERNATING_MESSAGES = "ALTERNATING_MESSAGES",
    TOOL_USES_AND_RESULTS = "TOOL_USES_AND_RESULTS",
    TOOL_RESULTS_AND_NO_USES = "TOOL_RESULTS_AND_NO_USES",
    TOOL_RESULTS_ORPHAN_IDS = "TOOL_RESULTS_ORPHAN_IDS",
    NON_EMPTY_USER_MESSAGE = "NON_EMPTY_USER_MESSAGE"
}
export declare const KIRO_VALIDATION_MESSAGES: Record<KiroValidationRule, string>;
export interface KiroValidationError {
    /** The invariant that was violated. */
    rule: KiroValidationRule;
    /** Human-readable description. */
    message: string;
    /** Index into the validated conversation where the violation was found. */
    index: number;
}
export interface KiroValidationResult {
    valid: boolean;
    errors: KiroValidationError[];
}
/** The subset describing an unbalanced toolUse/toolResult turn — the shape the
 *  backend rejects as `TOOL_USE_RESULT_MISMATCH`. Probed 2026-08-11: a history
 *  whose final assistant `toolUse` has no matching `toolResult` returns
 *  `400 {"reason":"TOOL_USE_RESULT_MISMATCH"}`. */
export declare const KIRO_TOOL_STRUCTURE_RULES: readonly [KiroValidationRule.TOOL_USES_AND_RESULTS, KiroValidationRule.TOOL_RESULTS_AND_NO_USES, KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS];
export type KiroToolStructureRule = (typeof KIRO_TOOL_STRUCTURE_RULES)[number];
export declare function isKiroToolStructureRule(rule: string): boolean;
/** Text of the synthetic result substituted for a tool result the caller never
 *  supplied. A pure function of nothing — same bytes every time, so a repaired
 *  conversation is byte-stable across retries. */
export declare const SYNTHETIC_FAILED_TOOL_RESULT_TEXT = "Tool use was interrupted and did not produce a result.";
export declare function validateStartsWithUserMessage(entries: KiroHistoryEntry[]): KiroValidationError | null;
export declare function validateEndsWithUserMessage(entries: KiroHistoryEntry[]): KiroValidationError | null;
export declare function validateAlternatingMessages(entries: KiroHistoryEntry[]): KiroValidationError | null;
export declare function validateToolUsesAndResults(entries: KiroHistoryEntry[]): KiroValidationError | null;
export declare function validateToolResultOrphanIds(entries: KiroHistoryEntry[]): KiroValidationError | null;
/** Content **or** tool results — not content unconditionally. This is the rule
 *  that makes an empty `content` on a tool turn correct rather than malformed. */
export declare function validateNonEmptyUserMessages(entries: KiroHistoryEntry[]): KiroValidationError | null;
/** Only the three tool-structure rules, in the order `validateKiroConversation`
 *  reports them. Cheaper than a full pass when only pairing matters. */
export declare function validateKiroToolStructure(entries: KiroHistoryEntry[]): KiroValidationResult;
/**
 * Validates a whole conversation against all seven invariants.
 *
 * `entries` is the full conversation: the outbound `history` followed by the
 * entry for `currentMessage`. Validating history alone would report a spurious
 * `ENDS_WITH_USER_MESSAGE` — this provider's history deliberately ends on the
 * assistant turn whose tool uses the current message answers. Use
 * {@link kiroConversationEntries} to build the array.
 */
export declare function validateKiroConversation(entries: KiroHistoryEntry[]): KiroValidationResult;
/** Assembles the conversation this provider actually sends: history plus the
 *  current user message. */
export declare function kiroConversationEntries(history: KiroHistoryEntry[], currentUserMessage: KiroHistoryEntry["userInputMessage"]): KiroHistoryEntry[];
export interface KiroRepairResult {
    /** The repaired conversation. */
    entries: KiroHistoryEntry[];
    /** Violations found in the input, before repair. Empty when it was valid. */
    diagnostics: KiroValidationError[];
    /** Violations still present after repair. Non-empty means a shape this
     *  repair pass cannot express — report it rather than silently sending. */
    remaining: KiroValidationError[];
}
/**
 * Validates and repairs, rather than throwing. Mirrors what kiro-agent's
 * sanitizer does, in this provider's terms:
 *
 * 1. Drop leading entries until the conversation starts with a user message
 *    that is not a bare tool-result carrier.
 * 2. Consolidate runs of adjacent tool-result-only user messages into one.
 *    This runs **before** orphan-stripping on purpose: a run's later carriers
 *    are preceded by a user entry, not the assistant that issued the tool uses,
 *    so stripping first would judge their results orphaned and discard real
 *    tool output.
 * 3. Strip orphaned and duplicate `toolResults`.
 * 4. Synthesize an ERROR tool result for every assistant `toolUse` still
 *    unanswered.
 * 5. Give a user message that has neither text nor tool results the neutral
 *    {@link EMPTY_CONTENT_PLACEHOLDER}.
 *
 * A repaired conversation is not guaranteed valid: an input that alternates
 * incorrectly for reasons outside these five shapes is reported in
 * `remaining`. Callers log it; nothing here throws.
 */
export declare function repairKiroConversation(entries: KiroHistoryEntry[]): KiroRepairResult;
