// Feature 3: OAuth — Kiro Authentication
//
// Supports multiple auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO) via device code flow
//   - "desktop": Google/GitHub social login via Kiro auth service (delegates to kiro-cli)
//
// Social login (Google/GitHub) uses PKCE with localhost callback, which requires
// either a local browser or SSH port forwarding. We delegate to kiro-cli for this
// flow since it already handles the complexity.

import { execFileSync } from "node:child_process";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

export type KiroAuthMethod = "idc" | "desktop";
export type KiroLoginMethod = "auto" | "builder-id" | "google" | "github";

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
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
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  // If user explicitly wants social login, delegate to kiro-cli
  if (preferredMethod === "google" || preferredMethod === "github") {
    return loginViaKiroCli(callbacks, preferredMethod);
  }

  // 1. Kiro IDE token (~/.aws/sso/cache/kiro-auth-token.json)
  //    Checked first because the IDE keeps it continuously fresh and it already
  //    covers IAM Identity Center logins — no extra prompts needed.
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds && (preferredMethod === "auto" || preferredMethod === "builder-id")) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Kiro IDE credentials",
    );
    return ideCreds;
  }

  // 2. kiro-cli DB credentials (social / Builder ID / IdC)
  let cliCreds = getKiroCliSocialToken();
  if (!cliCreds) {
    cliCreds = getKiroCliCredentials();
  }

  if (cliCreds && (preferredMethod === "auto" || cliCreds.authMethod === "idc")) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      cliCreds.authMethod === "desktop"
        ? "Using existing kiro-cli social credentials"
        : "Using existing kiro-cli credentials",
    );
    return cliCreds;
  }

  // 3. Expired IDE token — attempt a silent AWS OIDC refresh
  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  if (expiredIdeCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing Kiro IDE credentials...",
      );
      return await refreshKiroTokenDirect(expiredIdeCreds);
    } catch {
      // Fall through to kiro-cli refresh
    }
  }

  // 4. Expired kiro-cli credentials — attempt a silent refresh
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
      // Refresh failed, fall through to device code flow
    }
  }

  // Fall back to device code flow
  const regResp = await fetch(`${SSO_OIDC_ENDPOINT}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({
      clientName: "pi-cli",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) throw new Error(`Client registration failed: ${regResp.status}`);
  const { clientId, clientSecret } = (await regResp.json()) as { clientId: string; clientSecret: string };

  const devResp = await fetch(`${SSO_OIDC_ENDPOINT}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({ clientId, clientSecret, startUrl: BUILDER_ID_START_URL }),
  });
  if (!devResp.ok) throw new Error(`Device authorization failed: ${devResp.status}`);
  const devAuth = (await devResp.json()) as {
    verificationUri: string;
    verificationUriComplete: string;
    userCode: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
  };

  (callbacks as unknown as { onAuth: (info: { url: string; instructions: string }) => void }).onAuth({
    url: devAuth.verificationUriComplete,
    instructions: `Your code: ${devAuth.userCode}`,
  });

  const interval = (devAuth.interval || 5) * 1000;
  const maxAttempts = Math.floor((devAuth.expiresIn || 600) / (devAuth.interval || 5));
  let currentInterval = interval;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if ((callbacks as unknown as { signal?: AbortSignal }).signal?.aborted) throw new Error("Login cancelled");
    await new Promise((r) => setTimeout(r, currentInterval));
    const tokResp = await fetch(`${SSO_OIDC_ENDPOINT}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode: devAuth.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const tokData = (await tokResp.json()) as {
      error?: string;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };
    if (tokData.error === "authorization_pending") continue;
    if (tokData.error === "slow_down") {
      currentInterval += interval;
      continue;
    }
    if (tokData.error) throw new Error(`Authorization failed: ${tokData.error}`);
    if (tokData.accessToken && tokData.refreshToken) {
      return {
        refresh: `${tokData.refreshToken}|${clientId}|${clientSecret}|idc`,
        access: tokData.accessToken,
        expires: Date.now() + (tokData.expiresIn || 3600) * 1000 - 5 * 60 * 1000,
        clientId,
        clientSecret,
        region: "us-east-1",
        authMethod: "idc" as KiroAuthMethod,
      };
    }
  }
  throw new Error("Authorization timed out");
}

/**
 * Delegate social login to kiro-cli.
 * Requires kiro-cli to be installed and in PATH.
 */
async function loginViaKiroCli(
  callbacks: OAuthLoginCallbacks,
  provider: "google" | "github",
): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliSocialToken } = await import("./kiro-cli.js");

  (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
    `Initiating ${provider} login via kiro-cli...`,
  );

  // Run kiro-cli login
  try {
    execFileSync("kiro-cli", ["login", "--license", "free"], {
      timeout: 120000, // 2 minutes should be enough
      stdio: "inherit", // Let kiro-cli handle the browser/auth UX
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`kiro-cli login failed: ${msg}. Ensure kiro-cli is installed and in PATH.`);
  }

  // Read the new credentials from kiro-cli's DB (prefer social token)
  const creds = getKiroCliSocialToken() || getKiroCliCredentials();
  if (!creds) {
    throw new Error("kiro-cli login completed but no credentials found in its database");
  }

  (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
    creds.authMethod === "desktop" ? "Google/GitHub login successful" : "Login successful",
  );

  return creds;
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
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  // Layer 0: Kiro IDE token — freshest source, covers IAM Identity Center
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) return ideCreds;

  // Layer 1: Pre-refresh check — prefer social token if available (user logged in that way)
  // Otherwise check for any valid kiro-cli token
  let preCheckCreds = getKiroCliSocialToken();
  if (!preCheckCreds) {
    preCheckCreds = getKiroCliCredentials();
  }
  if (preCheckCreds) {
    return preCheckCreds;
  }

  try {
    const refreshed = await refreshKiroTokenDirect(credentials);

    // Layer 2: Write refreshed tokens back to kiro-cli's SQLite DB so both stay in sync.
    saveKiroCliCredentials(refreshed as KiroCredentials);

    return refreshed;
  } catch (refreshError) {
    // Layer 3: Refresh token may have been rotated by kiro-cli between our
    // Layer 1 check and the network call. Re-read kiro-cli's DB.
    const retryCreds = getKiroCliCredentials();
    if (retryCreds) {
      return retryCreds;
    }

    // Layer 4: kiro-cli may have a newer refresh token (expired access token).
    // Try refreshing with those credentials instead of the stale ones from auth.json.
    const expiredCliCreds = getKiroCliCredentialsAllowExpired();
    if (expiredCliCreds && expiredCliCreds.refresh !== credentials.refresh) {
      try {
        const refreshedFromCli = await refreshKiroTokenDirect(expiredCliCreds);
        saveKiroCliCredentials(refreshedFromCli as KiroCredentials);
        return refreshedFromCli;
      } catch {
        // Also failed, continue to remaining fallbacks
      }
    }

    // Layer 5: Graceful degradation — our expires has a 5-min buffer, so the
    // actual AWS token may still be valid. Return it to buy time.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = (credentials as KiroCredentials).region || "us-east-1";

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as { accessToken: string; refreshToken?: string; expiresIn: number };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop" as KiroAuthMethod,
    };
  }

  // IDC auth method — SSO OIDC refresh
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
    clientId: clientId,
    clientSecret: clientSecret,
    region,
    authMethod: "idc" as KiroAuthMethod,
  };
}
