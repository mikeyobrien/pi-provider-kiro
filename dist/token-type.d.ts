/**
 * True when the access token is an external IdP (enterprise OIDC) JWT.
 *
 * AWS SSO / Builder ID and Kiro desktop tokens are opaque strings, so a
 * three-segment JWT carrying `aud: "api://kiro"` identifies the external IdP
 * case without needing the auth method threaded through every call site.
 */
export declare function isExternalIdpAccessToken(accessToken: string | undefined): boolean;
/**
 * Extra headers Kiro's management and runtime APIs require for the given token.
 *
 * kiro-cli sends `tokentype: EXTERNAL_IDP` on every request made with an
 * external IdP token (its `TokenTypeInterceptor`); without it both
 * `management.*.kiro.dev` and `runtime.*.kiro.dev` answer 403 "Invalid token".
 * Returns an empty object for AWS SSO and desktop tokens, which must not carry
 * the header.
 */
export declare function kiroTokenTypeHeaders(accessToken: string | undefined): Record<string, string>;
