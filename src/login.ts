// Feature 10: Interactive Login — device code flow fallback
//
// Reached when no existing credentials are found (no Kiro IDE, no kiro-cli).
// Matches the four options shown on app.kiro.dev/signin:
//   Builder ID, Your organization (IAM IdC), Google, GitHub
//
// Primary path: native TUI component (login-ui.ts) via ctx.ui.custom().
//   Uses zero onPrompt calls — SelectList for method, Input for IdC URL.
// Fallback path: single onPrompt call when ctx is not yet available
//   (e.g. first run before session_start fires).
//
// For IAM Identity Center, the SSO region is auto-detected by probing
// common AWS OIDC endpoints. Inference/API region is derived from SSO
// region automatically via resolveApiRegion() in models.ts.

import { execFileSync } from "node:child_process";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { showLoginUI } from "./login-ui.js";
import { BUILDER_ID_START_URL, type KiroAuthMethod, type KiroCredentials, SSO_SCOPES } from "./oauth.js";

type PromptFn = (p: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;

function getPrompt(callbacks: OAuthLoginCallbacks): PromptFn {
  return (callbacks as unknown as { onPrompt: PromptFn }).onPrompt;
}

function getProgress(callbacks: OAuthLoginCallbacks): ((msg: string) => void) | undefined {
  return (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress;
}

function getSignal(callbacks: OAuthLoginCallbacks): AbortSignal | undefined {
  return (callbacks as unknown as { signal?: AbortSignal }).signal;
}

// Regions to probe when auto-detecting the IAM Identity Center OIDC region.
// Must cover every SSO region that resolveApiRegion() maps to a Kiro API region,
// plus the API regions themselves. Ordered by likelihood.
const IDC_PROBE_REGIONS = [
  "us-east-1", // Kiro API region + common SSO region
  "eu-west-1", // SSO region → eu-central-1 API
  "eu-central-1", // Kiro API region + SSO region
  "us-east-2", // SSO region → us-east-1 API
  "eu-west-2", // SSO region → eu-central-1 API
  "eu-west-3", // SSO region → eu-central-1 API
  "eu-north-1", // SSO region → eu-central-1 API
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2",
];

type DeviceAuth = {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
};

/**
 * Interactive login fallback — shown when no existing credentials are available.
 *
 * Uses pi's native TUI components (SelectList + Input) via ctx.ui.custom()
 * when available, falling back to a single onPrompt call otherwise.
 * This avoids pi's stacked-input bug where sequential onPrompt calls
 * render simultaneously with mirrored cursors.
 */
export async function interactiveLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // Try native TUI component first (requires ctx from session_start)
  const choice = await showLoginUI();

  if (choice) {
    switch (choice.method) {
      case "builder-id":
        return runDeviceCodeFlow(callbacks, BUILDER_ID_START_URL, "us-east-1");
      case "idc":
        return runDeviceCodeFlowWithRegionDetection(callbacks, choice.startUrl);
      case "google":
        return loginViaKiroCli(callbacks, "google");
      case "github":
        return loginViaKiroCli(callbacks, "github");
    }
  }

  // Fallback: single onPrompt (ctx not available, e.g. first run before session_start)
  const input =
    (
      await getPrompt(callbacks)({
        message: "Paste IAM Identity Center URL, or blank for Builder ID",
        placeholder: "https://mycompany.awsapps.com/start",
        allowEmpty: true,
      })
    )?.trim() || "";

  if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");

  if (!input) return runDeviceCodeFlow(callbacks, BUILDER_ID_START_URL, "us-east-1");
  if (!input.startsWith("http"))
    throw new Error(`Invalid input "${input}". Paste your start URL or leave blank for Builder ID.`);
  return runDeviceCodeFlowWithRegionDetection(callbacks, input);
}

/**
 * Register an OIDC client and start device authorization in a given region.
 * Returns null if the region rejects the startUrl.
 */
async function tryRegisterAndAuthorize(
  startUrl: string,
  region: string,
): Promise<{ clientId: string; clientSecret: string; oidcEndpoint: string; devAuth: DeviceAuth } | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  const regResp = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({
      clientName: "pi-cli",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) return null;
  const { clientId, clientSecret } = (await regResp.json()) as { clientId: string; clientSecret: string };

  const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!devResp.ok) return null;

  return { clientId, clientSecret, oidcEndpoint, devAuth: (await devResp.json()) as DeviceAuth };
}

/**
 * Run device code flow for a known region (e.g. Builder ID -> us-east-1).
 */
async function runDeviceCodeFlow(
  callbacks: OAuthLoginCallbacks,
  startUrl: string,
  region: string,
): Promise<OAuthCredentials> {
  const result = await tryRegisterAndAuthorize(startUrl, region);
  if (!result) throw new Error(`Device authorization failed in ${region}`);
  return pollDeviceCode(callbacks, result.clientId, result.clientSecret, region, result.oidcEndpoint, result.devAuth);
}

/**
 * Probe common AWS regions to find which OIDC endpoint accepts the given start URL,
 * then run the device code flow in that region.
 */
async function runDeviceCodeFlowWithRegionDetection(
  callbacks: OAuthLoginCallbacks,
  startUrl: string,
): Promise<OAuthCredentials> {
  getProgress(callbacks)?.("Detecting your Identity Center region...");

  for (const region of IDC_PROBE_REGIONS) {
    const result = await tryRegisterAndAuthorize(startUrl, region);
    if (result) {
      getProgress(callbacks)?.(`Region detected: ${region}`);
      return pollDeviceCode(
        callbacks,
        result.clientId,
        result.clientSecret,
        region,
        result.oidcEndpoint,
        result.devAuth,
      );
    }
  }

  throw new Error(
    `Could not find an AWS region that accepts ${startUrl}. ` +
      `Tried: ${IDC_PROBE_REGIONS.join(", ")}. Check your start URL and try again.`,
  );
}

/**
 * Poll the OIDC token endpoint until the user completes browser auth or timeout.
 */
async function pollDeviceCode(
  callbacks: OAuthLoginCallbacks,
  clientId: string,
  clientSecret: string,
  region: string,
  oidcEndpoint: string,
  devAuth: DeviceAuth,
): Promise<OAuthCredentials> {
  (callbacks as unknown as { onAuth: (info: { url: string; instructions: string }) => void }).onAuth({
    url: devAuth.verificationUriComplete,
    instructions: `Your code: ${devAuth.userCode}`,
  });

  const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
  const baseInterval = (devAuth.interval || 5) * 1000;
  let interval = baseInterval;

  while (Date.now() < deadline) {
    if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
    await new Promise((r) => setTimeout(r, interval));

    const tokResp = await fetch(`${oidcEndpoint}/token`, {
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

    switch (tokData.error) {
      case undefined:
        if (tokData.accessToken && tokData.refreshToken) {
          return {
            refresh: `${tokData.refreshToken}|${clientId}|${clientSecret}|idc`,
            access: tokData.accessToken,
            expires: Date.now() + (tokData.expiresIn || 3600) * 1000 - 5 * 60 * 1000,
            clientId,
            clientSecret,
            region,
            authMethod: "idc" as KiroAuthMethod,
          } satisfies KiroCredentials;
        }
        break;
      case "authorization_pending":
        break;
      case "slow_down":
        interval += baseInterval;
        break;
      default:
        throw new Error(`Authorization failed: ${tokData.error}`);
    }
  }
  throw new Error("Authorization timed out");
}

/**
 * Delegate Google/GitHub social login to kiro-cli.
 * Requires kiro-cli to be installed and in PATH.
 */
export async function loginViaKiroCli(
  callbacks: OAuthLoginCallbacks,
  provider: "google" | "github",
): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliSocialToken } = await import("./kiro-cli.js");

  getProgress(callbacks)?.(`Initiating ${provider} login via kiro-cli...`);

  try {
    execFileSync("kiro-cli", ["login", "--license", "free"], {
      timeout: 120000,
      stdio: "inherit",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`kiro-cli login failed: ${msg}. Ensure kiro-cli is installed and in PATH.`);
  }

  const creds = getKiroCliSocialToken() || getKiroCliCredentials();
  if (!creds) throw new Error("kiro-cli login completed but no credentials found in its database");

  getProgress(callbacks)?.(creds.authMethod === "desktop" ? "Google/GitHub login successful" : "Login successful");
  return creds;
}
