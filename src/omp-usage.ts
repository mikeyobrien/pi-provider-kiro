// ABOUTME: Oh My Pi usage provider: maps Kiro's GetUsageLimits response into OMP's UsageReport.
// ABOUTME: Feeds `omp usage` and `/usage`; types mirror @oh-my-pi/pi-ai structurally (no host import).

import { fetchKiroUsage, type KiroProviderUsage, type KiroProviderUsageBucket } from "./usage.js";

const PROVIDER = "kiro";
/** Fraction at which OMP's usage displays switch a limit to "warning". */
const WARNING_FRACTION = 0.9;

type OmpUsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Structural subset of OMP's `UsageCredential`. */
export interface OmpUsageCredential {
  type: "api_key" | "oauth";
  apiKey?: string;
  accessToken?: string;
  region?: string;
}

/** Structural subset of OMP's `UsageFetchParams`. */
export interface OmpUsageFetchParams {
  provider: string;
  credential: OmpUsageCredential;
}

/** Structural subset of OMP's `UsageLimit`. */
export interface OmpUsageLimit {
  id: string;
  label: string;
  scope: { provider: string; windowId?: string };
  window?: { id: string; label: string; resetsAt?: number; resetLabel?: string };
  amount: {
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit: "credits" | "unknown";
  };
  status?: OmpUsageStatus;
  notes?: string[];
}

/** Structural subset of OMP's `UsageReport`. */
export interface OmpUsageReport {
  provider: string;
  fetchedAt: number;
  limits: OmpUsageLimit[];
  notes?: string[];
  metadata?: Record<string, unknown>;
}

/** Structural subset of OMP's `UsageProvider`. */
export interface OmpUsageProvider {
  id: string;
  cacheVersion: number;
  supports(params: OmpUsageFetchParams): boolean;
  fetchUsage(params: OmpUsageFetchParams): Promise<OmpUsageReport | null>;
}

function buildLimit(args: {
  id: string;
  label: string;
  used: number | undefined;
  limit: number | undefined;
  window: { id: string; label: string; resetAt: string | undefined; resetLabel?: string };
  unit: OmpUsageLimit["amount"]["unit"];
  notes?: string[];
}): OmpUsageLimit {
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined;
  const usedFraction = limit !== undefined && args.used !== undefined ? args.used / limit : undefined;
  const { resetAt, ...windowLabels } = args.window;
  const resetsAt = resetAt ? Date.parse(resetAt) : Number.NaN;
  const window = { ...windowLabels, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) };
  let status: OmpUsageStatus = "unknown";
  if (usedFraction !== undefined) {
    status = usedFraction >= 1 ? "exhausted" : usedFraction >= WARNING_FRACTION ? "warning" : "ok";
  }
  return {
    id: args.id,
    label: args.label,
    scope: { provider: PROVIDER, windowId: window.id },
    window,
    amount: {
      ...(args.used !== undefined ? { used: args.used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(limit !== undefined && args.used !== undefined ? { remaining: Math.max(0, limit - args.used) } : {}),
      ...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
      unit: args.unit,
    },
    status,
    ...(args.notes && args.notes.length > 0 ? { notes: args.notes } : {}),
  };
}

function bucketLimits(bucket: KiroProviderUsageBucket, usage: KiroProviderUsage): OmpUsageLimit[] {
  const unit = bucket.resourceType === "CREDIT" ? "credits" : "unknown";
  const notes = [
    ...(bucket.overagesDisplay ? [`Overages: ${bucket.overagesDisplay}`] : []),
    ...(bucket.overageChargesDisplay ? [`Overage charges: ${bucket.overageChargesDisplay}`] : []),
  ];
  const limits = [
    buildLimit({
      id: `kiro:${bucket.id}`,
      label: bucket.label,
      used: bucket.used,
      limit: bucket.limit,
      window: { id: "monthly", label: "Monthly", resetAt: bucket.resetAt ?? usage.resetAt },
      unit,
      notes,
    }),
  ];
  // Free-trial bonus credits expire on their own date rather than resetting monthly.
  if (bucket.bonus) {
    limits.push(
      buildLimit({
        id: `kiro:${bucket.id}:bonus`,
        label: bucket.bonus.label,
        used: bucket.bonus.used,
        limit: bucket.bonus.limit,
        window: { id: "bonus", label: "Bonus", resetAt: bucket.bonus.expiresAt, resetLabel: "expires" },
        unit,
      }),
    );
  }
  return limits;
}

/** Map the provider-neutral Kiro usage shape into an OMP `UsageReport`. */
export function toOmpUsageReport(usage: KiroProviderUsage, fetchedAt = Date.now()): OmpUsageReport {
  const userInfo = usage.raw?.userInfo as { email?: unknown; userId?: unknown } | undefined;
  const metadata: Record<string, unknown> = { source: "kiro-management" };
  if (usage.subscriptionTitle) metadata.planType = usage.subscriptionTitle;
  if (typeof userInfo?.email === "string" && userInfo.email) metadata.email = userInfo.email;
  if (typeof userInfo?.userId === "string" && userInfo.userId) metadata.accountId = userInfo.userId;
  return {
    provider: PROVIDER,
    fetchedAt,
    limits: (usage.usageBuckets ?? []).flatMap((bucket) => bucketLimits(bucket, usage)),
    ...(usage.overageStatus === "ENABLED" ? { notes: ["Overages enabled"] } : {}),
    metadata,
  };
}

/**
 * Usage provider registered on OMP via `registerProvider("kiro", { usage })`.
 * Profile ARN and region resolution reuse `fetchKiroUsage`, so OAuth and
 * `ksk_` API keys follow the same management-plane path as the Pi footer.
 * Failures throw; OMP's AuthStorage logs them and serves the last good report.
 */
export const kiroOmpUsageProvider: OmpUsageProvider = {
  id: PROVIDER,
  cacheVersion: 1,
  supports: ({ provider, credential }) =>
    provider === PROVIDER && Boolean(credential.type === "api_key" ? credential.apiKey : credential.accessToken),
  async fetchUsage({ credential }) {
    const access = credential.type === "api_key" ? credential.apiKey : credential.accessToken;
    if (!access) return null;
    return toOmpUsageReport(await fetchKiroUsage({ access, region: credential.region }));
  },
};
