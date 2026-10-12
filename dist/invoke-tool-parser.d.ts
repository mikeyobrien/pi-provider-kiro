export interface InvokeToolCall {
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface InvokeParseResult {
    toolCalls: InvokeToolCall[];
    cleanedText: string;
}
/**
 * Recovers tool calls that a model emitted as XML text instead of as structured
 * tool-use frames. Mirrors {@link parseBracketToolCalls}: returns the recovered
 * calls plus the text with each consumed `<invoke>` span spliced out. A block
 * that cannot be parsed in full is left in the text untouched.
 */
export declare function parseInvokeToolCalls(text: string): InvokeParseResult;
/**
 * Recovers the Opus leak: a lone `court` line immediately before every
 * `<invoke>` block, with optional prose around it. Blocks inside fences, or
 * any invoke that is not prefixed by that sentinel, are left in the text.
 */
export declare function parseCourtPrefixedInvokeCalls(text: string): InvokeParseResult;
