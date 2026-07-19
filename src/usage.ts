// ABOUTME: Fetches Kiro account usage via AmazonCodeWhispererService.GetUsageLimits.
// ABOUTME: Maps the backend response into pi's generic OAuthProviderUsage shape for /settings.

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { redactSensitiveText } from "./debug.js";
import { resolveApiRegion } from "./endpoints.js";
import { resolveKiroProfileArn } from "./management.js";
import type { KiroCredentials } from "./oauth.js";

const USAGE_ENDPOINT = "https://q.{region}.amazonaws.com/";
const MANAGE_USAGE_URL = "https://app.kiro.dev/account/usage";
const JSON_HEADERS = {
  "Content-Type": "application/x-amz-json-1.0",
  "User-Agent": "pi-provider-kiro",
} as const;

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

interface KiroSubscriptionInfo {
  type?: string;
  upgradeCapability?: string;
  overageCapability?: string;
  subscriptionManagementTarget?: string;
  subscriptionTitle?: string;
}

interface KiroOverageConfiguration {
  overageStatus?: string;
}

interface KiroUsageLimitList {
  type?: string;
  currentUsage?: number;
  totalUsageLimit?: number;
  percentUsed?: number;
}

interface KiroUserInfo {
  userId?: string;
  email?: string;
}

export interface KiroGetUsageLimitsResponse {
  limits?: KiroUsageLimitList[];
  nextDateReset?: EpochLike;
  daysUntilReset?: number;
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
  subscriptionInfo?: KiroSubscriptionInfo;
  overageConfiguration?: KiroOverageConfiguration;
  userInfo?: KiroUserInfo;
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

function getRegion(credentials: OAuthCredentials): string {
  return resolveApiRegion((credentials as KiroCredentials).region);
}

function getEndpoint(credentials: OAuthCredentials): string {
  return USAGE_ENDPOINT.replace("{region}", getRegion(credentials));
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

function bucketId(bucket: KiroUsageBreakdown, index: number): string {
  return bucket.resourceType || bucket.displayName || `usage-${index}`;
}

function mapBucket(bucket: KiroUsageBreakdown, index: number): KiroProviderUsageBucket {
  const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
  const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages;
  const freeTrialUsed = bucket.freeTrialInfo?.currentUsageWithPrecision ?? bucket.freeTrialInfo?.currentUsage;
  const freeTrialLimit = bucket.freeTrialInfo?.usageLimitWithPrecision ?? bucket.freeTrialInfo?.usageLimit;

  return {
    id: bucketId(bucket, index),
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

async function postOperation<TResponse>(
  credentials: OAuthCredentials,
  target: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(getEndpoint(credentials), {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${credentials.access}`,
      "X-Amz-Target": target,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = redactSensitiveText(await response.text());
    const statusText = redactSensitiveText(response.statusText);
    throw new Error(`${target} failed: ${response.status} ${statusText}${text ? ` ${text}` : ""}`);
  }

  return (await response.json()) as TResponse;
}

async function listProfileArn(credentials: OAuthCredentials): Promise<string | undefined> {
  try {
    return await resolveKiroProfileArn(
      { accessToken: credentials.access, region: getRegion(credentials) },
      (credentials as KiroCredentials).profileArn,
    );
  } catch {
    return undefined;
  }
}

function buildUsageBodies(profileArn: string | undefined): Array<Record<string, unknown>> {
  const maybeProfile = profileArn ? { profileArn } : {};
  return [
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT", isEmailRequired: false },
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT" },
    { ...maybeProfile, origin: "CLI" },
    { ...maybeProfile, origin: "CHATBOT", resourceType: "CREDIT", isEmailRequired: false },
    { ...maybeProfile, origin: "CHATBOT", resourceType: "CREDIT" },
    maybeProfile,
  ];
}

async function tryUsageBodies(
  credentials: OAuthCredentials,
  bodies: Array<Record<string, unknown>>,
  errors: string[],
): Promise<KiroGetUsageLimitsResponse | undefined> {
  const seen = new Set<string>();

  for (const body of bodies) {
    const key = JSON.stringify(body);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      return await postOperation<KiroGetUsageLimitsResponse>(
        credentials,
        "AmazonCodeWhispererService.GetUsageLimits",
        body,
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return undefined;
}

async function fetchRawUsage(credentials: OAuthCredentials): Promise<KiroGetUsageLimitsResponse> {
  const errors: string[] = [];

  const direct = await tryUsageBodies(credentials, buildUsageBodies(undefined), errors);
  if (direct) return direct;

  const profileArn = await listProfileArn(credentials);
  if (profileArn) {
    const profiled = await tryUsageBodies(credentials, buildUsageBodies(profileArn), errors);
    if (profiled) return profiled;
  }

  throw new Error(errors.join(" | ") || "GetUsageLimits failed");
}

export async function fetchKiroUsage(credentials: OAuthCredentials): Promise<KiroProviderUsage> {
  const raw = await fetchRawUsage(credentials);
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
