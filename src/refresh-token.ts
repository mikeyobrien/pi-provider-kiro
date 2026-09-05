// ABOUTME: Encodes and decodes the pipe-delimited Kiro refresh string.
// ABOUTME: pi persists only the documented OAuth fields, so every value the
// ABOUTME: refresh chain needs later has to travel inside `refresh` itself.

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";

/**
 * The refresh field is a pipe-delimited record, not an opaque token, because a
 * credential that has been through pi's store comes back with only `access`,
 * `refresh` and `expires` — the extra `KiroCredentials` fields do not survive.
 * Anything the refresh chain still needs therefore has to be packed in here.
 *
 * ```text
 * idc           refreshToken | clientId | clientSecret  | idc          [| region]
 * external-idp  refreshToken | clientId | tokenEndpoint | external-idp [| region]
 * desktop       refreshToken |                            desktop      [| region]
 * apikey        apiKey       |                            apikey
 * ```
 *
 * The auth-method marker keeps its historical position and the region is
 * appended after it, so strings written by earlier versions still parse: the
 * marker is located by scanning for it rather than by taking the last segment.
 *
 * `apikey` carries no region — a Kiro API key is not issued against an SSO
 * region, and the one it is validated in is a fixed constant, not a discovery.
 */
export interface KiroRefreshParts {
  /** The refresh token, or the API key itself for the `apikey` method. */
  token: string;
  /** Method-specific segments between the token and the auth-method marker. */
  fields: string[];
  authMethod: KiroAuthMethod;
  /** SSO region the credential was issued in, when the writer knew it. */
  region?: string;
}

// A record rather than a list so a new KiroAuthMethod fails the build here
// until it is classified, instead of silently parsing as an opaque segment.
const AUTH_METHOD_MARKERS: Record<KiroAuthMethod, true> = {
  idc: true,
  desktop: true,
  "external-idp": true,
  apikey: true,
};

function isAuthMethodMarker(segment: string): segment is KiroAuthMethod {
  return Object.hasOwn(AUTH_METHOD_MARKERS, segment);
}

export function parseKiroRefresh(refresh: string): KiroRefreshParts {
  const segments = refresh.split("|");

  // A malformed or pre-marker string leaves this at "idc", which is how the
  // positional parser this replaced treated any trailing segment it did not
  // recognize.
  let authMethod: KiroAuthMethod = "idc";
  let markerIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && isAuthMethodMarker(segment)) {
      authMethod = segment;
      markerIndex = i;
      break;
    }
  }

  return {
    token: segments[0] ?? "",
    fields: markerIndex === -1 ? segments.slice(1) : segments.slice(1, markerIndex),
    authMethod,
    region: markerIndex === -1 ? undefined : segments[markerIndex + 1] || undefined,
  };
}

export function encodeKiroRefresh(parts: KiroRefreshParts): string {
  const segments = [parts.token, ...parts.fields, parts.authMethod];
  if (parts.region) segments.push(parts.region);
  return segments.join("|");
}

/**
 * The SSO region a credential was issued in, or undefined when it is unknown.
 *
 * Prefers the live `region` field, which is set while the credential is still
 * the object a login or refresh returned, and falls back to the region encoded
 * in the refresh string, which is what survives persistence.
 */
export function kiroCredentialRegion(credentials: OAuthCredentials | undefined): string | undefined {
  const region = (credentials as KiroCredentials | undefined)?.region;
  if (region) return region;
  const refresh = credentials?.refresh;
  return refresh ? parseKiroRefresh(refresh).region : undefined;
}
