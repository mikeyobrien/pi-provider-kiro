import { rmSync } from "node:fs";
import type { ProviderModelsStore } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials } from "../src/kiro-cli.js";
import { getCachedModels, KIRO_MANAGEMENT_CACHE_PATH, type KiroModel, kiroModels } from "../src/models.js";

const credentialMocks = vi.hoisted(() => ({
  cli: vi.fn(),
  social: vi.fn(),
  ide: vi.fn(),
}));

vi.mock("../src/kiro-cli.js", async () => {
  const actual = await vi.importActual<typeof import("../src/kiro-cli.js")>("../src/kiro-cli.js");
  return {
    ...actual,
    getKiroCliCredentials: credentialMocks.cli,
    getKiroCliSocialToken: credentialMocks.social,
  };
});

vi.mock("../src/kiro-ide.js", async () => {
  const actual = await vi.importActual<typeof import("../src/kiro-ide.js")>("../src/kiro-ide.js");
  return { ...actual, getKiroIdeCredentials: credentialMocks.ide };
});

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

const cliOauthCredential = {
  access: "cli-access",
  refresh: "cli-refresh|idc",
  expires: Date.now() + 60_000,
  region: "us-east-1",
  authMethod: "idc" as const,
  profileArn: "arn:cli",
  clientId: "",
  clientSecret: "",
};

const sampleKiroModels: KiroModel[] = [
  {
    id: "deepseek-3-2",
    kiroModelId: "deepseek-3.2",
    name: "DeepSeek 3.2",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "old",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 164_000,
    maxTokens: 8192,
  },
  {
    id: "claude-sonnet-4-6",
    kiroModelId: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    provider: "kiro",
    api: "kiro-api",
    baseUrl: "old",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
];

describe("Feature 1: Extension Registration", () => {
  beforeEach(() => {
    delete process.env.KIRO_API_KEY;
    credentialMocks.cli.mockReset();
    credentialMocks.social.mockReset();
    credentialMocks.ide.mockReset();
    rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  });

  afterEach(() => {
    delete process.env.KIRO_API_KEY;
    vi.unstubAllGlobals();
    rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  });

  it("exports a default function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
  });

  // Consumers that classify a reason code without an error instance in hand
  // (a persisted log line, say) need the vocabulary through the package entry
  // point, not a deep import into src/retry.js.
  it("exposes Kiro's reason codes and classification predicates from the entry point", async () => {
    const mod = await import("../src/index.js");
    const retry = await import("../src/retry.js");

    expect(mod.KIRO_REASON_CODES).toBe(retry.KIRO_REASON_CODES);
    expect(mod.TOO_BIG_PATTERNS).toBe(retry.TOO_BIG_PATTERNS);
    expect(mod.NON_RETRYABLE_BODY_PATTERNS).toBe(retry.NON_RETRYABLE_BODY_PATTERNS);
    expect(mod.CAPACITY_PATTERN).toBe(retry.CAPACITY_PATTERN);
    expect(mod.isTooBigError).toBe(retry.isTooBigError);
    expect(mod.isNonRetryableBodyError).toBe(retry.isNonRetryableBodyError);
    expect(mod.isCapacityError).toBe(retry.isCapacityError);
  });

  it("keeps predicate behaviour unchanged through the entry point", async () => {
    const { KIRO_REASON_CODES, isCapacityError, isNonRetryableBodyError, isTooBigError } = await import(
      "../src/index.js"
    );

    expect(isTooBigError(413, "")).toBe(true);
    expect(isTooBigError(400, KIRO_REASON_CODES.CONTENT_LENGTH_EXCEEDS_THRESHOLD)).toBe(true);
    expect(isTooBigError(400, KIRO_REASON_CODES.REQUEST_BODY_INVALID)).toBe(false);
    expect(isNonRetryableBodyError(KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT)).toBe(true);
    expect(isNonRetryableBodyError(KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY)).toBe(false);
    expect(isCapacityError(KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY)).toBe(true);
    expect(isCapacityError(KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT)).toBe(false);
  });

  it("calls registerProvider with 'kiro'", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    await mod.default(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0][0]).toBe("kiro");
  });

  it("registers an empty catalog when neither credentials nor a cache are available", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    await mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(kiroModels).toEqual([]);
    expect(config.models).toEqual([]);
  });

  // Regression: the factory used to await catalog discovery before registering,
  // so a host that does not await an async extension factory started a chat with
  // `kiro-api` unregistered and crashed on the first message with
  // "No API provider registered for api: kiro-api".
  it("registers synchronously while catalog discovery is still in flight", async () => {
    credentialMocks.cli.mockReturnValue(cliOauthCredential);
    let failFetch: (error: Error) => void = () => {};
    const pendingFetch = new Promise<never>((_, reject) => {
      failFetch = reject;
    });
    const fetchMock = vi.fn(() => pendingFetch);
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    const returned = mod.default(pi);

    expect(mod.default.constructor.name).toBe("Function");
    expect(returned).toBeUndefined();
    expect(registerProvider).toHaveBeenCalledOnce();

    // Discovery was started, not awaited: the registration above already landed
    // while this request is still outstanding.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    failFetch(new Error("network down"));
    await mod.whenStartupCatalogSettled();
    warn.mockRestore();
  });

  // The registration must be usable on its own: a host resolves the api and the
  // stream function from it, and neither may depend on discovery having landed.
  it("registers a usable kiro-api handler even with an empty catalog", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.api).toBe("kiro-api");
    expect(typeof config.streamSimple).toBe("function");
    expect(typeof config.refreshModels).toBe("function");
    expect(config.models).toEqual([]);
  });

  // A `ksk_` key must reach the catalog through GetProfile: ListAvailableProfiles
  // answers 403 "Unsupported token type" for API keys, which would otherwise
  // leave the empty bootstrap catalog empty at startup.
  it("runs startup discovery after registering and gives KIRO_API_KEY precedence over local credentials", async () => {
    process.env.KIRO_API_KEY = "ksk_not-a-real-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profile: { arn: "arn:startup" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "claude-sonnet-4.6" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);
    expect(registerProvider).toHaveBeenCalledOnce();
    await mod.whenStartupCatalogSettled();

    expect(credentialMocks.social).not.toHaveBeenCalled();
    expect(credentialMocks.cli).not.toHaveBeenCalled();
    expect(credentialMocks.ide).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.GetProfile");
    expect(getCachedModels("us-east-1").map((model: KiroModel) => model.id)).toEqual(["claude-sonnet-4-6"]);
  });

  // The picker must not come up empty for a user who already has a catalog on
  // disk, which is the whole reason registration reads the cache synchronously.
  it("registers the cached catalog without waiting for discovery", async () => {
    credentialMocks.cli.mockReturnValue(cliOauthCredential);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "deepseek-3.2" }] }),
      }),
    );

    const mod = await import("../src/index.js");
    mod.default(mockPi().pi);
    await mod.whenStartupCatalogSettled();

    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    expect(registerProvider.mock.calls[0][1].models.map((model: KiroModel) => model.id)).toEqual(["deepseek-3-2"]);
    await mod.whenStartupCatalogSettled();
  });

  it("checks kiro-cli social credentials before the general kiro-cli credential scan", async () => {
    credentialMocks.cli.mockReturnValue(cliOauthCredential);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "deepseek-3.2" }] }),
      }),
    );

    const mod = await import("../src/index.js");
    const { pi } = mockPi();
    mod.default(pi);
    await mod.whenStartupCatalogSettled();

    expect(credentialMocks.social).toHaveBeenCalledOnce();
    expect(credentialMocks.cli).toHaveBeenCalledOnce();
    expect(credentialMocks.ide).not.toHaveBeenCalled();
  });

  it("uses Kiro IDE credentials only after both kiro-cli scans miss", async () => {
    credentialMocks.ide.mockReturnValue({
      access: "ide-access",
      refresh: "ide-refresh|||idc",
      expires: Date.now() + 60_000,
      region: "us-east-1",
      authMethod: "idc",
      profileArn: "arn:ide",
      clientId: "",
      clientSecret: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "glm-5" }] }),
      }),
    );

    const mod = await import("../src/index.js");
    const { pi } = mockPi();
    mod.default(pi);
    await mod.whenStartupCatalogSettled();

    expect(credentialMocks.social).toHaveBeenCalledOnce();
    expect(credentialMocks.cli).toHaveBeenCalledOnce();
    expect(credentialMocks.ide).toHaveBeenCalledOnce();
  });

  it("preserves the existing OAuth and kiro-cli credential contract", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    await mod.default(pi);

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
    await mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(typeof config.streamSimple).toBe("function");
  });

  it("uses kiro-api as the api type", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    await mod.default(pi);

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
      await mod.default(pi);
      return registerProvider.mock.calls[0][1].refreshModels;
    };

    it("serves an empty catalog without a credential and never hits the network", async () => {
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
    await mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: ssoRegion };
    const modified = config.oauth.modifyModels(sampleKiroModels, creds);
    expect(modified[0].baseUrl).toBe(`https://runtime.${expectedApiRegion}.kiro.dev/`);
  });

  it("modifyModels carries the OAuth profile ARN on Kiro models only", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    await mod.default(pi);

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
    await mod.default(pi);

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
    await mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
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
    const modified = config.oauth.modifyModels([...sampleKiroModels, ...codex], creds);

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

  // Extension **entry module** surface — not an npm package entry point.
  //
  // `pi.extensions: ["./dist/index.js"]` tells the pi host which module to load.
  // It is not a bare-specifier entry: `package.json` declares no `main`,
  // `exports`, or `types`, and the build emits no declarations, so
  // `import { validateKiroConversation } from "pi-provider-kiro"` does not
  // resolve from the published tarball (verified 2026-08-11 by packing and
  // importing in an isolated consumer: `ERR_MODULE_NOT_FOUND`). This pins that
  // the symbols leave this module; giving them a resolvable package entry is a
  // packaging change owned separately.
  it("re-exports the history validator surface from the entry module", async () => {
    const mod = await import("../src/index.js");
    for (const name of [
      "validateKiroConversation",
      "validateKiroToolStructure",
      "repairKiroConversation",
      "kiroConversationEntries",
      "isKiroToolStructureRule",
    ] as const) {
      expect(typeof mod[name], name).toBe("function");
    }
    expect(mod.KiroValidationRule.NON_EMPTY_USER_MESSAGE).toBe("NON_EMPTY_USER_MESSAGE");
    expect(mod.KIRO_TOOL_STRUCTURE_RULES).toHaveLength(3);
    expect(mod.KIRO_VALIDATION_MESSAGES.NON_EMPTY_USER_MESSAGE).toBe(
      "User messages must have either content or tool results",
    );
    expect(mod.SYNTHETIC_FAILED_TOOL_RESULT_TEXT).toBe("Tool use was interrupted and did not produce a result.");
    expect(mod.EMPTY_CONTENT_PLACEHOLDER).toBe("Please proceed with the task.");
  });

  // Same entry-module caveat as above: this pins that the symbol leaves this
  // module, so a consumer can `instanceof` the error the provider already
  // throws from every management-plane request that returns a non-OK status.
  // There is no per-module alternative — the build bundles everything into one
  // `dist/index.js`, so what this module re-exports is the whole reachable
  // surface and the fallback was string-matching `error.name` or the message.
  it("re-exports KiroManagementHttpError from the entry module", async () => {
    const mod = await import("../src/index.js");
    const { KiroManagementHttpError } = await import("../src/management.js");
    expect(mod.KiroManagementHttpError).toBe(KiroManagementHttpError);
  });
});
