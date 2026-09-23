// ABOUTME: Opt-in footer indicator that renders Kiro allowance used as a compact status badge.
// ABOUTME: Pure config/formatting helpers keep the lifecycle wiring in index.ts thin and testable.

import { readFileSync } from "node:fs";
import type { KiroProviderUsage, KiroProviderUsageBucket } from "./usage.js";
import { getPiAgentDir } from "./usage-tracking.js";

/** Semantic footer color used when consumption is comfortable. */
const LOW_THRESHOLD = 70;
/** Semantic footer color used when consumption is high but not critical. */
const HIGH_THRESHOLD = 90;

/** Resolved footer policy. Disabled unless explicitly opted in. */
export interface KiroFooterConfig {
  showUsageInFooter: boolean;
}

const DISABLED: KiroFooterConfig = Object.freeze({ showUsageInFooter: false });

/** Semantic colors this badge uses, matching pi's theme foreground names. */
export type KiroFooterColor = "success" | "warning" | "error";

/** Minimal slice of pi's theme the footer needs, so tests need no full TUI theme. */
export interface KiroFooterTheme {
  fg(color: KiroFooterColor, text: string): string;
}

/**
 * Load the footer opt-in from pi's settings file.
 *
 * Fails closed on any malformed input, and never logs settings contents because
 * the file may hold credentials for other providers.
 */
export function loadKiroFooterConfig(agentDir = getPiAgentDir()): KiroFooterConfig {
  const raw = readSettings(agentDir);
  const section = asRecord(asRecord(raw)?.["pi-provider-kiro"]);
  if (!section) return { ...DISABLED };
  return { showUsageInFooter: section.showUsageInFooter === true };
}

/** Percentage of the bucket's allowance consumed (0–100), or undefined when not computable. */
export function usagePercentUsed(bucket: KiroProviderUsageBucket): number | undefined {
  const { used, limit } = bucket;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined;
  return Math.min(100, (used / limit) * 100);
}

/**
 * Choose the bucket whose percentage the footer should show: the credit bucket
 * first (Kiro's headline allowance), otherwise the first bucket with a computable
 * percentage.
 */
export function pickKiroUsageBucket(usage: KiroProviderUsage): KiroProviderUsageBucket | undefined {
  const buckets = usage.usageBuckets?.filter((bucket) => usagePercentUsed(bucket) !== undefined) ?? [];
  if (buckets.length === 0) return undefined;
  return buckets.find((bucket) => bucket.resourceType === "CREDIT") ?? buckets[0];
}

/**
 * Render the compact footer badge (e.g. `◆ Kiro 0.5%`), themed by consumption, or
 * undefined when no bucket yields a percentage.
 */
export function formatKiroUsageFooter(usage: KiroProviderUsage, theme: KiroFooterTheme): string | undefined {
  const bucket = pickKiroUsageBucket(usage);
  if (!bucket) return undefined;
  const percent = usagePercentUsed(bucket);
  if (percent === undefined) return undefined;
  const color: KiroFooterColor = percent >= HIGH_THRESHOLD ? "error" : percent >= LOW_THRESHOLD ? "warning" : "success";
  return theme.fg(color, `◆ Kiro ${formatPercent(percent)}%`);
}

/** One decimal of precision, dropped when the value is whole. */
function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function readSettings(agentDir: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(`${agentDir}/settings.json`, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(contents);
  } catch {
    console.warn("[pi-provider-kiro] Could not parse settings.json; Kiro usage footer stays disabled.");
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
