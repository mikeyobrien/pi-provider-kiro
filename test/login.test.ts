import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { interactiveLogin } from "../src/login.js";
import type { KiroCredentials } from "../src/oauth.js";
import { BUILDER_ID_START_URL } from "../src/oauth.js";

vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  getKiroCliSocialTokenAllowExpired: vi.fn(() => undefined),
  saveKiroCliCredentials: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

// Mock login-ui — no ctx available in tests, return null to exercise fallback
vi.mock("../src/login-ui.js", () => ({
  showLoginUI: vi.fn(() => Promise.resolve(null)),
  setExtensionContext: vi.fn(),
}));

function makeCallbacks(...responses: string[]): OAuthLoginCallbacks & { onAuth: ReturnType<typeof vi.fn> } {
  const onPrompt = vi.fn();
  for (const r of responses) onPrompt.mockResolvedValueOnce(r);
  onPrompt.mockResolvedValue("");
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt,
    onProgress: vi.fn(),
    signal: new AbortController().signal,
  } as OAuthLoginCallbacks & { onAuth: ReturnType<typeof vi.fn> };
}

function mockBuilderIdFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "cid", clientSecret: "csec" }) })
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          verificationUri: "https://device.sso.us-east-1.amazonaws.com",
          verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com?code=ABCD",
          userCode: "ABCD-1234",
          deviceCode: "dc",
          interval: 1,
          expiresIn: 10,
        }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
    });
}

// us-east-1 device_authorization fails (wrong region), eu-west-1 succeeds
function mockIdcAutoDetectFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c1", clientSecret: "s1" }) }) // us-east-1 register
    .mockResolvedValueOnce({ ok: false, status: 400 }) // us-east-1 device_auth → wrong region
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c2", clientSecret: "s2" }) }) // eu-west-1 register
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          verificationUri: "u",
          verificationUriComplete: "u?code=X",
          userCode: "X",
          deviceCode: "dc",
          interval: 1,
          expiresIn: 10,
        }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
    });
}

describe("Feature 10: Interactive Login", () => {
  describe("method selection (prompt 1)", () => {
    it("blank/1 → Builder ID", async () => {
      const mockFetch = mockBuilderIdFetch();
      vi.stubGlobal("fetch", mockFetch);
      const creds = await interactiveLogin(makeCallbacks(""));
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).startUrl).toBe(BUILDER_ID_START_URL);
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("TUI: google → kiro-cli Google", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "google" });
      const { getKiroCliSocialToken, getKiroCliCredentials } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliSocialToken).mockReturnValueOnce(undefined);
      vi.mocked(getKiroCliCredentials).mockReturnValueOnce({
        refresh: "rt|desktop",
        access: "at",
        expires: Date.now() + 3600000,
        clientId: "",
        clientSecret: "",
        region: "us-east-1",
        authMethod: "desktop",
      });
      expect(((await interactiveLogin(makeCallbacks(""))) as KiroCredentials).authMethod).toBe("desktop");
    });

    it("TUI: github → kiro-cli GitHub", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "github" });
      const { getKiroCliSocialToken, getKiroCliCredentials } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliSocialToken).mockReturnValueOnce(undefined);
      vi.mocked(getKiroCliCredentials).mockReturnValueOnce({
        refresh: "rt|desktop",
        access: "at",
        expires: Date.now() + 3600000,
        clientId: "",
        clientSecret: "",
        region: "us-east-1",
        authMethod: "desktop",
      });
      expect(((await interactiveLogin(makeCallbacks(""))) as KiroCredentials).authMethod).toBe("desktop");
    });

    it("TUI: builder-id → Builder ID flow", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "builder-id" });
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("TUI: idc → IdC flow with auto-detect", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "idc", startUrl: "https://mycompany.awsapps.com/start" });
      vi.stubGlobal("fetch", mockIdcAutoDetectFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("eu-west-1");
      vi.unstubAllGlobals();
    });

    it("TUI: null (cancelled) → falls back to onPrompt", async () => {
      // showLoginUI returns null (default mock), so fallback fires
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("fallback: invalid non-URL input → throws", async () => {
      vi.stubGlobal("fetch", vi.fn());
      await expect(interactiveLogin(makeCallbacks("notaurl"))).rejects.toThrow("Invalid input");
      vi.unstubAllGlobals();
    });
  });

  describe("fallback — onPrompt path (no TUI ctx)", () => {
    it("URL → auto-detects region", async () => {
      vi.stubGlobal("fetch", mockIdcAutoDetectFetch());
      const creds = await interactiveLogin(makeCallbacks("https://mycompany.awsapps.com/start"));
      expect((creds as KiroCredentials).region).toBe("eu-west-1");
      vi.unstubAllGlobals();
    });

    it("blank → Builder ID", async () => {
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("all regions fail → throws helpful error", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          call++;
          if (call % 2 === 1)
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) });
          return Promise.resolve({ ok: false, status: 400 });
        }),
      );
      await expect(interactiveLogin(makeCallbacks("https://unknown.awsapps.com/start"))).rejects.toThrow(
        "Could not find",
      );
      vi.unstubAllGlobals();
    });
  });

  describe("device code polling", () => {
    it("throws on cancelled signal", async () => {
      const ac = new AbortController();
      ac.abort();
      const callbacks = { ...makeCallbacks(""), signal: ac.signal };
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      await expect(interactiveLogin(callbacks)).rejects.toThrow("cancelled");
      vi.unstubAllGlobals();
    });

    it("increases polling interval on slow_down", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) })
          .mockResolvedValueOnce({
            ok: true,
            json: () =>
              Promise.resolve({
                verificationUri: "u",
                verificationUriComplete: "u",
                userCode: "X",
                deviceCode: "d",
                interval: 1,
                expiresIn: 30,
              }),
          })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ error: "slow_down" }) })
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
          }),
      );
      expect((await interactiveLogin(makeCallbacks(""))).access).toBe("at");
      vi.unstubAllGlobals();
    });
  });
});
