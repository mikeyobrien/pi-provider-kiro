import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseKiroEvent } from "../src/event-parser.js";
import { type KiroThinking, reasoningDigest, reasoningForHistory } from "../src/reasoning.js";

const digest = reasoningDigest("instructions", []);
const block: KiroThinking = {
  type: "thinking",
  thinking: "synthetic",
  thinkingSignature: "opaque",
  kiroReasoning: { modelId: "test-model", requestDigest: digest },
};
const message = (content: KiroThinking[], provider = "kiro") =>
  ({ role: "assistant", provider, content }) as AssistantMessage;

describe("reasoning replay provenance", () => {
  it("preserves a single sealed block for its original request configuration", () => {
    expect(reasoningForHistory(message([block]), "test-model", digest)).toEqual({
      text: "synthetic",
      signature: "opaque",
    });
  });
  it("omits a chain that cannot fit the single wire slot", () => {
    expect(reasoningForHistory(message([block, block]), "test-model", digest)).toBeUndefined();
  });
  it("rejects foreign providers, model changes, tool changes, and untracked signatures", () => {
    expect(reasoningForHistory(message([block], "other"), "test-model", digest)).toBeUndefined();
    expect(reasoningForHistory(message([block]), "other-model", digest)).toBeUndefined();
    expect(reasoningForHistory(message([block]), "test-model", "different-digest")).toBeUndefined();
    expect(
      reasoningForHistory(
        message([{ type: "thinking", thinking: "", thinkingSignature: "opaque" }]),
        "test-model",
        digest,
      ),
    ).toBeUndefined();
  });
  it("preserves opaque redacted data without rendering it as text", () => {
    expect(parseKiroEvent("reasoningContentEvent", { redactedContent: "c3ludGhldGlj" })).toEqual({
      type: "thinkingRedacted",
      data: "c3ludGhldGlj",
    });
    const redacted: KiroThinking = {
      type: "thinking",
      thinking: "",
      kiroReasoning: { modelId: "test-model", requestDigest: digest, redactedContent: "c3ludGhldGlj" },
    };
    expect(reasoningForHistory(message([redacted]), "test-model", digest)).toEqual({ redactedContent: "c3ludGhldGlj" });
  });
});
