import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
/**
 * Interactive login fallback — shown when no existing credentials are available.
 *
 * Uses pi's native TUI components (SelectList + Input) via ctx.ui.custom()
 * when available, falling back to a single onPrompt call otherwise.
 * This avoids pi's stacked-input bug where sequential onPrompt calls
 * render simultaneously with mirrored cursors.
 */
export declare function interactiveLogin(callbacks: OAuthLoginCallbacks, hasCached?: boolean): Promise<OAuthCredentials | "use-cached-credentials">;
/**
 * Social login flow with PKCE using a local localhost server callback.
 */
export declare function runSocialLoginFlow(callbacks: OAuthLoginCallbacks, provider?: "google" | "github"): Promise<OAuthCredentials>;
/**
 * Delegate Google/GitHub social login to kiro-cli.
 * Requires kiro-cli to be installed and in PATH.
 */
export declare function loginViaKiroCli(callbacks: OAuthLoginCallbacks, provider: "google" | "github"): Promise<OAuthCredentials>;
