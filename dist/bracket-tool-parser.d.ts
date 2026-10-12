export declare function findJsonEnd(text: string, start: number): number;
export interface BracketToolCall {
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface BracketParseResult {
    toolCalls: BracketToolCall[];
    cleanedText: string;
}
export declare function parseBracketToolCalls(text: string): BracketParseResult;
