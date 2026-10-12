import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type KiroFooterConfig } from "./footer.js";
import type { KiroProviderUsage } from "./usage.js";
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
export declare function registerKiroUsageFooter(pi: ExtensionAPI, deps: KiroUsageFooterDeps): void;
