// Feature 3: OAuth — Kiro Authentication
//
// Supports multiple auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO) via device code flow
//   - "desktop": Google/GitHub social login via Kiro auth service (delegates to kiro-cli)
//
// When no existing credentials are found (no Kiro IDE, no kiro-cli), falls back
// to the interactive login flow in login.ts (Feature 10).

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { formatSafeError } from "./debug.js";
import { resolveApiRegion } from "./endpoints.js";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
import { interactiveLogin, loginViaKiroCli } from "./login.js";
import { encodeKiroRefresh, kiroCredentialRegion, parseKiroRefresh } from "./refresh-token.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";
export type KiroLoginMethod = "auto" | "builder-id" | "google" | "github";

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
  profileArn?: string;
  startUrl?: string;
  isEnterprise?: boolean;
}

export const KIRO_DESKTOP_USER_AGENT = "Kiro-Desktop/0.2.13 (darwin; arm64)";

export function kiroUserAgent(service: string, sdkVersion: string): Record<string, string> {
  return {
    "User-Agent": `aws-sdk-js/3.714.0 os/macos/24.3.0 lang/js md/nodejs/22.14.0 api/${service}/3.714.0 exec-env/kiro-cli/2.7.0 m/E`,
    "amz-sdk-invocation-id": "00000000-0000-0000-0000-000000000000",
    "amz-sdk-request": `attempt=1; max=${sdkVersion}`,
  };
}

export function kiroAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (isApiKey(token)) {
    headers.tokentype = "API_KEY";
  }
  return headers;
}

export function isApiKey(token: string): boolean {
  return token.startsWith("ksk_");
}

export async function loginKiroWithApiKey(callbacks: OAuthLoginCallbacks, apiKey: string): Promise<OAuthCredentials> {
  if (!apiKey.startsWith("ksk_")) {
    throw new Error("Invalid API key format. Kiro API keys start with 'ksk_'.");
  }

  (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.("Validating API key...");

  const { resolveApiRegion } = await import("./endpoints.js");
  // API keys are issued for the us-east-1 control plane.
  const region = "us-east-1";
  const apiRegion = resolveApiRegion(region);
  const managementUrl = `https://management.${apiRegion}.kiro.dev/`;

  // GetProfile with an empty body returns the API key's own profile.
  const resp = await fetch(managementUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
      ...kiroAuthHeaders(apiKey),
      ...kiroUserAgent("codewhispererruntime", "F,C"),
    },
    body: "{}",
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "";
    }
    if (resp.status === 401 || resp.status === 403 || /Invalid token/i.test(detail)) {
      throw new Error("API key was rejected by Kiro. Check that the key is valid and not expired.");
    }
    throw new Error(`Kiro GetProfile failed: ${resp.status} ${resp.statusText} ${detail}`.trim());
  }

  const data = (await resp.json()) as { profile?: { arn?: string } };
  const profileArn = data.profile?.arn;

  const kiroCreds: KiroCredentials = {
    access: apiKey,
    refresh: encodeKiroRefresh({ token: apiKey, fields: [], authMethod: "apikey" }),
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    clientId: "",
    clientSecret: "",
    region,
    authMethod: "apikey",
    ...(profileArn ? { profileArn } : {}),
  };

  return kiroCreds;
}

/**
 * Login to Kiro using the specified method.
 *
 * - "auto": Use existing kiro-cli credentials if available (any method)
 * - "builder-id": AWS Builder ID via device code flow
 * - "google" | "github": Social login via kiro-cli (requires kiro-cli installed)
 */
export async function loginKiro(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const creds = await loginKiroInternal(callbacks, preferredMethod);
  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion(kiroCredentialRegion(creds));
      updateKiroModelsCache(creds.access, region, (creds as KiroCredentials).profileArn).catch((error) => {
        console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    } catch (error) {
      console.warn(`[pi-provider-kiro] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
    }
  }
  return creds;
}

async function loginKiroInternal(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, getKiroCliSocialToken } = await import(
    "./kiro-cli.js"
  );

  // If user explicitly wants social login, delegate to kiro-cli
  if (preferredMethod === "google" || preferredMethod === "github") {
    return loginViaKiroCli(callbacks, preferredMethod);
  }

  const ideCreds = getKiroIdeCredentials();
  const cliCreds = getKiroCliSocialToken() || getKiroCliCredentials();
  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  const expiredCreds = getKiroCliCredentialsAllowExpired();

  const hasCached = Boolean(ideCreds || cliCreds || expiredIdeCreds || expiredCreds);

  const { interactiveLogin } = await import("./login.js");
  const result = await interactiveLogin(callbacks, hasCached);

  if (result !== "use-cached-credentials") {
    return result;
  }

  // User chose to use cached credentials from the TUI menu
  return useCachedCascade(callbacks, preferredMethod);
}

async function useCachedCascade(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Kiro IDE credentials",
    );
    return ideCreds;
  }

  let cliCreds = getKiroCliSocialToken();
  if (!cliCreds) {
    cliCreds = getKiroCliCredentials();
  }

  if (
    cliCreds &&
    (preferredMethod === "auto" ||
      cliCreds.authMethod === "idc" ||
      cliCreds.authMethod === "external-idp" ||
      cliCreds.authMethod === "apikey")
  ) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      cliCreds.authMethod === "desktop"
        ? "Using existing kiro-cli social credentials"
        : cliCreds.authMethod === "external-idp"
          ? "Using existing kiro-cli external IdP credentials"
          : "Using existing kiro-cli credentials",
    );
    return cliCreds;
  }

  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  if (expiredIdeCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing Kiro IDE credentials...",
      );
      return await refreshKiroTokenDirect(expiredIdeCreds);
    } catch {
      // Ignore
    }
  }

  const expiredCreds = getKiroCliCredentialsAllowExpired();
  if (expiredCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing expired kiro-cli credentials...",
      );
      const refreshed = await refreshKiroTokenDirect(expiredCreds);
      saveKiroCliCredentials(refreshed as KiroCredentials);
      return refreshed;
    } catch {
      // Ignore
    }
  }

  throw new Error("No valid cached credentials found");
}

/**
 * Backward-compatible alias for loginKiro with Builder ID.
 * @deprecated Use loginKiro instead.
 */
export async function loginKiroBuilderID(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginKiro(callbacks, "builder-id");
}

// Token refresh buffer (5 minutes) baked into our expires timestamps at creation time.
// The actual AWS token is valid for this much longer than credentials.expires indicates.
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshed = await refreshKiroTokenInternal(credentials);
  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion(kiroCredentialRegion(refreshed));
      updateKiroModelsCache(refreshed.access, region, (refreshed as KiroCredentials).profileArn).catch((error) => {
        console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    } catch (error) {
      console.warn(`[pi-provider-kiro] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
    }
  }
  return refreshed;
}

async function refreshKiroTokenInternal(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const {
    getKiroCliCredentials,
    getKiroCliCredentialsAllowExpired,
    saveKiroCliCredentials,
    getKiroCliSocialToken,
    getKiroCliSocialTokenAllowExpired,
  } = await import("./kiro-cli.js");
  const credentialAuthMethod =
    (credentials as KiroCredentials).authMethod ?? parseKiroRefresh(credentials.refresh).authMethod;
  const getValidCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialToken();
    const cliCreds = getKiroCliCredentials();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };
  const getExpiredCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialTokenAllowExpired();
    const cliCreds = getKiroCliCredentialsAllowExpired();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };

  // API key credentials are long-lived bearer tokens — there is nothing to
  // refresh. Return them unchanged so the same key keeps being used.
  if ((credentials as KiroCredentials).authMethod === "apikey" || isApiKey(credentials.access)) {
    return credentials;
  }

  // Kiro IDE credentials are IDC credentials. Only consult them for IDC
  // credential refresh — never replace a stored social/desktop session with
  // the IDE's potentially unrelated account (auth-family guard, #142).
  if (credentialAuthMethod === "idc") {
    const ideCreds = getKiroIdeCredentials();
    if (ideCreds) return ideCreds;
  }

  // Prefer a fresh CLI token only when it belongs to the same auth family.
  const preCheckCreds = getValidCliCredentials();
  if (preCheckCreds) return preCheckCreds;

  try {
    const refreshed = await refreshKiroTokenDirect(credentials);

    // Write refreshed tokens back to kiro-cli's SQLite DB so both stay in sync.
    saveKiroCliCredentials(refreshed as KiroCredentials);

    return refreshed;
  } catch (refreshError) {
    // The CLI may have rotated the refresh token between the pre-check and
    // network call. Re-read only the matching auth family.
    const retryCreds = getValidCliCredentials();
    if (retryCreds) return retryCreds;

    // The CLI may have a newer refresh token with an expired access token.
    const expiredCliCreds = getExpiredCliCredentials();
    if (expiredCliCreds && expiredCliCreds.refresh !== credentials.refresh) {
      try {
        const refreshedFromCli = await refreshKiroTokenDirect(expiredCliCreds);
        saveKiroCliCredentials(refreshedFromCli as KiroCredentials);
        return refreshedFromCli;
      } catch {
        // Also failed, continue to remaining fallbacks
      }
    }

    // Our expires has a 5-min buffer, so the actual token may still be valid.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const { token: refreshToken, fields, authMethod } = parseKiroRefresh(credentials.refresh);
  const region = kiroCredentialRegion(credentials) ?? "us-east-1";

  if (authMethod === "apikey") {
    // API keys are long-lived bearer tokens — no refresh needed.
    return credentials;
  }

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": KIRO_DESKTOP_USER_AGENT },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: encodeKiroRefresh({
        token: data.refreshToken || refreshToken,
        fields: [],
        authMethod: "desktop",
        region,
      }),
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop" as KiroAuthMethod,
      profileArn: data.profileArn || (credentials as KiroCredentials).profileArn,
      startUrl: (credentials as KiroCredentials).startUrl,
    };
  }

  // External IdP (enterprise OIDC, e.g. Okta) — standard public-client refresh
  // against the customer's own token endpoint. kiro-cli does the same:
  // form-encoded grant_type/client_id/refresh_token, snake_case response, and
  // no client secret because the OIDC app is a public PKCE client.
  if (authMethod === "external-idp") {
    const idpClientId = fields[0] ?? "";
    const tokenEndpoint = fields[1] ?? "";
    if (!tokenEndpoint) throw new Error("External IdP token refresh: missing token endpoint");
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "pi-cli",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: idpClientId,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error(`External IdP token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error("External IdP token refresh: missing access_token");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    return {
      refresh: encodeKiroRefresh({
        token: data.refresh_token || refreshToken,
        fields: [idpClientId, tokenEndpoint],
        authMethod: "external-idp",
        region,
      }),
      access: data.access_token,
      expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
      clientId: idpClientId,
      clientSecret: "",
      region,
      authMethod: "external-idp" as KiroAuthMethod,
      profileArn: (credentials as KiroCredentials).profileArn,
    };
  }

  // IDC auth method — SSO OIDC refresh
  const clientId = fields[0] ?? "";
  const clientSecret = fields[1] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...kiroUserAgent("ssooidc", "E"),
    },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: encodeKiroRefresh({
      token: data.refreshToken,
      fields: [clientId, clientSecret],
      authMethod: "idc",
      region,
    }),
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
    clientId: clientId,
    clientSecret: clientSecret,
    region,
    authMethod: "idc" as KiroAuthMethod,
    profileArn: (credentials as KiroCredentials).profileArn,
    startUrl: (credentials as KiroCredentials).startUrl,
    isEnterprise: (credentials as KiroCredentials).isEnterprise,
  };
}
