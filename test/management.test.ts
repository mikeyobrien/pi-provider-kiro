import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKiroModelCatalog,
  isKiroManagementHttpError,
  KiroManagementHttpError,
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

describe("management-plane error typing", () => {
  const managementFailure = (status: number, statusText?: string) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, statusText });
    vi.stubGlobal("fetch", fetchMock);
    return resolveKiroProfileArn(auth);
  };

  // Scope note: this asserts the symbols leave `src/index.ts`, the module
  // esbuild bundles into `dist/index.js` — the file `package.json`'s
  // `pi.extensions` tells the pi host to load. It is NOT proof that
  // `import { KiroManagementHttpError } from "pi-provider-kiro"` resolves for an
  // npm consumer: `package.json` declares no `main`, `types`, or `exports`, so a
  // bare specifier cannot resolve and no `.d.ts` ships. Establishing that
  // contract needs packed-tarball coverage and belongs to the packaging change,
  // not here.
  it("is re-exported from the extension entry module", async () => {
    const entry = await import("../src/index.js");

    expect(entry.KiroManagementHttpError).toBe(KiroManagementHttpError);
    expect(typeof entry.isKiroManagementHttpError).toBe("function");

    const error = await managementFailure(403, "Forbidden").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(entry.KiroManagementHttpError);
    expect(entry.isKiroManagementHttpError(error)).toBe(true);
  });

  it("carries status and the plane discriminator on 401 and 403", async () => {
    for (const status of [401, 403]) {
      const error = await managementFailure(status, "Forbidden").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(KiroManagementHttpError);
      const typed = error as KiroManagementHttpError;
      expect(typed.status).toBe(status);
      expect(typed.plane).toBe("management");
      expect(typed.name).toBe("KiroManagementHttpError");
      expect(typed).toBeInstanceOf(Error);
      resetKiroProfileArnCache();
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a runtime 403 from a management 403 without reading .message", async () => {
    const managementError = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as Error;
    // Exactly what src/stream.ts throws on the runtime plane today.
    const runtimeError = new Error(
      'Kiro API error: 403 Forbidden {"message":"The bearer token included in the request is invalid.","reason":null}',
    );

    expect(isKiroManagementHttpError(managementError)).toBe(true);
    expect(isKiroManagementHttpError(runtimeError)).toBe(false);
    expect((managementError as KiroManagementHttpError).plane).toBe("management");
    expect((runtimeError as Partial<KiroManagementHttpError>).plane).toBeUndefined();
  });

  it("recognises a management error from a duplicate copy of this package", () => {
    // A bundled consumer plus a node_modules copy yield two distinct classes;
    // instanceof alone would reject a genuine management error from the other.
    class ForeignKiroManagementHttpError extends Error {
      readonly plane = "management" as const;
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
      }
    }
    const foreign = new ForeignKiroManagementHttpError(
      "Kiro management ListAvailableProfiles failed in us-east-1: 403",
      403,
    );

    expect(foreign).not.toBeInstanceOf(KiroManagementHttpError);
    expect(isKiroManagementHttpError(foreign)).toBe(true);
  });

  it("narrows to the data fields only, not to the class methods", async () => {
    const error: unknown = await managementFailure(403, "Forbidden").catch((e: unknown) => e);

    if (!isKiroManagementHttpError(error)) throw new Error("expected a management error");
    expect(error.status).toBe(403);
    expect(error.plane).toBe("management");
    expect(error.refreshAttempted).toBe(false);
    // A foreign copy's error passes the guard but carries no methods, so the
    // narrowed type must not offer one — this would throw at runtime.
    // @ts-expect-error markRefreshAttempted is absent from KiroManagementErrorInfo
    expect(error.markRefreshAttempted).toBeTypeOf("function");
  });

  it("rejects non-errors and unrelated errors", () => {
    expect(isKiroManagementHttpError(undefined)).toBe(false);
    expect(isKiroManagementHttpError({ plane: "management", status: 403 })).toBe(false);
    expect(isKiroManagementHttpError(new Error("boom"))).toBe(false);
  });

  it("keeps the existing message text byte-identical", async () => {
    const withStatusText = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as Error;
    expect(withStatusText.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 403 Forbidden");
    resetKiroProfileArnCache();
    vi.unstubAllGlobals();

    // Empty statusText contributes no trailing space — preserve that quirk.
    const withoutStatusText = (await managementFailure(401, "").catch((e: unknown) => e)) as Error;
    expect(withoutStatusText.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 401");
  });

  it("reports refreshAttempted only after a refresh was tried", async () => {
    const error = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as KiroManagementHttpError;

    expect(error.refreshAttempted).toBe(false);
    expect(error.markRefreshAttempted()).toBe(error);
    expect(error.refreshAttempted).toBe(true);
    // Flagging must not disturb the message contract or the discriminator.
    expect(error.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 403 Forbidden");
    expect(error.plane).toBe("management");
  });
});
