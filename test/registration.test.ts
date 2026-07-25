import { rmSync } from "node:fs";
import type { ProviderModelsStore } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials } from "../src/kiro-cli.js";
import { KIRO_MANAGEMENT_CACHE_PATH, kiroModels } from "../src/models.js";

const mockPi = () => {
  const registerProvider = vi.fn();
  return { pi: { registerProvider, on: vi.fn() } as unknown as ExtensionAPI, registerProvider };
};

/** Minimal host store fixture — refreshKiroModels intentionally uses the Kiro file cache instead. */
const mockProviderModelsStore = (): ProviderModelsStore => ({
  read: vi.fn(async () => undefined),
  write: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
});

describe("Feature 1: Extension Registration", () => {
  it("exports a default function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("calls registerProvider with 'kiro'", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    mod.default(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0][0]).toBe("kiro");
  });

  it("registers 15 models", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.models).toHaveLength(15);
  });

  it("preserves the existing OAuth and kiro-cli credential contract", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.oauth.name).toBe("Kiro (Builder ID / Google / GitHub)");
    expect(typeof config.oauth.login).toBe("function");
    expect(typeof config.oauth.refreshToken).toBe("function");
    expect(config.oauth.getCliCredentials).toBe(getKiroCliCredentials);
    expect(config.oauth.getApiKey({ access: "existing-access-token" })).toBe("existing-access-token");
    expect(typeof config.oauth.fetchUsage).toBe("function");
  });

  it("registers a streamSimple handler", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(typeof config.streamSimple).toBe("function");
  });

  it("uses kiro-api as the api type", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    expect(registerProvider.mock.calls[0][1].api).toBe("kiro-api");
  });

  describe("refreshModels", () => {
    beforeEach(() => {
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    });

    const refreshModels = async () => {
      const mod = await import("../src/index.js");
      const { pi, registerProvider } = mockPi();
      mod.default(pi);
      return registerProvider.mock.calls[0][1].refreshModels;
    };

    it("serves the bootstrap catalog without a credential and never hits the network", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(models).toEqual(kiroModels);
    });

    it("fetches the regional catalog when forced with an OAuth credential", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "claude-opus-4.8" }, { modelId: "openai-gpt-5.6" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
        credential: {
          type: "oauth",
          access: "refresh-access",
          refresh: "r",
          expires: 0,
          region: "eu-west-1",
          profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test",
        },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("https://management.eu-central-1.kiro.dev/");
      expect(models.map((model: { id: string }) => model.id)).toEqual(["claude-opus-4-8", "openai-gpt-5-6"]);
    });

    it("falls back to the cached catalog when discovery fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
        credential: { type: "oauth", access: "a", refresh: "r", expires: 0, region: "us-east-1", profileArn: "arn:p" },
      });

      expect(models).toEqual(kiroModels);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to refresh Kiro model catalog"));
      warn.mockRestore();
    });
  });

  it.each([
    { ssoRegion: "eu-west-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-west-2", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-north-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "us-east-1", expectedApiRegion: "us-east-1" },
    { ssoRegion: undefined, expectedApiRegion: "us-east-1" },
  ])("modifyModels maps SSO region $ssoRegion to API region $expectedApiRegion", async ({
    ssoRegion,
    expectedApiRegion,
  }) => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: ssoRegion };
    const modified = config.oauth.modifyModels(models, creds);
    expect(modified[0].baseUrl).toBe(`https://runtime.${expectedApiRegion}.kiro.dev/`);
  });

  it("modifyModels carries the OAuth profile ARN on Kiro models only", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social";
    const models = kiroModels.map((model) => ({ ...model, baseUrl: "old" }));
    const creds = {
      access: "social-access",
      refresh: "social-refresh|desktop",
      expires: Date.now() + 60_000,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop",
      profileArn,
    };

    const modified = config.oauth.modifyModels(models, creds);

    expect(modified).toHaveLength(models.length);
    expect(modified.every((model: { kiroProfileArn?: string }) => model.kiroProfileArn === profileArn)).toBe(true);
  });

  it("modifyModels does not apply a hardcoded regional allowlist", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels(models, creds);
    const ids = modified.map((m: { id: string }) => m.id);
    expect(modified).toHaveLength(models.length);
    expect(ids).toContain("deepseek-3-2");
    expect(ids).toContain("claude-sonnet-4-6");
  });

  it("modifyModels preserves non-kiro provider models", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const kiro = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const codex = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai",
        baseUrl: "https://example.com",
      },
    ];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels([...kiro, ...codex], creds);

    expect(modified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.4",
          provider: "openai-codex",
          baseUrl: "https://example.com",
        }),
      ]),
    );
  });
});
