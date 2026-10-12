import type { ImageContent, Message, Tool, UserMessage } from "@earendil-works/pi-ai";
export interface KiroImage {
    format: string;
    source: {
        bytes: string;
    };
}
export interface KiroToolUse {
    name: string;
    toolUseId: string;
    input: Record<string, unknown>;
}
export interface KiroToolResult {
    content: Array<{
        text: string;
    }>;
    status: "success" | "error";
    toolUseId: string;
}
export interface KiroToolSpec {
    toolSpecification: {
        name: string;
        description: string;
        inputSchema: {
            json: Record<string, unknown>;
        };
    };
}
export interface KiroUserInputMessage {
    content: string;
    modelId: string;
    origin: "KIRO_CLI";
    images?: KiroImage[];
    userInputMessageContext?: {
        toolResults?: KiroToolResult[];
        tools?: KiroToolSpec[];
    };
}
export interface KiroAssistantResponseMessage {
    content: string;
    toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
    userInputMessage?: KiroUserInputMessage;
    assistantResponseMessage?: KiroAssistantResponseMessage;
}
/** Canonical message shape emitted by newer Pi-compatible hosts after their
 * application-level custom messages have passed through `convertToLlm`.
 * Kiro has no developer wire role, so these are lowered to user messages at
 * the transport boundary. Raw application roles remain the host's concern. */
type DeveloperMessage = Omit<UserMessage, "role"> & {
    role: "developer";
};
type KiroInputMessage = Message | DeveloperMessage;
export declare const TOOL_RESULT_LIMIT = 250000;
/** Kiro's own requirement is content **or** tool results, not content
 *  unconditionally. First-party Kiro Agent states it as an explicit invariant
 *  — `NON_EMPTY_USER_MESSAGE`: "User messages must have either content or tool
 *  results" — and its validator implements `hasContent || hasToolResults`
 *  (`packages/kiro-agent/src/utils/message-history-sanitizer/validator.ts`).
 *  It ships `content: ''` on synthesized and consolidated tool turns.
 *
 *  A tool turn therefore needs no text: its payload is
 *  `userInputMessageContext.toolResults`. Wire-probed 2026-08-11 against
 *  `runtime.us-east-1.kiro.dev/generateAssistantResponse` with
 *  `origin: "KIRO_CLI"`, `content: ""` and a populated `toolResults` — HTTP
 *  200, request id c5e6832d-f6da-4e33-a5e9-2e6107dbcf83.
 *
 *  This placeholder remains for the case it was added for (#106): a turn that
 *  reaches the request builder with neither text nor tool results — an
 *  image-only user message, an empty-text user message, or a host-appended
 *  message whose role falls outside pi-ai's `Message` union. Send a neutral
 *  prompt there so the attachments still reach the model. Do not apply it to
 *  tool turns; that fabricates a user utterance the model reads as human. */
export declare const EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";
export declare function sanitizeSurrogates(text: string): string;
export declare function truncate(text: string, limit: number): string;
/**
 * Preserve native Kiro tool IDs, but deterministically remap IDs from providers
 * whose syntax Kiro rejects (for example OpenAI Responses' 83-character
 * `call_…|fc_…` IDs). Tool uses and results are transformed independently, so
 * the mapping must be stable rather than random.
 */
export declare function toKiroToolUseId(toolUseId: string): string;
export declare function normalizeMessages(messages: KiroInputMessage[]): Message[];
/**
 * Move each `toolResult` to sit immediately after the assistant turn that
 * issued its `toolCall`, matching by id.
 *
 * Concurrent tool executions appending to one transcript can interleave, so a
 * result arrives behind a LATER assistant turn than the one that called it:
 *
 *     assistant(toolUses=[A]) / user(text) / assistant(toolUses=[B]) / toolResult(A)
 *
 * Bedrock requires the message after a tool use to carry that use's results,
 * matched by id, so this shape is rejected with `400 TOOL_USE_RESULT_MISMATCH`.
 * Without this pass the downstream repair still makes the request sendable, but
 * only by discarding `A`'s real output: `sanitizeHistory` tests pairing
 * POSITIONALLY and drops `assistant(toolUses=[A])` because its next entry is
 * the interjection, after which `A`'s result answers nothing and is stripped.
 *
 * This is a pure reorder. Nothing is fabricated, dropped, or rewritten, and a
 * result whose `toolCall` appears nowhere is left in place for
 * `injectSyntheticToolCalls` to handle. A well-formed transcript — where every
 * result already follows its call — is returned unchanged.
 *
 * The cost is wire chronology: a user turn that interrupted between the call
 * and its result now appears AFTER that result. That misplaces when the user
 * spoke, which is a fidelity loss, but it is not fabrication and it is strictly
 * less lossy than discarding real tool output the model is waiting on.
 */
export declare function relocateDisplacedToolResults(messages: Message[]): Message[];
export declare function extractImages(msg: Message): ImageContent[];
export declare function getContentText(msg: Message): string;
export declare function convertToolsToKiro(tools: Tool[]): KiroToolSpec[];
export declare function convertImagesToKiro(images: Array<{
    mimeType: string;
    data: string;
}>): KiroImage[];
export declare function buildHistory(messages: Message[], modelId: string, systemPrompt?: string): {
    history: KiroHistoryEntry[];
    systemPrepended: boolean;
    currentMsgStartIdx: number;
};
export {};
