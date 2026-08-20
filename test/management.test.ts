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
    expect(url).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(request.method).toBe("POST");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
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
    const [rawUrl, request] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://management.us-east-1.kiro.dev/List-Available-Models");
    expect(request.method).toBe("GET");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(Object.fromEntries(url.searchParams)).toEqual({ origin: "KIRO_CLI", profileArn });
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
    expect(fetchMock.mock.calls[0][0]).toContain("https://management.us-east-1.kiro.dev/List-Available-Models?");
  });

  it("honors KIRO_PROFILE_ARN override and skips only the profile round-trip (#110)", async () => {
    const envArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/pinned";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4-5" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const prev = process.env.KIRO_PROFILE_ARN;
    process.env.KIRO_PROFILE_ARN = envArn;
    try {
      await expect(resolveKiroProfileArn(auth)).resolves.toBe(envArn);
      const catalog = await fetchKiroModelCatalog(auth);
      expect(catalog.models.map((m) => m.modelId)).toContain("claude-sonnet-4-5");
      // Exactly one network call: ListAvailableModels. No ListAvailableProfiles probe.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("List-Available-Models");
    } finally {
      if (prev === undefined) delete process.env.KIRO_PROFILE_ARN;
      else process.env.KIRO_PROFILE_ARN = prev;
    }
  });

  it("env override wins over an explicitly provided token profileArn (#110)", async () => {
    const envArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/pinned";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4-5" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const prev = process.env.KIRO_PROFILE_ARN;
    process.env.KIRO_PROFILE_ARN = envArn;
    try {
      await expect(resolveKiroProfileArn(auth, profileArn)).resolves.toBe(envArn);
    } finally {
      if (prev === undefined) delete process.env.KIRO_PROFILE_ARN;
      else process.env.KIRO_PROFILE_ARN = prev;
    }
  });

  it("falls back to the token-carried ARN when no env override is set (#110)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4-5" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.KIRO_PROFILE_ARN;
    await expect(resolveKiroProfileArn(auth, profileArn)).resolves.toBe(profileArn);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
