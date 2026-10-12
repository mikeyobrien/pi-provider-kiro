import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
export declare const THINKING_START_TAG = "<thinking>";
export declare const THINKING_END_TAG = "</thinking>";
export declare class ThinkingTagParser {
    private output;
    private stream;
    private textBuffer;
    private inThinking;
    private thinkingBlockIndex;
    private textBlockIndex;
    private lastTextBlockIndex;
    private activeEndTag;
    constructor(output: AssistantMessage, stream: AssistantMessageEventStream);
    processChunk(chunk: string): void;
    finalize(): void;
    getTextBlockIndex(): number | null;
    private processBeforeThinking;
    private processInsideThinking;
    private emitText;
    private ensureThinkingBlock;
    private emitThinking;
}
