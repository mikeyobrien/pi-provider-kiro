import type { KiroProviderUsage, KiroProviderUsageBucket } from "./usage.js";
/** Resolved footer policy. Disabled unless explicitly opted in. */
export interface KiroFooterConfig {
    showUsageInFooter: boolean;
}
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
export declare function loadKiroFooterConfig(agentDir?: string): KiroFooterConfig;
/** Percentage of the bucket's allowance consumed (0–100), or undefined when not computable. */
export declare function usagePercentUsed(bucket: KiroProviderUsageBucket): number | undefined;
/**
 * Choose the bucket whose percentage the footer should show: the credit bucket
 * first (Kiro's headline allowance), otherwise the first bucket with a computable
 * percentage.
 */
export declare function pickKiroUsageBucket(usage: KiroProviderUsage): KiroProviderUsageBucket | undefined;
/**
 * Render the compact footer badge (e.g. `◆ Kiro 0.5%`), themed by consumption, or
 * undefined when no bucket yields a percentage.
 */
export declare function formatKiroUsageFooter(usage: KiroProviderUsage, theme: KiroFooterTheme): string | undefined;
