import { rmSync, writeFileSync } from "node:fs";
import type { ProviderModelsStore } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials } from "../src/kiro-cli.js";
import {
  KIRO_MANAGEMENT_CACHE_PATH,
  KIRO_MANAGEMENT_CACHE_SOURCE,
  KIRO_MANAGEMENT_CACHE_VERSION,
  kiroModels,
  mapKiroCatalogModels,
} from "../src/models.js";

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

  it("modifyModels reads the SSO region back out of a persisted credential", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    // No `region` field: this is the shape pi hands back after persistence.
    const modified = config.oauth.modifyModels(models, {
      access: "x",
      refresh: "rt|cid|csec|idc|eu-west-1",
      expires: 0,
    });

    expect(modified[0].baseUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
  });

  it("modifyModels addresses the region that served the catalog, not the derived one (#104)", async () => {
    writeFileSync(
      KIRO_MANAGEMENT_CACHE_PATH,
      JSON.stringify({
        version: KIRO_MANAGEMENT_CACHE_VERSION,
        source: KIRO_MANAGEMENT_CACHE_SOURCE,
        regions: {
          "eu-central-1": {
            region: "eu-central-1",
            catalogRegion: "us-east-1",
            fetchedAt: Date.now(),
            models: mapKiroCatalogModels([{ modelId: "claude-opus-4.8" }], "us-east-1"),
          },
        },
      }),
      "utf-8",
    );

    try {
      const mod = await import("../src/index.js");
      const { pi, registerProvider } = mockPi();
      mod.default(pi);

      const config = registerProvider.mock.calls[0][1];
      const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
      const modified = config.oauth.modifyModels(models, {
        access: "x",
        refresh: "rt|cid|csec|idc|eu-west-1",
        expires: 0,
      });

      const kiro = modified.filter((m: { provider: string }) => m.provider === "kiro");
      expect(kiro).toHaveLength(1);
      expect(kiro[0].baseUrl).toBe("https://runtime.us-east-1.kiro.dev/");
      expect(kiro[0].kiroRegion).toBe("us-east-1");
    } finally {
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    }
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
