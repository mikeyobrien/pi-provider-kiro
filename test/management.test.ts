import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKiroModelCatalog,
  listAvailableModels,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "../src/management.js";

const auth = { accessToken: "test-access-token", region: "us-east-1" };
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("Kiro management control plane", () => {
  it("resolves a profile through the management host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);
    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://management.us-east-1.kiro.dev/");
    expect(request.method).toBe("POST");
    expect(request.headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
    expect(JSON.parse(request.body)).toEqual({});
  });

  it("returns the current catalog shape, including Fable metadata", async () => {
    const fable = {
      modelId: "claude-fable-5",
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          output_config: {
            type: "object",
            properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"] } },
          },
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [fable], defaultModelId: "claude-fable-5" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchKiroModelCatalog(auth, profileArn);

    expect(catalog.models).toEqual([fable]);
    expect(catalog.defaultModelId).toBe("claude-fable-5");
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://management.us-east-1.kiro.dev/");
    expect(request.method).toBe("POST");
    expect(request.headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableModels");
    expect(JSON.parse(request.body)).toEqual({ origin: "KIRO_CLI", profileArn });
  });

  it("surfaces a management failure without trying a fallback host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAvailableModels(auth, profileArn)).rejects.toThrow(
      "Kiro management ListAvailableModels failed in us-east-1: 503 Service Unavailable",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/");
  });
});
