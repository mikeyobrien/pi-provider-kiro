// ABOUTME: Calls the authenticated Kiro management control plane.
// ABOUTME: Resolves profiles and discovers the current per-profile model catalog.

import { createHash } from "node:crypto";
import { debugLog, redactSensitiveText } from "./debug.js";
import { getKiroEndpoints } from "./endpoints.js";
import { isApiKey, kiroAuthHeaders, kiroUserAgent } from "./oauth.js";
import { kiroTokenTypeHeaders } from "./token-type.js";

const LIST_PROFILES_PATH = "List-Available-Profiles";
const LIST_MODELS_PATH = "List-Available-Models";
const GET_PROFILE_TARGET = "AmazonCodeWhispererService.GetProfile";

/**
 * Region Kiro issues API keys against. `ListAvailableProfiles` answers 403
 * "Unsupported token type" for a `ksk_` key in every region, so an API key's
 * profile — and therefore its model catalog — is only reachable here.
 */
const API_KEY_REGION = "us-east-1";

export interface KiroManagementAuth {
  accessToken: string;
  region: string;
}

export interface KiroCatalogModel {
  modelId: string;
  tokenLimits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface KiroListAvailableModelsResponse {
  models: KiroCatalogModel[];
  [key: string]: unknown;
}

export interface KiroGetUsageLimitsRequest {
  profileArn?: string;
  origin: "KIRO_CLI";
  resourceType: "CREDIT";
  isEmailRequired: false;
}

interface KiroListAvailableProfilesResponse {
  profiles?: Array<{ arn?: string; [key: string]: unknown }>;
}

interface KiroGetProfileResponse {
  profile?: { arn?: string; [key: string]: unknown };
}

const profileArnCache = new Map<string, string>();
const pendingProfileRequests = new Map<string, Promise<string>>();
/**
 * Region where the token actually has a profile, keyed like profileArnCache.
 * Populated when resolveKiroProfileArn finds the ARN on a non-primary region so
 * callers can route profile-dependent management calls (ListAvailableModels) to
 * the same region where the profile exists.
 */
const profileRegionCache = new Map<string, string>();

/**
 * Canonical Kiro management regions. `resolveApiRegion` funnels every SSO region
 * into one of these, but a user's actual Kiro profile may live in the other one
 * (see #104: SSO eu-west-2 -> eu-central-1 while the profile is in us-east-1).
 * ListAvailableProfiles is regional, so probe the canonical set when the primary
 * region comes back empty before giving up.
 */
const CANONICAL_MANAGEMENT_REGIONS = ["us-east-1", "eu-central-1"] as const;

function candidateManagementRegions(primary: string): string[] {
  const seen = new Set<string>([primary]);
  const candidates = [primary];
  for (const region of CANONICAL_MANAGEMENT_REGIONS) {
    if (!seen.has(region)) {
      seen.add(region);
      candidates.push(region);
    }
  }
  return candidates;
}

/**
 * Explicit user override for which Kiro profile to resolve/use. When set, it
 * wins over any token-carried or network-discovered profile, fixing #110's
 * "wrong profile picked among several -> reduced model catalog" for users who
 * have multiple profiles and know which one they want.
 */
const ENV_PROFILE_ARN = "KIRO_PROFILE_ARN";

export class KiroManagementHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KiroManagementHttpError";
  }
}

async function requestManagement<TResponse>(
  auth: KiroManagementAuth,
  operation: string,
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
): Promise<TResponse> {
  const url = new URL(path, getKiroEndpoints(auth.region).management);
  const request: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      ...kiroAuthHeaders(auth.accessToken),
      ...kiroTokenTypeHeaders(auth.accessToken),
    },
  };
  if (method === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  } else {
    request.headers = { ...request.headers, "Content-Type": "application/json" };
    request.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), request);
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}

function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash("sha256").update(auth.accessToken).digest("base64url");
  return `${auth.region}:${tokenHash}`;
}

/**
 * Resolve an API key's own profile through GetProfile, the same RPC the API-key
 * login flow uses. This is the only profile-discovery call a `ksk_` key can
 * make: the REST-style ListAvailableProfiles path rejects the key outright.
 */
async function getApiKeyProfileArn(accessToken: string): Promise<string> {
  const operation = "GetProfile";
  let response: Response;
  try {
    response = await fetch(getKiroEndpoints(API_KEY_REGION).management, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": GET_PROFILE_TARGET,
        ...kiroAuthHeaders(accessToken),
        ...kiroUserAgent("codewhispererruntime", "F,C"),
      },
      body: "{}",
    });
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${API_KEY_REGION}`, { cause: error });
  }

  const parsed = await parseManagementResponse<KiroGetProfileResponse>(response, operation, API_KEY_REGION);
  const arn = parsed.profile?.arn;
  if (!arn) {
    throw new Error(`Kiro management ${operation} returned no profile in ${API_KEY_REGION}`);
  }
  return arn;
}

async function parseManagementResponse<TResponse>(
  response: Response,
  operation: string,
  region: string,
): Promise<TResponse> {
  if (!response.ok) {
    const statusText = response.statusText ? ` ${redactSensitiveText(response.statusText)}` : "";
    throw new KiroManagementHttpError(
      `Kiro management ${operation} failed in ${region}: ${response.status}${statusText}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as TResponse;
  } catch (error) {
    throw new Error(`Kiro management ${operation} returned invalid JSON in ${region}`, { cause: error });
  }
}
export function resetKiroProfileArnCache(): void {
  profileArnCache.clear();
  profileRegionCache.clear();
  pendingProfileRequests.clear();
}

export function invalidateKiroProfileArn(auth: KiroManagementAuth): void {
  const key = profileCacheKey(auth);
  profileArnCache.delete(key);
  profileRegionCache.delete(key);
  pendingProfileRequests.delete(key);
}

export async function resolveKiroProfileArn(auth: KiroManagementAuth, providedArn?: string): Promise<string> {
  // Explicit user override (#110). Highest precedence: a user who pins
  // KIRO_PROFILE_ARN knows which profile they want, even if the token or the
  // profile list contains several candidates.
  const envArn = process.env[ENV_PROFILE_ARN]?.trim();
  if (envArn) {
    debugLog("profile.resolve", { source: "env", arn: envArn });
    return envArn;
  }
  if (providedArn) {
    debugLog("profile.resolve", { source: "provided", arn: providedArn });
    return providedArn;
  }

  const key = profileCacheKey(auth);
  const cachedArn = profileArnCache.get(key);
  if (cachedArn) return cachedArn;

  const pending = pendingProfileRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    // A `ksk_` API key cannot use ListAvailableProfiles at all, so route it to
    // GetProfile and pin the profile region to where API keys are issued.
    if (isApiKey(auth.accessToken)) {
      const arn = await getApiKeyProfileArn(auth.accessToken);
      profileArnCache.set(key, arn);
      profileRegionCache.set(key, API_KEY_REGION);
      debugLog("profile.resolve", { source: "api-key", region: API_KEY_REGION, arn });
      return arn;
    }

    // ListAvailableProfiles is regional to where the profile actually lives, not
    // to the SSO-derived API region. Probe the primary region first, then the
    // remaining canonical management regions, so a region-mismatched token still
    // resolves a profile instead of failing hard (#104, #131).
    let lastResponse: KiroListAvailableProfilesResponse | undefined;
    let lastHttpError: KiroManagementHttpError | undefined;
    for (const region of candidateManagementRegions(auth.region)) {
      let response: KiroListAvailableProfilesResponse;
      try {
        response = await requestManagement<KiroListAvailableProfilesResponse>(
          { ...auth, region },
          "ListAvailableProfiles",
          LIST_PROFILES_PATH,
          "POST",
          {},
        );
      } catch (error) {
        // A regional 403 means the token has no profile *in this region*, not
        // that it is globally rejected. The profile can live in another
        // canonical region, so keep probing; only rethrow if no region yields
        // a profile, so callers that treat a 403 as "refresh credentials and
        // retry" (#107) still see the auth-plane signal when it is genuine.
        if (error instanceof KiroManagementHttpError && error.status === 403) {
          lastHttpError = error;
          continue;
        }
        throw error;
      }
      lastResponse = response;
      const arn = response.profiles?.find((profile) => profile.arn)?.arn;
      if (arn) {
        profileArnCache.set(key, arn);
        profileRegionCache.set(key, region);
        debugLog("profile.resolve", { source: "network", region, arn });
        return arn;
      }
    }
    if (lastHttpError) throw lastHttpError;
    const attemptedRegions = candidateManagementRegions(auth.region).join(", ");
    throw new Error(
      `Kiro management ListAvailableProfiles returned no profile in ${attemptedRegions} ` +
        `(SSO-derived region: ${auth.region}). If kiro-cli works, verify your profile region with \`kiro-cli whoami\`; ` +
        `the management API is regional to the profile, not to your login region.`,
      ...(lastResponse ? [{ cause: lastResponse }] : []),
    );
  })();
  pendingProfileRequests.set(key, request);

  try {
    return await request;
  } finally {
    if (pendingProfileRequests.get(key) === request) pendingProfileRequests.delete(key);
  }
}

export async function listAvailableModels(
  auth: KiroManagementAuth,
  profileArn: string,
): Promise<KiroListAvailableModelsResponse> {
  const response = await requestManagement<KiroListAvailableModelsResponse>(
    auth,
    "ListAvailableModels",
    LIST_MODELS_PATH,
    "GET",
    {
      origin: "KIRO_CLI",
      profileArn,
    },
  );

  if (!Array.isArray(response.models) || response.models.length === 0) {
    throw new Error(`Kiro management ListAvailableModels returned no models in ${auth.region}`);
  }
  if (response.models.some((model) => !model || typeof model.modelId !== "string" || !model.modelId)) {
    throw new Error(`Kiro management ListAvailableModels returned an invalid catalog in ${auth.region}`);
  }

  return response;
}

export async function fetchKiroModelCatalog(
  auth: KiroManagementAuth,
  providedProfileArn?: string,
): Promise<KiroListAvailableModelsResponse> {
  const profileArn = await resolveKiroProfileArn(auth, providedProfileArn);
  // Route the models query to the region where the profile actually lives — it
  // may differ from the SSO-derived region (#104), and ListAvailableModels is
  // regional to the profile too, not to the login region. An API key's profile
  // always lives in the key-issuing region, even when a pinned KIRO_PROFILE_ARN
  // skipped discovery and left no cached region behind.
  const region = isApiKey(auth.accessToken)
    ? API_KEY_REGION
    : (profileRegionCache.get(profileCacheKey(auth)) ?? auth.region);
  if (region !== auth.region) {
    return listAvailableModels({ ...auth, region }, profileArn);
  }
  return listAvailableModels(auth, profileArn);
}

export async function getUsageLimits<TResponse>(
  auth: KiroManagementAuth,
  request: KiroGetUsageLimitsRequest,
): Promise<TResponse> {
  const operation = "GetUsageLimits";
  const url = new URL("Get-Usage-Limits", getKiroEndpoints(auth.region).management);
  for (const [name, value] of Object.entries(request)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...kiroAuthHeaders(auth.accessToken),
        ...kiroTokenTypeHeaders(auth.accessToken),
        "User-Agent": "pi-provider-kiro",
      },
    });
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}
