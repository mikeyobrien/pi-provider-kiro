import { afterEach, describe, expect, it, vi } from "vitest";
import { resetKiroProfileArnCache } from "../src/management.js";
import { kiroOmpUsageProvider, toOmpUsageReport } from "../src/omp-usage.js";
import type { KiroProviderUsage } from "../src/usage.js";

const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("toOmpUsageReport", () => {
  it("maps a credit bucket into a monthly credits limit with fractions and reset", () => {
    const report = toOmpUsageReport(
      {
        subscriptionTitle: "KIRO POWER",
        resetAt: "2026-11-01T00:00:00.000Z",
        usageBuckets: [
          {
            id: "CREDIT",
            label: "Credit",
            resourceType: "CREDIT",
            usedDisplay: "2500",
            used: 2500,
            limit: 10000,
          },
        ],
        raw: { userInfo: { email: "user@example.com", userId: "user-1" } },
      },
      123,
    );

    expect(report).toEqual({
      provider: "kiro",
      fetchedAt: 123,
      limits: [
        {
          id: "kiro:CREDIT",
          label: "Credit",
          scope: { provider: "kiro", windowId: "monthly" },
          window: { id: "monthly", label: "Monthly", resetsAt: Date.parse("2026-11-01T00:00:00.000Z") },
          amount: {
            used: 2500,
            limit: 10000,
            remaining: 7500,
            usedFraction: 0.25,
            remainingFraction: 0.75,
            unit: "credits",
          },
          status: "ok",
        },
      ],
      metadata: { source: "kiro-management", planType: "KIRO POWER", email: "user@example.com", accountId: "user-1" },
    });
  });

  it("reports overage past the limit as exhausted without a negative remainder", () => {
    const [limit] = toOmpUsageReport({
      overageStatus: "ENABLED",
      usageBuckets: [
        {
          id: "CREDIT",
          label: "Credit",
          resourceType: "CREDIT",
          usedDisplay: "1100",
          used: 1100,
          limit: 1000,
          overagesDisplay: "100",
          overageChargesDisplay: "$4.00",
        },
      ],
    }).limits;

    expect(limit.status).toBe("exhausted");
    expect(limit.amount.usedFraction).toBe(1.1);
    expect(limit.amount.remaining).toBe(0);
    expect(limit.amount.remainingFraction).toBe(0);
    expect(limit.notes).toEqual(["Overages: 100", "Overage charges: $4.00"]);
  });

  it("flags 90% consumption as warning", () => {
    const [limit] = toOmpUsageReport({
      usageBuckets: [{ id: "CREDIT", label: "Credit", resourceType: "CREDIT", usedDisplay: "45", used: 45, limit: 50 }],
    }).limits;
    expect(limit.status).toBe("warning");
  });

  // A zero limit is a plan with no grant, not 100% used: no fraction is invented.
  it("leaves usage unknown when the bucket has no positive limit", () => {
    const [limit] = toOmpUsageReport({
      usageBuckets: [{ id: "CREDIT", label: "Credit", resourceType: "CREDIT", usedDisplay: "3", used: 3, limit: 0 }],
    }).limits;
    expect(limit.status).toBe("unknown");
    expect(limit.amount).toEqual({ used: 3, unit: "credits" });
  });

  it("adds free-trial bonus credits as a separate limit that expires on its own date", () => {
    const usage: KiroProviderUsage = {
      resetAt: "2026-04-01T00:00:00.000Z",
      usageBuckets: [
        {
          id: "CREDIT",
          label: "Credits",
          resourceType: "CREDIT",
          usedDisplay: "0",
          used: 0,
          limit: 50,
          bonus: { label: "Bonus credits", used: 125, limit: 500, expiresAt: "2026-03-26T00:00:00.000Z" },
        },
      ],
    };

    const [, bonus] = toOmpUsageReport(usage).limits;
    expect(bonus).toMatchObject({
      id: "kiro:CREDIT:bonus",
      label: "Bonus credits",
      scope: { provider: "kiro", windowId: "bonus" },
      window: { id: "bonus", resetsAt: Date.parse("2026-03-26T00:00:00.000Z"), resetLabel: "expires" },
      amount: { used: 125, limit: 500, usedFraction: 0.25, unit: "credits" },
      status: "ok",
    });
  });
});

describe("kiroOmpUsageProvider", () => {
  it("only supports kiro credentials that carry a token", () => {
    expect(kiroOmpUsageProvider.supports({ provider: "kiro", credential: { type: "oauth", accessToken: "t" } })).toBe(
      true,
    );
    expect(kiroOmpUsageProvider.supports({ provider: "kiro", credential: { type: "api_key", apiKey: "ksk_x" } })).toBe(
      true,
    );
    expect(kiroOmpUsageProvider.supports({ provider: "kiro", credential: { type: "oauth" } })).toBe(false);
    expect(kiroOmpUsageProvider.supports({ provider: "other", credential: { type: "oauth", accessToken: "t" } })).toBe(
      false,
    );
  });

  // OMP's usage credential carries no profile ARN, so the provider must resolve
  // it before GetUsageLimits, in the credential's mapped API region.
  it("resolves the profile in the credential's API region before fetching usage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
            usageBreakdownList: [
              { resourceType: "CREDIT", displayName: "Credit", currentUsage: 10, usageLimit: 1000, overageCharges: 0 },
            ],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const report = await kiroOmpUsageProvider.fetchUsage({
      provider: "kiro",
      credential: { type: "oauth", accessToken: "access-token", region: "us-east-2" },
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    const usageUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(`${usageUrl.origin}${usageUrl.pathname}`).toBe("https://management.us-east-1.kiro.dev/Get-Usage-Limits");
    expect(usageUrl.searchParams.get("profileArn")).toBe(profileArn);
    expect(report?.limits.map((limit) => [limit.id, limit.amount.used, limit.amount.limit])).toEqual([
      ["kiro:CREDIT", 10, 1000],
    ]);
    expect(report?.metadata?.planType).toBe("KIRO PRO");
  });

  // OMP's AuthStorage turns a thrown fetch into "serve last good report"; a
  // swallowed failure returning an empty report would overwrite it instead.
  it("propagates management failures instead of reporting empty usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }) })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error", text: () => Promise.resolve("") }),
    );

    await expect(
      kiroOmpUsageProvider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: "access-token" } }),
    ).rejects.toThrow();
  });
});
