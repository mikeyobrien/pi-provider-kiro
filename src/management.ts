// ABOUTME: Calls the authenticated Kiro management control plane.
// ABOUTME: Resolves profiles and discovers the current per-profile model catalog.

import { createHash } from "node:crypto";
import { redactSensitiveText } from "./debug.js";
import { getKiroEndpoints } from "./endpoints.js";

const LIST_PROFILES_TARGET = "AmazonCodeWhispererService.ListAvailableProfiles";
const LIST_MODELS_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

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
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
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

const profileArnCache = new Map<string, string>();
const pendingProfileRequests = new Map<string, Promise<string>>();

export class KiroManagementHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KiroManagementHttpError";
  }
}

function operationName(target: string): string {
  return target.slice(target.lastIndexOf(".") + 1);
}

function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash("sha256").update(auth.accessToken).digest("base64url");
  return `${auth.region}:${tokenHash}`;
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

async function postManagement<TResponse>(
  auth: KiroManagementAuth,
  target: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const operation = operationName(target);
  let response: Response;
  try {
    response = await fetch(getKiroEndpoints(auth.region).management, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        "X-Amz-Target": target,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}

export function resetKiroProfileArnCache(): void {
  profileArnCache.clear();
  pendingProfileRequests.clear();
}

export function invalidateKiroProfileArn(auth: KiroManagementAuth): void {
  const key = profileCacheKey(auth);
  profileArnCache.delete(key);
  pendingProfileRequests.delete(key);
}

export async function resolveKiroProfileArn(auth: KiroManagementAuth, providedArn?: string): Promise<string> {
  if (providedArn) return providedArn;

  const key = profileCacheKey(auth);
  const cachedArn = profileArnCache.get(key);
  if (cachedArn) return cachedArn;

  const pending = pendingProfileRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const response = await postManagement<KiroListAvailableProfilesResponse>(auth, LIST_PROFILES_TARGET, {});
    const arn = response.profiles?.find((profile) => profile.arn)?.arn;
    if (!arn) {
      throw new Error(`Kiro management ListAvailableProfiles returned no profile in ${auth.region}`);
    }
    profileArnCache.set(key, arn);
    return arn;
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
  const response = await postManagement<KiroListAvailableModelsResponse>(auth, LIST_MODELS_TARGET, {
    origin: "KIRO_CLI",
    profileArn,
  });

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
        Authorization: `Bearer ${auth.accessToken}`,
        "User-Agent": "pi-provider-kiro",
      },
    });
  } catch (error) {
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }

  return parseManagementResponse<TResponse>(response, operation, auth.region);
}
