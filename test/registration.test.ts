import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials } from "../src/kiro-cli.js";
import { kiroModels } from "../src/models.js";

const mockPi = () => {
  const registerProvider = vi.fn();
  return { pi: { registerProvider, on: vi.fn() } as unknown as ExtensionAPI, registerProvider };
};

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

  it("registers dynamic models array", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(Array.isArray(config.models)).toBe(true);
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

  const sampleKiroModels = [
    { id: "deepseek-3-2", kiroModelId: "deepseek-3.2", name: "DeepSeek 3.2", provider: "kiro", api: "kiro-api" as const, baseUrl: "old", reasoning: true, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 164000, maxTokens: 8192 },
    { id: "claude-sonnet-4-6", kiroModelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", provider: "kiro", api: "kiro-api" as const, baseUrl: "old", reasoning: true, input: ["text", "image"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 65536 },
  ];

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
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: ssoRegion };
    const modified = config.oauth.modifyModels(sampleKiroModels, creds);
    expect(modified[0].baseUrl).toBe(`https://runtime.${expectedApiRegion}.kiro.dev/`);
  });

  it("modifyModels carries the OAuth profile ARN on Kiro models only", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social";
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

    const modified = config.oauth.modifyModels(sampleKiroModels, creds);

    expect(modified).toHaveLength(sampleKiroModels.length);
    expect(modified.every((model: { kiroProfileArn?: string }) => model.kiroProfileArn === profileArn)).toBe(true);
  });

  it("modifyModels does not apply a hardcoded regional allowlist", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels(sampleKiroModels, creds);
    const ids = modified.map((m: { id: string }) => m.id);
    expect(modified).toHaveLength(sampleKiroModels.length);
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
