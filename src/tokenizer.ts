// ABOUTME: Token counting using js-tiktoken with lazy-loaded cl100k_base encoding.
// ABOUTME: Provides accurate token counts for Kiro API response content.

import { encodingForModel } from "js-tiktoken";

let encoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!encoder) {
    encoder = encodingForModel("gpt-4");
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}
