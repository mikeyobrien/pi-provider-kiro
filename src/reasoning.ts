import { createHash } from "node:crypto";
import type { AssistantMessage, ThinkingContent, Tool } from "@earendil-works/pi-ai";

export interface KiroReasoning {
  text?: string;
  signature?: string;
  redactedContent?: string;
}
export type KiroThinking = ThinkingContent & {
  kiroReasoning?: { modelId: string; requestDigest: string; redactedContent?: string };
};

/** Bind opaque reasoning to its model and instruction/tool configuration. */
export function reasoningDigest(systemPrompt: string | undefined, tools: Tool[]): string {
  return createHash("sha256")
    .update(JSON.stringify([systemPrompt ?? "", tools]))
    .digest("hex");
}

/** The wire envelope has one reasoning slot. Never splice multiple sealed blocks. */
export function reasoningForHistory(
  message: AssistantMessage,
  modelId: string,
  requestDigest?: string,
): KiroReasoning | undefined {
  if (message.provider !== "kiro" || !requestDigest) return undefined;
  const sealed = message.content.filter(
    (block): block is KiroThinking =>
      block.type === "thinking" &&
      !!(block.thinkingSignature || (block as KiroThinking).kiroReasoning?.redactedContent),
  );
  if (sealed.length !== 1) return undefined;
  const block = sealed[0];
  const provenance = block.kiroReasoning;
  if (provenance?.modelId !== modelId || provenance.requestDigest !== requestDigest) return undefined;
  return {
    ...(block.thinking ? { text: block.thinking } : {}),
    ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
    ...(provenance.redactedContent ? { redactedContent: provenance.redactedContent } : {}),
  };
}
