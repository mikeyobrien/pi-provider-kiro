// ABOUTME: Stateful parser for thinking tags in streaming content.
// ABOUTME: Separates thinking blocks from text, supporting multiple tag variants.

import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent } from "@mariozechner/pi-ai";

export const THINKING_START_TAG = "<thinking>";
export const THINKING_END_TAG = "</thinking>";

// All recognized thinking tag variants and their corresponding close tags
const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

// The longest open/close tag determines the hold-back safe length
const MAX_OPEN_TAG_LEN = Math.max(...THINKING_TAG_VARIANTS.map((v) => v.open.length));
const MAX_CLOSE_TAG_LEN = Math.max(...THINKING_TAG_VARIANTS.map((v) => v.close.length));

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_END_TAG;

  constructor(
    private output: AssistantMessage,
    private stream: AssistantMessageEventStream,
  ) {}

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.thinkingExtracted) {
        this.processAfterThinking();
        break;
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (this.textBuffer.length === 0) return;
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
      block.thinking += this.textBuffer;
      this.stream.push({
        type: "thinking_delta",
        contentIndex: this.thinkingBlockIndex,
        delta: this.textBuffer,
        partial: this.output,
      });
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex,
        content: block.thinking,
        partial: this.output,
      });
    } else {
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex;
  }

  private processBeforeThinking(): void {
    // Try each tag variant, pick the earliest match
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }
    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitText(this.textBuffer.slice(0, bestPos));
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }
    const safeLen = Math.max(0, this.textBuffer.length - MAX_OPEN_TAG_LEN);
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }
    const safeLen = Math.max(0, this.textBuffer.length - MAX_CLOSE_TAG_LEN);
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processAfterThinking(): void {
    this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  private emitText(text: string): void {
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent;
    block.text += text;
    this.stream.push({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output });
  }

  private emitThinking(thinking: string): void {
    if (this.thinkingBlockIndex === null) {
      this.thinkingBlockIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    block.thinking += thinking;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    });
  }
}
