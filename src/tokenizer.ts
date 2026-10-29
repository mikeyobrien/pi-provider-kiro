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
  // Counted text is model output, never encoder controls: a literal control-marker
  // spelling is ordinary text here. With no allowed and no disallowed special
  // tokens it encodes as plain BPE instead of throwing.
  return getEncoder().encode(text, [], []).length;
}
