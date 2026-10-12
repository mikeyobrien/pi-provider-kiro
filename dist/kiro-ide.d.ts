import type { KiroCredentials } from "./oauth.js";
/**
 * Returns valid (non-expired) Kiro IDE credentials read from
 * ~/.aws/sso/cache/kiro-auth-token.json, or undefined if the IDE has not
 * logged in or the token has already expired.
 */
export declare function getKiroIdeCredentials(): KiroCredentials | undefined;
/**
 * Like getKiroIdeCredentials but also returns expired tokens so the caller can
 * attempt a silent OIDC refresh before falling back to the full login flow.
 */
export declare function getKiroIdeCredentialsAllowExpired(): KiroCredentials | undefined;
