// ABOUTME: Wires the opt-in Kiro usage footer into pi's session lifecycle.
// ABOUTME: Throttles allowance refreshes and fails silently so the footer never disrupts a session.

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSafeError } from "./debug.js";
import { formatKiroUsageFooter, type KiroFooterConfig } from "./footer.js";
import type { KiroProviderUsage } from "./usage.js";

/** Minimum gap between allowance refreshes, so back-to-back turns don't hammer the API. */
const DEFAULT_REFRESH_COOLDOWN_MS = 30_000;

/** Injectable seams keep the lifecycle wiring unit-testable without a live host or network. */
export interface KiroUsageFooterDeps {
  statusKey: string;
  loadConfig: () => KiroFooterConfig;
  resolveCredential: () => OAuthCredentials | undefined;
  fetchUsage: (credentials: OAuthCredentials) => Promise<KiroProviderUsage>;
  now?: () => number;
  cooldownMs?: number;
}

/**
 * Register the footer indicator when it is opted in. When disabled, this returns
 * without subscribing to any events so the extension stays inert.
 */
export function registerKiroUsageFooter(pi: ExtensionAPI, deps: KiroUsageFooterDeps): void {
  if (!deps.loadConfig().showUsageInFooter) return;

  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const clear = (ctx: ExtensionContext): void => {
    try {
      ctx.ui.setStatus(deps.statusKey, undefined);
    } catch {
      // The captured ctx can go stale across session switches; clearing a stale
      // status throws synchronously and is harmless.
    }
  };

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
    if (!ctx.hasUI) return;

    // Only Kiro turns carry a Kiro allowance; anything else clears the badge.
    if (ctx.model?.provider !== "kiro") {
      clear(ctx);
      return;
    }

    if (!force && now() - lastRefreshAt < cooldownMs) return;
    lastRefreshAt = now();

    const credential = deps.resolveCredential();
    if (!credential) {
      clear(ctx);
      return;
    }

    try {
      const usage = await deps.fetchUsage(credential);
      const badge = formatKiroUsageFooter(usage, ctx.ui.theme);
      ctx.ui.setStatus(deps.statusKey, badge);
    } catch (error) {
      // Never let a usage hiccup surface in the footer or interrupt the session.
      console.warn(`[pi-provider-kiro] Kiro usage footer refresh failed: ${formatSafeError(error)}`);
      clear(ctx);
    }
  };

  // Fresh session or an explicit model switch always refetches; completed turns
  // refresh through the cooldown so long sessions keep the badge current.
  pi.on("session_start", async (_event, ctx) => refresh(ctx, true));
  pi.on("model_select", async (_event, ctx) => refresh(ctx, true));
  pi.on("agent_end", async (_event, ctx) => refresh(ctx, false));
  pi.on("session_shutdown", async (_event, ctx) => clear(ctx));
}
