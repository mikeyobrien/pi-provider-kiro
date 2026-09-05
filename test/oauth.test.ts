import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliSocialToken } from "../src/kiro-cli.js";
import { getKiroIdeCredentials } from "../src/kiro-ide.js";
import type { KiroCredentials } from "../src/oauth.js";
import { refreshKiroToken } from "../src/oauth.js";

// Mock kiro-cli to prevent fallback to real credentials
vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  getKiroCliSocialTokenAllowExpired: vi.fn(() => undefined),
  saveKiroCliCredentials: vi.fn(),
}));

// The IDE credential source is a real file read; stub it so a developer's live
// Kiro IDE session cannot satisfy the refresh under test.
vi.mock("../src/kiro-ide.js", () => ({
  getKiroIdeCredentials: vi.fn(() => undefined),
  getKiroIdeCredentialsAllowExpired: vi.fn(() => undefined),
}));

beforeEach(() => {
  vi.mocked(getKiroCliSocialToken).mockReset();
  vi.mocked(getKiroCliSocialToken).mockReturnValue(undefined);
  vi.mocked(getKiroIdeCredentials).mockReset();
  vi.mocked(getKiroIdeCredentials).mockReturnValue(undefined);
});

describe("Feature 3: OAuth — Token Refresh", () => {
  // Interactive login / device code flow tests live in test/login.test.ts (Feature 10)

  describe("refreshKiroToken", () => {
    it("refreshes token using encoded refresh field", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
      });
      expect(creds.access).toBe("new_at");
      expect(creds.refresh).toContain("new_rt|cid|csec|idc");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.clientId).toBe("cid");
      expect(body.refreshToken).toBe("old_rt");
      vi.unstubAllGlobals();
    });

    // A credential that has been through pi's store comes back with only the
    // documented OAuth fields — `region` is gone, and the refresh string is the
    // only place it can have survived.
    it("refreshes a persisted IDC credential against its own SSO region", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc|eu-west-1",
        access: "old_at",
        expires: 0,
      });

      expect(mockFetch.mock.calls[0][0]).toBe("https://oidc.eu-west-1.amazonaws.com/token");
      expect((creds as KiroCredentials).region).toBe("eu-west-1");
      expect(creds.refresh).toBe("new_rt|cid|csec|idc|eu-west-1");
      vi.unstubAllGlobals();
    });

    it("refreshes a persisted desktop credential against its own region", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "desk_at", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "desk_rt|desktop|eu-west-1",
        access: "old",
        expires: 0,
      });

      expect(mockFetch.mock.calls[0][0]).toBe("https://prod.eu-west-1.auth.desktop.kiro.dev/refreshToken");
      expect((creds as KiroCredentials).authMethod).toBe("desktop");
      expect(creds.refresh).toBe("desk_rt|desktop|eu-west-1");
      vi.unstubAllGlobals();
    });

    it("still refreshes a credential written before regions were encoded", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await refreshKiroToken({ refresh: "old_rt|cid|csec|idc", access: "old_at", expires: 0 });

      expect(mockFetch.mock.calls[0][0]).toBe("https://oidc.us-east-1.amazonaws.com/token");
      vi.unstubAllGlobals();
    });

    it("throws on failed refresh", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      await expect(refreshKiroToken({ refresh: "rt|c|s|idc", access: "x", expires: 0 })).rejects.toThrow();
      vi.unstubAllGlobals();
    });

    it("refreshes desktop tokens via Kiro auth service", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "desk_at", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "desk_rt|desktop",
        access: "old",
        expires: 0,
        region: "us-east-1",
      } as KiroCredentials);
      expect(creds.access).toBe("desk_at");
      expect(creds.refresh).toContain("desk_rt|desktop");
      expect((creds as KiroCredentials).authMethod).toBe("desktop");

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("auth.desktop.kiro.dev/refreshToken");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.refreshToken).toBe("desk_rt");
      expect(body.clientId).toBeUndefined();
      vi.unstubAllGlobals();
    });

    it("refreshes external IdP tokens against the customer token endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: "idp_at", refresh_token: "idp_rt2", expires_in: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tokenEndpoint = "https://example.okta.com/oauth2/default/v1/token";
      const creds = await refreshKiroToken({
        refresh: `idp_rt|0oaEXAMPLE|${tokenEndpoint}|external-idp`,
        access: "old",
        expires: 0,
        region: "us-east-1",
      } as KiroCredentials);

      expect(creds.access).toBe("idp_at");
      expect(creds.refresh).toBe(`idp_rt2|0oaEXAMPLE|${tokenEndpoint}|external-idp|us-east-1`);
      expect((creds as KiroCredentials).authMethod).toBe("external-idp");
      expect((creds as KiroCredentials).clientSecret).toBe("");

      const [url, request] = mockFetch.mock.calls[0];
      expect(url).toBe(tokenEndpoint);
      expect(request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const body = new URLSearchParams(request.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("0oaEXAMPLE");
      expect(body.get("refresh_token")).toBe("idp_rt");
      expect(body.get("client_secret")).toBeNull();
      vi.unstubAllGlobals();
    });

    it("reuses the previous refresh token when the IdP does not rotate it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "idp_at", expires_in: 3600 }),
        }),
      );
      const creds = await refreshKiroToken({
        refresh: "idp_rt|cid|https://idp.example/token|external-idp",
        access: "old",
        expires: 0,
      } as KiroCredentials);
      expect(creds.refresh).toBe("idp_rt|cid|https://idp.example/token|external-idp|us-east-1");
      vi.unstubAllGlobals();
    });

    it("throws on external IdP token refresh failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }));
      await expect(
        refreshKiroToken({
          refresh: "idp_rt|cid|https://idp.example/token|external-idp",
          access: "old",
          expires: 0,
        } as KiroCredentials),
      ).rejects.toThrow("External IdP token refresh failed: 400");
      vi.unstubAllGlobals();
    });

    it("throws when the external IdP refresh string carries no token endpoint", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      await expect(
        refreshKiroToken({
          refresh: "idp_rt|cid||external-idp",
          access: "old",
          expires: 0,
        } as KiroCredentials),
      ).rejects.toThrow("External IdP token refresh: missing token endpoint");
      expect(mockFetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh failed: 401");
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh with missing accessToken", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ expiresIn: 3600 }) }),
      );
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh: missing accessToken");
      vi.unstubAllGlobals();
    });

    it("uses region from credentials for IDC refresh", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
        region: "us-west-2",
      } as KiroCredentials);

      expect(mockFetch.mock.calls[0][0]).toContain("oidc.us-west-2.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("uses expired kiro-cli creds as fallback when direct refresh fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({ refresh: "stale_rt|cid|csec|idc", access: "stale_at", expires: 0 });
      expect(creds.access).toBe("new_at");
      vi.unstubAllGlobals();
    });

    it("falls through to graceful degradation when expired creds refresh also fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 401 });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: Date.now() - 60_000,
      });
      expect(creds.access).toBe("old_at");
      expect(creds.expires).toBeGreaterThan(Date.now());
      vi.unstubAllGlobals();
    });
  });

  describe("loginKiroWithApiKey", () => {
    it("validates Kiro API key format", async () => {
      const { loginKiroWithApiKey } = await import("../src/oauth.js");
      await expect(loginKiroWithApiKey({} as any, "invalid_key")).rejects.toThrow("Invalid API key format");
    });

    it("fetches profile with GetProfile and returns apikey credentials", async () => {
      const { loginKiroWithApiKey } = await import("../src/oauth.js");
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profile: { arn: "arn:aws:codewhisperer:us-east-1:123:profile/api-key" } }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await loginKiroWithApiKey({ onProgress: vi.fn() } as any, "ksk_test_key_12345");
      expect(creds.access).toBe("ksk_test_key_12345");
      expect(creds.refresh).toBe("ksk_test_key_12345|apikey");
      expect((creds as KiroCredentials).authMethod).toBe("apikey");
      expect((creds as KiroCredentials).profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/api-key");
      expect(mockFetch.mock.calls[0][1].headers.tokentype).toBe("API_KEY");

      vi.unstubAllGlobals();
    });
  });

  it("does not replace desktop credentials with an unrelated IDE IDC account", async () => {
    vi.mocked(getKiroIdeCredentials).mockReturnValueOnce({
      refresh: "ide_rt|ide_cid|ide_csec|idc",
      access: "ide_at",
      expires: Date.now() + 3_600_000,
      clientId: "ide_cid",
      clientSecret: "ide_csec",
      region: "eu-central-1",
      authMethod: "idc",
    });
    vi.mocked(getKiroCliSocialToken).mockReturnValueOnce({
      refresh: "social_rt|desktop",
      access: "social_at",
      expires: Date.now() + 3_600_000,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/social",
    });

    const creds = (await refreshKiroToken({
      refresh: "stored_rt|desktop",
      access: "stored_at",
      expires: 0,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop",
    } as KiroCredentials)) as KiroCredentials;

    expect(creds.access).toBe("social_at");
    expect(creds.authMethod).toBe("desktop");
    expect(creds.region).toBe("us-east-1");
  });
});
