import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKiroModelCatalog,
  listAvailableModels,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "../src/management.js";

const auth = { accessToken: "test-access-token", region: "us-east-1" };
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";
// Structurally valid but fake: `ksk_` only selects the GetProfile path.
const apiKeyAuth = { accessToken: "ksk_not-a-real-key", region: "us-east-1" };
const apiKeyProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/api-key";

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

  // Live-probed 2026-08-31 with a real `ksk_` key: ListAvailableProfiles answers
  // 403 "Unsupported token type" in both canonical regions, while GetProfile
  // returns the key's own profile. Probing first would leave the catalog empty.
  it("resolves an API key profile through GetProfile instead of probing ListAvailableProfiles", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profile: { arn: apiKeyProfileArn } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(apiKeyAuth)).resolves.toBe(apiKeyProfileArn);
    await expect(resolveKiroProfileArn(apiKeyAuth)).resolves.toBe(apiKeyProfileArn);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://management.us-east-1.kiro.dev/");
    expect(request.method).toBe("POST");
    expect(request.headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.GetProfile");
    expect(request.headers["Content-Type"]).toBe("application/x-amz-json-1.0");
    expect(request.headers.tokentype).toBe("API_KEY");
    expect(request.body).toBe("{}");
  });

  it("routes an API key catalog query to the GetProfile ARN in the key-issuing region", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profile: { arn: apiKeyProfileArn } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4-5" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchKiroModelCatalog({ accessToken: apiKeyAuth.accessToken, region: "eu-central-1" });

    expect(catalog.models.map((model) => model.modelId)).toEqual(["claude-sonnet-4-5"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const modelsUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(`${modelsUrl.origin}${modelsUrl.pathname}`).toBe(
      "https://management.us-east-1.kiro.dev/List-Available-Models",
    );
    expect(Object.fromEntries(modelsUrl.searchParams)).toEqual({
      origin: "KIRO_CLI",
      profileArn: apiKeyProfileArn,
    });
  });

  it("surfaces a rejected API key from GetProfile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(apiKeyAuth)).rejects.toThrow(
      "Kiro management GetProfile failed in us-east-1: 403 Forbidden",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the KIRO_PROFILE_ARN override ahead of GetProfile for API keys (#110)", async () => {
    const envArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/pinned";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4-5" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const previous = process.env.KIRO_PROFILE_ARN;
    process.env.KIRO_PROFILE_ARN = envArn;
    try {
      await expect(resolveKiroProfileArn(apiKeyAuth)).resolves.toBe(envArn);
      await fetchKiroModelCatalog(apiKeyAuth);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("List-Available-Models");
      expect(Object.fromEntries(new URL(fetchMock.mock.calls[0][0]).searchParams).profileArn).toBe(envArn);
    } finally {
      if (previous === undefined) delete process.env.KIRO_PROFILE_ARN;
      else process.env.KIRO_PROFILE_ARN = previous;
    }
  });

  it("still probes ListAvailableProfiles for non-API-key tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(request.headers.tokentype).toBeUndefined();
  });

  it("sends tokentype: EXTERNAL_IDP for external IdP tokens and omits it otherwise", async () => {
    const externalIdpToken = [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify({ aud: "api://kiro" })).toString("base64url"),
      "signature",
    ].join(".");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveKiroProfileArn({ accessToken: externalIdpToken, region: "us-east-1" });
    expect(fetchMock.mock.calls[0][1].headers.tokentype).toBe("EXTERNAL_IDP");

    resetKiroProfileArnCache();
    await resolveKiroProfileArn(auth);
    expect(fetchMock.mock.calls[1][1].headers.tokentype).toBeUndefined();
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

  it("falls back to the canonical profile region when the primary returns no profile (#104)", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu";
    const fetchMock = vi
      .fn()
      // Primary (eu-central-1): empty profile list
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [] }) })
      // Fallback (us-east-1): profile found
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: euArn }] }) });
    vi.stubGlobal("fetch", fetchMock);

    const euAuth = { accessToken: "test-access-token", region: "eu-central-1" };
    await expect(resolveKiroProfileArn(euAuth)).resolves.toBe(euArn);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");
    expect(fetchMock.mock.calls[1][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");

    // Second resolution is served from cache — no further probing.
    await expect(resolveKiroProfileArn(euAuth)).resolves.toBe(euArn);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes ListAvailableModels to the region where the profile was found (#104)", async () => {
    const modelsBody = { models: [{ modelId: "claude-sonnet-4-5" }], defaultModelId: "claude-sonnet-4-5" };
    const fetchMock = vi
      .fn()
      // Profile resolution: primary empty, fallback found
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
      })
      // ListAvailableModels must hit the profile region, not the SSO-derived one
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(modelsBody) });
    vi.stubGlobal("fetch", fetchMock);

    const euAuth = { accessToken: "test-access-token", region: "eu-central-1" };
    const catalog = await fetchKiroModelCatalog(euAuth);

    expect(catalog.models).toEqual(modelsBody.models);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");
    expect(fetchMock.mock.calls[1][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(fetchMock.mock.calls[2][0]).toContain("https://management.us-east-1.kiro.dev/List-Available-Models");
  });

  it("throws with region guidance when no canonical region yields a profile (#104)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ profiles: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const euAuth = { accessToken: "test-access-token", region: "eu-central-1" };
    await expect(resolveKiroProfileArn(euAuth)).rejects.toThrow(
      "Kiro management ListAvailableProfiles returned no profile in eu-central-1, us-east-1 (SSO-derived region: eu-central-1)",
    );

    // Both canonical regions were probed before failing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues probing after a 403 on the primary region and resolves in the fallback (#131)", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu";
    const fetchMock = vi
      .fn()
      // Primary (us-east-1): 403 Forbidden — token has no profile in this region
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      // Fallback (eu-central-1): profile found
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: euArn }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).resolves.toBe(euArn);

    // Both canonical regions were probed; the 403 did not abort the probe.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(fetchMock.mock.calls[1][0]).toBe("https://management.eu-central-1.kiro.dev/List-Available-Profiles");

    // Second resolution is served from cache — no further probing.
    await expect(resolveKiroProfileArn(auth)).resolves.toBe(euArn);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows the 403 when every canonical region rejects (#131)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    vi.stubGlobal("fetch", fetchMock);

    // A 403 on every region is a genuine auth-plane failure — keep the 403 so
    // callers that refresh credentials and retry on 403 (#107) still handle it.
    await expect(resolveKiroProfileArn(auth)).rejects.toThrow(
      "Kiro management ListAvailableProfiles failed in eu-central-1: 403 Forbidden",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not catch non-403 management errors as a region-mismatch signal (#131)", async () => {
    const fetchMock = vi
      .fn()
      // Primary (us-east-1): 500 — transient service error, not a region mismatch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).rejects.toThrow(
      "Kiro management ListAvailableProfiles failed in us-east-1: 500 Internal Server Error",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-probe a region whitelisted by the SSO-derived primary (#104)", async () => {
    // us-east-1 as primary: candidate set is [us-east-1, eu-central-1] — the
    // same region should only be queried once.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
