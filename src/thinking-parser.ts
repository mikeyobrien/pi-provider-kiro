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

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) {
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  }
  return maxLength;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_END_TAG;
  /** Number of leading \n chars still to strip after a closing thinking tag. */
  private separatorNewlinesRemaining = 0;

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
    // Strip any remaining separator newlines from the thinking→text boundary.
    this.stripSeparatorNewlines();
    if (this.textBuffer.length === 0 && !this.inThinking) return;
    if (this.inThinking) {
      // Bug fix: when all thinking content is shorter than MAX_CLOSE_TAG_LEN,
      // emitThinking() was never called during streaming (safeLen stayed 0),
      // so thinkingBlockIndex is null. Flush held-back content as thinking,
      // not text.
      if (this.textBuffer.length > 0) this.emitThinking(this.textBuffer);
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
    } else {
      if (this.textBuffer.length > 0) this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex;
  }

  private processBeforeThinking(): void {
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

    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(
      this.textBuffer,
      THINKING_TAG_VARIANTS.map((variant) => variant.open),
    );
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      // Ensure thinking block exists even if empty (endPos === 0), so that
      // thinking_start/thinking_end events are always emitted as a pair.
      if (this.thinkingBlockIndex === null) this.initThinkingBlock();
      const block = this.output.content[this.thinkingBlockIndex!] as ThinkingContent;
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex!,
        content: block.thinking,
        partial: this.output,
      });
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      // Mark that we need to strip up to 2 newlines separating thinking from text.
      // They may arrive in the same buffer, a later chunk, or one char at a time.
      this.separatorNewlinesRemaining = 2;
      this.stripSeparatorNewlines();
      return;
    }

    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processAfterThinking(): void {
    this.stripSeparatorNewlines();
    if (this.textBuffer.length > 0) this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  /** Strip up to separatorNewlinesRemaining leading \n chars from the buffer. */
  private stripSeparatorNewlines(): void {
    while (this.separatorNewlinesRemaining > 0 && this.textBuffer.startsWith("\n")) {
      this.textBuffer = this.textBuffer.slice(1);
      this.separatorNewlinesRemaining--;
    }
    // If the next char is not \n, stop trying (the separator is incomplete or absent)
    if (this.textBuffer.length > 0 && !this.textBuffer.startsWith("\n")) {
      this.separatorNewlinesRemaining = 0;
    }
  }

  private emitText(text: string): void {
    if (!text) return;
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent;
    block.text += text;
    this.stream.push({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output });
  }

  private initThinkingBlock(): void {
    if (this.thinkingBlockIndex !== null) return;
    this.thinkingBlockIndex = this.output.content.length;
    this.output.content.push({ type: "thinking", thinking: "" });
    this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    this.initThinkingBlock();
    const block = this.output.content[this.thinkingBlockIndex!] as ThinkingContent;
    block.thinking += thinking;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex!,
      delta: thinking,
      partial: this.output,
    });
  }
}
