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
