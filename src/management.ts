// ABOUTME: Calls the authenticated Kiro management control plane.
// ABOUTME: Resolves profiles and discovers the current per-profile model catalog.

import { createHash } from "node:crypto";
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

interface KiroListAvailableProfilesResponse {
  profiles?: Array<{ arn?: string; [key: string]: unknown }>;
}

const profileArnCache = new Map<string, string>();
const pendingProfileRequests = new Map<string, Promise<string>>();

function operationName(target: string): string {
  return target.slice(target.lastIndexOf(".") + 1);
}

function profileCacheKey(auth: KiroManagementAuth): string {
  const tokenHash = createHash("sha256").update(auth.accessToken).digest("base64url");
  return `${auth.region}:${tokenHash}`;
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

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    throw new Error(`Kiro management ${operation} failed in ${auth.region}: ${response.status}${statusText}`);
  }

  try {
    return (await response.json()) as TResponse;
  } catch (error) {
    throw new Error(`Kiro management ${operation} returned invalid JSON in ${auth.region}`, { cause: error });
  }
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
