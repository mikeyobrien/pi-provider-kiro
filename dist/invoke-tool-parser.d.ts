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
 * Recovers the Opus leak: a lone short word (e.g. `court`, `core`) on its own
 * line immediately before every `<invoke>` block, with optional prose around
 * it. Blocks inside fences, or any invoke not prefixed by such a sentinel, are
 * left in the text.
 */
export declare function parseCourtPrefixedInvokeCalls(text: string): InvokeParseResult;
/**
 * True when an `<invoke` outside fenced code has no matching `</invoke>`.
 * Opus at high context sometimes stops the turn inside that markup, so the
 * call cannot be recovered and the agent loop would otherwise end on `stop`.
 */
export declare function hasUnclosedInvoke(text: string): boolean;
/** Drop an unclosed invoke, plus a lone sentinel word on the line before it. */
export declare function stripUnclosedInvoke(text: string): string;
export interface CourtGateStep {
    /** Prose that cannot be part of a leaked invoke. Safe to stream as text. */
    text: string;
    /** Completed invokes whose markup must not be streamed as text. */
    toolCalls: InvokeToolCall[];
}
/**
 * Holds a possible `court` + `<invoke>` leak out of the text stream until it
 * either completes as a registered tool call or proves it is ordinary prose.
 * Pi paints tool calls from tool-call events; streaming the markup first leaves
 * the raw XML on screen instead of the tool box.
 */
export declare function createCourtInvokeGate(isRegistered: (name: string) => boolean): {
    push(chunk: string): CourtGateStep;
    finish(): CourtGateStep;
};
