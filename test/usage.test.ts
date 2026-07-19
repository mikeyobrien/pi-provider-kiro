import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchKiroUsage } from "../src/usage.js";

const creds = {
  access: "access-token",
  refresh: "refresh-token|client|secret|idc",
  expires: Date.now() + 60_000,
  clientId: "client",
  clientSecret: "secret",
  region: "us-east-1",
  authMethod: "idc" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchKiroUsage", () => {
  it("maps a successful GetUsageLimits response into OAuthProviderUsage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          nextDateReset: 1775001600,
          daysUntilReset: 6,
          subscriptionInfo: {
            subscriptionTitle: "KIRO FREE",
            subscriptionManagementTarget: "MANAGE",
          },
          overageConfiguration: {
            overageStatus: "DISABLED",
          },
          usageBreakdown: {
            resourceType: "CREDIT",
            displayName: "Credits",
            currentUsage: 0,
            currentUsageWithPrecision: 0,
            currentOverages: 0,
            currentOveragesWithPrecision: 0,
            usageLimit: 50,
            usageLimitWithPrecision: 50,
            unit: "CREDITS",
            overageCharges: 0,
            currency: "USD",
            freeTrialInfo: {
              currentUsage: 0,
              currentUsageWithPrecision: 0,
              usageLimit: 500,
              usageLimitWithPrecision: 500,
              freeTrialExpiry: 1774483200,
            },
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchKiroUsage(creds);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(usage.subscriptionTitle).toBe("KIRO FREE");
    expect(usage.daysUntilReset).toBe(6);
    expect(usage.overageStatus).toBe("DISABLED");
    expect(usage.manageUrl).toBe("https://app.kiro.dev/account/usage");
    expect(usage.usageBuckets?.[0]).toMatchObject({
      label: "Credits",
      usedDisplay: "0",
      limitDisplay: "50",
      unit: "CREDITS",
      bonus: {
        label: "Bonus credits",
        usedDisplay: "0",
        limitDisplay: "500",
      },
    });
  });

  it("uses a credential-provided profileArn without a management lookup", async () => {
    const credentialProfileArn = "arn:aws:codewhisperer:us-east-1:123:profile/from-credentials";
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 6) {
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          text: () => Promise.resolve("x"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
            usageBreakdown: {
              resourceType: "CREDIT",
              displayName: "Credits",
              currentUsage: 0,
              currentOverages: 0,
              usageLimit: 1000,
              overageCharges: 0,
            },
          }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchKiroUsage({ ...creds, profileArn: credentialProfileArn });

    expect(usage.subscriptionTitle).toBe("KIRO PRO");
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.every(([url]) => url === "https://q.us-east-1.amazonaws.com/")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({ profileArn: credentialProfileArn });
  });

  it("falls back to a profileArn after initial GetUsageLimits attempts fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("x") })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/test" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            subscriptionInfo: { subscriptionTitle: "KIRO PRO+" },
            overageConfiguration: { overageStatus: "DISABLED" },
            usageBreakdown: {
              resourceType: "CREDIT",
              displayName: "Credits",
              currentUsage: 0,
              currentOverages: 0,
              usageLimit: 2000,
              overageCharges: 0,
              currency: "USD",
            },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchKiroUsage(creds);

    expect(usage.subscriptionTitle).toBe("KIRO PRO+");
    expect(fetchMock.mock.calls[6][0]).toBe("https://management.us-east-1.kiro.dev/");
    expect(fetchMock.mock.calls[6][1].headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
    const finalCall = fetchMock.mock.calls.at(-1);
    expect(finalCall?.[1]?.body).toContain("profileArn");
  });
});
