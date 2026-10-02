import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

// Oh My Pi's pi-ai shim does not export pi-ai's assistant-message diagnostic
// helpers. Model that host for the whole file so the stream's error path runs
// against the reduced surface. (Vitest throws on reading an export a mock
// omits, so the helpers are present but undefined, as they read on OMP.)
vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
  appendAssistantMessageDiagnostic: undefined,
  createAssistantMessageDiagnostic: undefined,
}));

const { resetProfileArnCache, streamKiro } = await import("../src/stream.js");

const model = {
  id: "claude-sonnet-4-5",
  name: "Sonnet",
  api: "kiro-api",
  provider: "kiro",
  baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 65536,
} as Model<"kiro-api">;

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

describe("host without pi-ai diagnostic helpers (Oh My Pi)", () => {
  it("emits one terminal error with the original message and errorStatus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve('{"message":"Invalid parameter: modelId"}'),
      }),
    );
    resetProfileArnCache(true);
    try {
      const events = [];
      for await (const event of streamKiro(model, context, { apiKey: "tok" })) events.push(event);

      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      const message = (errors[0].type === "error" ? errors[0].error : undefined) as
        | (AssistantMessage & { errorStatus?: number })
        | undefined;
      expect(message?.stopReason).toBe("error");
      expect(message?.errorStatus).toBe(400);
      expect(message?.errorMessage).toContain("Invalid parameter: modelId");
      expect(message?.diagnostics).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // An API key resolves its profile through the management plane before the
  // runtime call; a failure there must carry its status too.
  it("sets errorStatus when the management-plane profile lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve(""),
        json: () => Promise.reject(new Error("no body")),
      }),
    );
    resetProfileArnCache(false);
    try {
      const events = [];
      for await (const event of streamKiro(model, context, { apiKey: "ksk_invalid" })) events.push(event);

      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      const message = (errors[0].type === "error" ? errors[0].error : undefined) as
        | (AssistantMessage & { errorStatus?: number })
        | undefined;
      expect(message?.errorMessage).toContain("Kiro management");
      expect(message?.errorStatus).toBe(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
