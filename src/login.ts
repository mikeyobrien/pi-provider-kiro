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

import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { formatSafeError } from "./debug.js";
import { hasExtensionContext, showLoginUI, showWaitingUI } from "./login-ui.js";
import {
  BUILDER_ID_PROFILE_ARN,
  BUILDER_ID_START_URL,
  type KiroAuthMethod,
  type KiroCredentials,
  kiroUserAgent,
  loginKiroWithApiKey,
  SSO_SCOPES,
} from "./oauth.js";

const oidcHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...kiroUserAgent("ssooidc", "E"),
});

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
export async function interactiveLogin(
  callbacks: OAuthLoginCallbacks,
  hasCached?: boolean,
): Promise<OAuthCredentials | "use-cached-credentials"> {
  while (true) {
    const choice = await showLoginUI(hasCached);

    if (choice) {
      if (choice.method === "cached") {
        return "use-cached-credentials";
      }

      const runAuth = async (mergedCallbacks: OAuthLoginCallbacks) => {
        switch (choice.method) {
          case "builder-id":
            return runDeviceCodeFlow(mergedCallbacks, BUILDER_ID_START_URL, "us-east-1");
          case "google":
            return loginViaKiroCli(mergedCallbacks, "google");
          case "github":
            return loginViaKiroCli(mergedCallbacks, "github");
          case "personal":
            return runSocialLoginFlow(mergedCallbacks);
          case "idc":
            if (choice.region) {
              return runDeviceCodeFlow(mergedCallbacks, choice.startUrl, choice.region);
            }
            return runDeviceCodeFlowWithRegionDetection(mergedCallbacks, choice.startUrl);
          case "apikey":
            return loginKiroWithApiKey(mergedCallbacks, choice.apiKey);
          default:
            throw new Error("Unknown login method");
        }
      };

      const creds = await showWaitingUI(callbacks, choice, runAuth);
      if (creds) {
        return creds;
      }
      // If cancelled/failed inside the waiting UI, loop back to show main menu again
      continue;
    }

    if (hasExtensionContext()) {
      throw new Error("Login cancelled");
    }
    break;
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
    headers: oidcHeaders(),
    body: JSON.stringify({
      clientName: "Kiro CLI",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) return null;
  const { clientId, clientSecret } = (await regResp.json()) as { clientId: string; clientSecret: string };

  const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: oidcHeaders(),
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
  return pollDeviceCode(
    callbacks,
    result.clientId,
    result.clientSecret,
    region,
    result.oidcEndpoint,
    result.devAuth,
    startUrl,
  );
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
        startUrl,
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
  startUrl?: string,
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
      headers: oidcHeaders(),
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
            startUrl,
            ...(startUrl === BUILDER_ID_START_URL ? { profileArn: BUILDER_ID_PROFILE_ARN } : {}),
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

function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Social login flow with PKCE using a local localhost server callback.
 */
export async function runSocialLoginFlow(
  callbacks: OAuthLoginCallbacks,
  provider?: "google" | "github",
): Promise<OAuthCredentials> {
  const region = "us-east-1";
  const state = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkce();
  const redirectUri = `http://localhost:3128`;

  const authUrl = `https://app.kiro.dev/signin?state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}&redirect_from=kirocli${provider ? `&login_option=${provider}` : ""}`;

  return new Promise<OAuthCredentials>((resolve, reject) => {
    let server: http.Server | undefined;
    const signal = getSignal(callbacks);

    const cleanup = () => {
      if (server) {
        server.close();
        server = undefined;
      }
    };

    if (signal?.aborted) {
      return reject(signal.reason);
    }

    signal?.addEventListener("abort", () => {
      cleanup();
      reject(signal.reason);
    });

    server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
        const allowedPaths = ["/", "/oauth/callback", "/signin/callback"];
        if (!allowedPaths.includes(reqUrl.pathname)) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const stateParam = reqUrl.searchParams.get("state");

        if (stateParam !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h3>Authentication failed: invalid state</h3>");
          cleanup();
          reject(new Error("State mismatch"));
          return;
        }

        const issuerUrl = reqUrl.searchParams.get("issuer_url");
        if (issuerUrl) {
          const idcRegion = reqUrl.searchParams.get("idc_region") || "us-east-1";

          const result = await tryRegisterAndAuthorize(issuerUrl, idcRegion);
          if (!result) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end("<h3>Failed to initiate AWS SSO authorization</h3>");
            cleanup();
            reject(new Error(`Device authorization failed in ${idcRegion}`));
            return;
          }

          res.writeHead(302, {
            Location: result.devAuth.verificationUriComplete,
          });
          res.end();

          cleanup();

          try {
            const idcCreds = await pollDeviceCode(
              callbacks,
              result.clientId,
              result.clientSecret,
              idcRegion,
              result.oidcEndpoint,
              result.devAuth,
              issuerUrl,
            );
            resolve(idcCreds);
          } catch (err) {
            reject(err);
          }
          return;
        }

        const codeParam = reqUrl.searchParams.get("code");

        if (!codeParam) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h3>Authentication failed: missing authorization code</h3>");
          cleanup();
          reject(new Error("Missing authorization code"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Kiro Sign In</title>
            <style>
              body { font-family: -apple-system, sans-serif; text-align: center; padding: 50px; background-color: #f9f9f9; }
              .card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: inline-block; }
              h2 { color: #2ecc71; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>Sign In Successful!</h2>
              <p>You have successfully logged in to Kiro CLI. You can now close this tab.</p>
            </div>
          </body>
          </html>
        `);

        cleanup();

        getProgress(callbacks)?.(`Exchanging auth code for tokens...`);
        const tokenUrl = `https://prod.${region}.auth.desktop.kiro.dev/oauth/token`;
        const loginOption = reqUrl.searchParams.get("login_option");
        const actualRedirectUri = `http://localhost:3128${reqUrl.pathname === "/" ? "" : reqUrl.pathname}${loginOption ? `?login_option=${loginOption}` : ""}`;
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: oidcHeaders(),
          body: JSON.stringify({
            code: codeParam,
            code_verifier: codeVerifier,
            redirect_uri: actualRedirectUri,
          }),
        });

        if (!response.ok) {
          throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as {
          accessToken: string;
          refreshToken?: string;
          expiresIn: number;
          profileArn?: string;
        };

        if (!data.accessToken) {
          throw new Error("Missing accessToken in response");
        }

        const creds = {
          refresh: `${data.refreshToken || ""}|desktop`,
          access: data.accessToken,
          expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
          clientId: "",
          clientSecret: "",
          region,
          authMethod: "desktop" as const,
          profileArn: data.profileArn,
        };

        try {
          const { saveKiroCliCredentials } = await import("./kiro-cli.js");
          saveKiroCliCredentials(creds);
        } catch {
          // Ignore write errors
        }

        getProgress(callbacks)?.("Google/GitHub login successful");
        resolve(creds);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    server.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to start local OAuth server on port 3128: ${err.message}`));
    });

    server.listen(3128, () => {
      getProgress(callbacks)?.(`Please complete login in your browser...`);
      (callbacks as unknown as { onAuth: (info: { url: string; instructions: string }) => void }).onAuth({
        url: authUrl,
        instructions: provider
          ? `Click to sign in via ${provider === "google" ? "Google" : "GitHub"}.`
          : "Click to sign in with your preferred account.",
      });
    });
  });
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
    throw new Error(`kiro-cli login failed: ${formatSafeError(error)}. Ensure kiro-cli is installed and in PATH.`);
  }

  const creds = getKiroCliSocialToken() || getKiroCliCredentials();
  if (!creds) throw new Error("kiro-cli login completed but no credentials found in its database");

  getProgress(callbacks)?.(creds.authMethod === "desktop" ? "Google/GitHub login successful" : "Login successful");
  return creds;
}
