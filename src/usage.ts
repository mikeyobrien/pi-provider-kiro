// ABOUTME: Fetches Kiro account usage through the current Kiro management control plane.
// ABOUTME: Maps the response into pi's generic OAuth provider usage shape for /settings.

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { resolveApiRegion } from "./endpoints.js";
import {
  getUsageLimits,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resolveKiroProfileArn,
} from "./management.js";
import type { KiroCredentials } from "./oauth.js";

const MANAGE_USAGE_URL = "https://app.kiro.dev/account/usage";

type EpochLike = number | string;

interface KiroFreeTrialInfo {
  freeTrialStatus?: string;
  freeTrialExpiry?: EpochLike;
  currentUsage?: number;
  currentUsageWithPrecision?: number;
  usageLimit?: number;
  usageLimitWithPrecision?: number;
}

interface KiroUsageBreakdown {
  resourceType?: string;
  displayName?: string;
  displayNamePlural?: string;
  currentUsage: number;
  currentUsageWithPrecision?: number;
  currentOverages: number;
  currentOveragesWithPrecision?: number;
  usageLimit: number;
  usageLimitWithPrecision?: number;
  unit?: string;
  overageCharges: number;
  currency?: string;
  overageRate?: number;
  nextDateReset?: EpochLike;
  overageCap?: number;
  overageCapWithPrecision?: number;
  freeTrialInfo?: KiroFreeTrialInfo;
}

interface KiroUsageLimitList {
  type?: string;
  currentUsage?: number;
  totalUsageLimit?: number;
  percentUsed?: number;
}

export interface KiroGetUsageLimitsResponse {
  limits?: KiroUsageLimitList[];
  nextDateReset?: EpochLike;
  daysUntilReset?: number;
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
  subscriptionInfo?: { subscriptionTitle?: string };
  overageConfiguration?: { overageStatus?: string };
  userInfo?: { userId?: string; email?: string };
}

export interface KiroProviderUsageBonus {
  label: string;
  usedDisplay?: string;
  limitDisplay?: string;
  expiresAt?: string;
}

export interface KiroProviderUsageBucket {
  id: string;
  label: string;
  resourceType?: string;
  usedDisplay: string;
  limitDisplay?: string;
  unit?: string;
  overagesDisplay?: string;
  overageChargesDisplay?: string;
  resetAt?: string;
  bonus?: KiroProviderUsageBonus;
}

export interface KiroProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  daysUntilReset?: number;
  overageStatus?: string;
  manageUrl?: string;
  usageBuckets?: KiroProviderUsageBucket[];
  raw?: Record<string, unknown>;
}

function toIsoDate(value: EpochLike | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatCount(value: number | undefined): string | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(amount: number | undefined, currency: string | undefined): string | undefined {
  if (amount === undefined || Number.isNaN(amount) || amount <= 0) return undefined;
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function mapBucket(bucket: KiroUsageBreakdown, index: number): KiroProviderUsageBucket {
  const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
  const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages;
  const freeTrialUsed = bucket.freeTrialInfo?.currentUsageWithPrecision ?? bucket.freeTrialInfo?.currentUsage;
  const freeTrialLimit = bucket.freeTrialInfo?.usageLimitWithPrecision ?? bucket.freeTrialInfo?.usageLimit;

  return {
    id: bucket.resourceType || bucket.displayName || `usage-${index}`,
    label: bucket.displayName || bucket.displayNamePlural || bucket.resourceType || "Usage",
    resourceType: bucket.resourceType,
    usedDisplay: formatCount(used) || "0",
    limitDisplay: formatCount(limit),
    unit: bucket.unit,
    overagesDisplay: overages && overages > 0 ? formatCount(overages) : undefined,
    overageChargesDisplay: formatMoney(bucket.overageCharges, bucket.currency),
    resetAt: toIsoDate(bucket.nextDateReset),
    bonus:
      freeTrialUsed !== undefined || freeTrialLimit !== undefined || bucket.freeTrialInfo?.freeTrialExpiry !== undefined
        ? {
            label: "Bonus credits",
            usedDisplay: formatCount(freeTrialUsed),
            limitDisplay: formatCount(freeTrialLimit),
            expiresAt: toIsoDate(bucket.freeTrialInfo?.freeTrialExpiry),
          }
        : undefined,
  };
}

async function fetchRawUsage(auth: KiroManagementAuth, profileArn?: string): Promise<KiroGetUsageLimitsResponse> {
  const request = {
    profileArn,
    origin: "KIRO_CLI" as const,
    resourceType: "CREDIT" as const,
    isEmailRequired: false as const,
  };

  try {
    return await getUsageLimits<KiroGetUsageLimitsResponse>(auth, request);
  } catch (error) {
    if (profileArn || !(error instanceof KiroManagementHttpError) || error.status !== 403) throw error;
  }

  const resolvedProfileArn = await resolveKiroProfileArn(auth);
  return getUsageLimits<KiroGetUsageLimitsResponse>(auth, { ...request, profileArn: resolvedProfileArn });
}

export async function fetchKiroUsage(credentials: OAuthCredentials): Promise<KiroProviderUsage> {
  const auth = {
    accessToken: credentials.access,
    region: resolveApiRegion((credentials as KiroCredentials).region),
  };
  const raw = await fetchRawUsage(auth, (credentials as KiroCredentials).profileArn);
  const usageBuckets = raw.usageBreakdownList?.length
    ? raw.usageBreakdownList.map(mapBucket)
    : raw.usageBreakdown
      ? [mapBucket(raw.usageBreakdown, 0)]
      : [];

  return {
    summary: raw.subscriptionInfo?.subscriptionTitle,
    subscriptionTitle: raw.subscriptionInfo?.subscriptionTitle,
    resetAt: toIsoDate(raw.nextDateReset),
    daysUntilReset: raw.daysUntilReset,
    overageStatus: raw.overageConfiguration?.overageStatus,
    manageUrl: MANAGE_USAGE_URL,
    usageBuckets,
    raw: raw as Record<string, unknown>,
  };
}
