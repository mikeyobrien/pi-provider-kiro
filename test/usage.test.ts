import { afterEach, describe, expect, it, vi } from "vitest";
import { resetKiroProfileArnCache } from "../src/management.js";
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

const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";

function usageResponse() {
  return {
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
  };
}

function expectUsageRequest(rawUrl: string, expectedProfileArn?: string): void {
  const url = new URL(rawUrl);
  expect(`${url.origin}${url.pathname}`).toBe("https://management.us-east-1.kiro.dev/Get-Usage-Limits");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    ...(expectedProfileArn ? { profileArn: expectedProfileArn } : {}),
    origin: "KIRO_CLI",
    resourceType: "CREDIT",
    isEmailRequired: "false",
  });
}

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("fetchKiroUsage", () => {
  it("uses the management GetUsageLimits contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(usageResponse()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchKiroUsage({ ...creds, profileArn });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expectUsageRequest(url, profileArn);
    expect(request.method).toBe("GET");
    expect(request.headers.Authorization).toBe("Bearer access-token");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(request.body).toBeUndefined();
  });

  it("maps the management response into OAuth provider usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(usageResponse()),
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchKiroUsage({ ...creds, profileArn });

    expect(usage).toMatchObject({
      summary: "KIRO FREE",
      subscriptionTitle: "KIRO FREE",
      daysUntilReset: 6,
      overageStatus: "DISABLED",
      manageUrl: "https://app.kiro.dev/account/usage",
    });
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

  it("supports profile-less usage when the credential has no profile ARN", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(usageResponse()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchKiroUsage(creds);

    expect(fetchMock).toHaveBeenCalledOnce();
    expectUsageRequest(fetchMock.mock.calls[0][0]);
  });

  it("resolves a profile and retries once when profile-less usage is forbidden", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(usageResponse()),
      });
    vi.stubGlobal("fetch", fetchMock);

    await fetchKiroUsage(creds);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectUsageRequest(fetchMock.mock.calls[0][0]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://management.us-east-1.kiro.dev/");
    expect(fetchMock.mock.calls[1][1].headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
    expectUsageRequest(fetchMock.mock.calls[2][0], profileArn);
  });

  it("surfaces non-authorization failures without profile lookup or retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage(creds)).rejects.toThrow(
      "Kiro management GetUsageLimits failed in us-east-1: 503 Service Unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
