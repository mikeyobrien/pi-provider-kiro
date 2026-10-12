import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";
export declare function getKiroCliDbPath(): string | undefined;
export declare function getKiroCliCredentials(): KiroCredentials | undefined;
/**
 * Like getKiroCliCredentials but returns credentials even when the access token
 * is expired, as long as a refresh token exists. Used to attempt a token refresh
 * before falling back to the full device code login flow.
 */
export declare function getKiroCliCredentialsAllowExpired(): KiroCredentials | undefined;
declare function tryKiroCliToken(dbPath: string, tokenKey: string, authMethod: KiroAuthMethod, allowExpired?: boolean): KiroCredentials | undefined;
export { tryKiroCliToken };
/**
 * Get the social token (Google/GitHub) from kiro-cli if available.
 * Returns undefined if no valid social token exists.
 * This is used to prefer social login when the user has logged in that way.
 */
export declare function getKiroCliSocialToken(): KiroCredentials | undefined;
/**
 * Like getKiroCliSocialToken but returns credentials even when the access token
 * is expired, as long as a refresh token exists.
 */
export declare function getKiroCliSocialTokenAllowExpired(): KiroCredentials | undefined;
export declare function saveKiroCliCredentials(creds: KiroCredentials): void;
/**
 * Ask kiro-cli to refresh its own tokens via `kiro-cli debug refresh-auth-token`,
 * then re-read the SQLite DB for fresh credentials.
 *
 * Returns refreshed credentials on success, or undefined if kiro-cli is not
 * installed, the command fails, or the DB still has no valid tokens afterward.
 */
export declare function refreshViaKiroCli(): KiroCredentials | undefined;
