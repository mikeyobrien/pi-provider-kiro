export interface ToolUseCall {
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface ToolUseParseResult {
    toolCalls: ToolUseCall[];
    cleanedText: string;
}
/**
 * Recovers tool calls that a model emitted as `<tool_use>{JSON}</tool_use>`
 * text instead of as structured tool-use frames. Mirrors
 * {@link parseBracketToolCalls} and {@link parseInvokeToolCalls}: returns the
 * recovered calls plus the text with each consumed `<tool_use>` span spliced
 * out. A block that cannot be parsed in full is left in the text untouched.
 */
export declare function parseToolUseCalls(text: string): ToolUseParseResult;
