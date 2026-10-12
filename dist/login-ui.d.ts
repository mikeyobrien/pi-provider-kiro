import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
export type LoginChoice = {
    method: "cached";
} | {
    method: "personal";
} | {
    method: "builder-id";
} | {
    method: "google";
} | {
    method: "github";
} | {
    method: "idc";
    startUrl: string;
    region?: string;
} | {
    method: "apikey";
    apiKey: string;
} | null;
export declare function setExtensionContext(ctx: ExtensionContext): void;
export declare function hasExtensionContext(): boolean;
/**
 * Show the login method selection UI using pi's native TUI components.
 * Returns the user's choice or null if cancelled.
 */
export declare function showLoginUI(hasCached?: boolean): Promise<LoginChoice>;
/**
 * Show a waiting UI wrapper with an Escape return loop logic.
 * The user can press Escape or 'q' to abort the current login flow immediately.
 */
export declare function showWaitingUI(outerCallbacks: OAuthLoginCallbacks, _choice: Exclude<LoginChoice, null>, runAuth: (mergedCallbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>): Promise<OAuthCredentials | null>;
