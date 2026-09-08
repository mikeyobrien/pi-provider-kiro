// ABOUTME: Opt-in usage tracking config — reads pi settings for Kiro credit accounting.
// ABOUTME: Converts MeteringEvent credits into an estimated USD-equivalent cost.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kiro's published add-on credit rate (https://kiro.dev/pricing/). Used as the
 * conversion default so an enabled config needs no rate at all.
 */
export const DEFAULT_USD_PER_CREDIT = 0.04;

/** Resolved conversion policy. `enabled: false` reproduces the historical zero-cost behaviour. */
export type KiroUsageTracking = { enabled: false } | { enabled: true; usdPerCredit: number };

const DISABLED: KiroUsageTracking = Object.freeze({ enabled: false });

/** `MeteringEvent.unit` values that denote credits. The service has emitted both. */
const CREDIT_UNITS = new Set(["credit", "credits"]);

/**
 * Load the conversion policy from pi's settings file.
 *
 * Fails closed on every unreadable, malformed, or out-of-range input: usage
 * accounting is opt-in, so an unparseable setting must leave cost reporting
 * exactly as it was rather than guess a rate. Settings contents are never
 * logged — the file holds credentials for other providers.
 */
export function loadKiroUsageTracking(agentDir = getPiAgentDir()): KiroUsageTracking {
  const raw = readSettings(join(agentDir, "settings.json"));
  const tracking = asRecord(asRecord(raw)?.["pi-provider-kiro"])?.usageTracking;
  const section = asRecord(tracking);
  if (!section || section.enabled !== true) return DISABLED;

  const usdPerCredit = resolveRate(section.usdPerCredit);
  if (usdPerCredit === undefined) {
    console.warn(
      "[pi-provider-kiro] Ignoring usageTracking: usdPerCredit must be a finite number >= 0. Usage tracking stays disabled.",
    );
    return DISABLED;
  }
  return { enabled: true, usdPerCredit };
}

/**
 * Estimated USD-equivalent value of one turn's credits, or `undefined` when the
 * record cannot be trusted.
 *
 * This is a conversion of Kiro's own credit count, NOT a billed amount: credits
 * included in a subscription may carry no marginal charge at all.
 */
export function estimateKiroCreditCost(
  tracking: KiroUsageTracking,
  metering: { credits?: number; unit?: string } | null | undefined,
): number | undefined {
  if (!tracking.enabled || !metering) return undefined;
  if (typeof metering.unit !== "string" || !CREDIT_UNITS.has(metering.unit.toLowerCase())) return undefined;
  const { credits } = metering;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return undefined;
  return credits * tracking.usdPerCredit;
}

/** pi's agent directory, honoring the same override pi itself reads. */
export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(path: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8");
  } catch {
    return undefined; // No settings file is the common case, not an error.
  }
  try {
    return JSON.parse(contents);
  } catch {
    console.warn(`[pi-provider-kiro] Could not parse ${path}; Kiro usage tracking stays disabled.`);
    return undefined;
  }
}

/** An omitted rate takes the published default; a present one must be usable. */
function resolveRate(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_USD_PER_CREDIT;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
