import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { loginKiroBuilderID, refreshKiroToken } from "../src/oauth.js";

// Mock kiro-cli to prevent fallback to real credentials
vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
}));

function makeCallbacks(overrides?: Partial<OAuthLoginCallbacks>): OAuthLoginCallbacks & {
  onAuth: ReturnType<typeof vi.fn>;
  signal: AbortSignal;
} {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn().mockResolvedValue("code"),
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  } as OAuthLoginCallbacks & { onAuth: ReturnType<typeof vi.fn>; signal: AbortSignal };
}

describe("Feature 3: OAuth — AWS Builder ID", () => {
  describe("loginKiroBuilderID", () => {
    it("calls onAuth with verification URL", async () => {
      const callbacks = makeCallbacks();
      const mockFetch = vi
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
      vi.stubGlobal("fetch", mockFetch);

      const creds = await loginKiroBuilderID(callbacks);
      expect(callbacks.onAuth).toHaveBeenCalled();
      const authCall = callbacks.onAuth.mock.calls[0][0];
      expect(authCall.url).toContain("device.sso");
      expect(creds.access).toBe("at");
      expect(creds.refresh).toContain("rt|cid|csec|idc");
      expect((creds as any).authMethod).toBe("idc");

      vi.unstubAllGlobals();
    });

    it("throws on cancelled signal", async () => {
      const ac = new AbortController();
      ac.abort();
      const callbacks = makeCallbacks({ signal: ac.signal });
      const mockFetch = vi
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
              expiresIn: 10,
            }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await expect(loginKiroBuilderID(callbacks)).rejects.toThrow("cancelled");
      vi.unstubAllGlobals();
    });

    it("increases interval on slow_down response", async () => {
      const callbacks = makeCallbacks();
      const mockFetch = vi
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
        });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await loginKiroBuilderID(callbacks);
      expect(creds.access).toBe("at");
      vi.unstubAllGlobals();
    });
  });

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
      } as any);
      expect(creds.access).toBe("desk_at");
      expect(creds.refresh).toContain("desk_rt|desktop");
      expect((creds as any).authMethod).toBe("desktop");

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("auth.desktop.kiro.dev/refreshToken");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.refreshToken).toBe("desk_rt");
      expect(body.clientId).toBeUndefined();
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh failure", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as any),
      ).rejects.toThrow("Desktop token refresh failed: 401");
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh with missing accessToken", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as any),
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
      } as any);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("oidc.us-west-2.amazonaws.com");
      vi.unstubAllGlobals();
    });
  });
});
