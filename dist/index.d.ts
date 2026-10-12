import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { resolveApiRegion } from "./endpoints.js";
export type { KiroProviderAttempts } from "./errors.js";
export { KiroApiError } from "./errors.js";
export type { KiroStreamEvent } from "./event-parser.js";
export { isKiroToolStructureRule, KIRO_TOOL_STRUCTURE_RULES, KIRO_VALIDATION_MESSAGES, type KiroRepairResult, type KiroToolStructureRule, type KiroValidationError, type KiroValidationResult, KiroValidationRule, kiroConversationEntries, repairKiroConversation, SYNTHETIC_FAILED_TOOL_RESULT_TEXT, validateKiroConversation, validateKiroToolStructure, } from "./history-validator.js";
export { KiroManagementHttpError } from "./management.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
export type { KiroReasonCode } from "./retry.js";
export { CAPACITY_PATTERN, isCapacityError, isNonRetryableBodyError, isTooBigError, KIRO_REASON_CODES, NON_RETRYABLE_BODY_PATTERNS, TOO_BIG_PATTERNS, } from "./retry.js";
export type { KiroCredentialAccessor, KiroCredentialLike, KiroStreamOptions } from "./stream.js";
export { streamKiro } from "./stream.js";
export { EMPTY_CONTENT_PLACEHOLDER, type KiroHistoryEntry, type KiroToolResult, type KiroToolUse, type KiroUserInputMessage, } from "./transform.js";
/**
 * The post-registration startup work the factory deliberately does not await.
 * Exposed so tests can observe discovery without racing it.
 */
export declare function whenStartupCatalogSettled(): Promise<void>;
/**
 * Synchronous by contract. A host resolves `api: "kiro-api"` the moment a chat
 * starts, and not every host awaits an async extension factory before then, so
 * awaiting catalog discovery here left `kiro-api` unregistered while cached
 * models were still offered in the picker — the first user message then crashed
 * with `No API provider registered for api: kiro-api`. Discovery is kicked off
 * afterwards and the host's `refreshModels` hook fills in the rest.
 */
export default function (pi: ExtensionAPI): void;
