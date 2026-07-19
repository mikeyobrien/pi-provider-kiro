// ABOUTME: Reads and writes credentials from the kiro-cli SQLite database.
// ABOUTME: Provides fallback auth and write-back to keep kiro-cli in sync after refresh.

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { formatSafeError } from "./debug.js";
import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";

const require = createRequire(import.meta.url);

export function getKiroCliDbPath(): string | undefined {
  const p = platform();
  let dbPath: string;
  if (p === "win32")
    dbPath = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  else if (p === "darwin") dbPath = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  else dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function getNodeSqlite(): typeof import("node:sqlite") | undefined {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return undefined;
  }
}

function queryKiroCliDb(dbPath: string, sql: string): string | undefined {
  const sqlite = getNodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(sql).all() as unknown[];
        const result = JSON.stringify(rows);
        return result === "[]" ? undefined : result;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to sqlite3 CLI fallback
    }
  }

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

function execKiroCliDb(dbPath: string, sql: string): boolean {
  const sqlite = getNodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      try {
        db.exec(sql);
        return true;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to sqlite3 CLI fallback
    }
  }

  try {
    execSync(`sqlite3 "${dbPath}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function getKiroCliCredentials(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    // Try IDC token first (preferred — has clientId/clientSecret for refresh)
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc");
    if (idcCreds) return idcCreds;

    // Fall back to desktop/social token
    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
    if (desktopCreds) return desktopCreds;

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Like getKiroCliCredentials but returns credentials even when the access token
 * is expired, as long as a refresh token exists. Used to attempt a token refresh
 * before falling back to the full device code login flow.
 */
export function getKiroCliCredentialsAllowExpired(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc", true);
    if (idcCreds) return idcCreds;

    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop", true);
    if (desktopCreds) return desktopCreds;

    return undefined;
  } catch {
    return undefined;
  }
}

function tryKiroCliToken(
  dbPath: string,
  tokenKey: string,
  authMethod: KiroAuthMethod,
  allowExpired = false,
): KiroCredentials | undefined {
  const tokenResult = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${tokenKey}'`);
  if (!tokenResult) return undefined;
  const rows = JSON.parse(tokenResult) as Array<{ value: string }>;
  if (!rows[0]?.value) return undefined;
  const tokenData = JSON.parse(rows[0].value);
  if (!tokenData.access_token || !tokenData.refresh_token) return undefined;
  let expiresAt = Date.now() + 3600000;
  if (tokenData.expires_at) expiresAt = new Date(tokenData.expires_at).getTime();
  if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;
  const region = tokenData.region || "us-east-1";

  if (authMethod === "desktop") {
    return {
      refresh: `${tokenData.refresh_token}|desktop`,
      access: tokenData.access_token,
      expires: expiresAt,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: tokenData.profile_arn || tokenData.profileArn,
    };
  }

  // IDC — need device registration credentials for refresh
  let clientId = "";
  let clientSecret = "";
  // Match the device-registration key to the same prefix as the token key
  const keyPrefix = tokenKey.split(":")[0]; // "kirocli" or "codewhisperer"
  const deviceResult = queryKiroCliDb(
    dbPath,
    `SELECT value FROM auth_kv WHERE key = '${keyPrefix}:odic:device-registration'`,
  );
  if (deviceResult) {
    try {
      const d = JSON.parse(JSON.parse(deviceResult)[0]?.value);
      clientId = d.client_id || d.clientId || "";
      clientSecret = d.client_secret || d.clientSecret || "";
    } catch {}
  }
  return {
    refresh: `${tokenData.refresh_token}|${clientId}|${clientSecret}|idc`,
    access: tokenData.access_token,
    expires: expiresAt,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
  };
}

// Re-export the internal function for use by getKiroCliSocialToken
export { tryKiroCliToken };

/**
 * Get the social token (Google/GitHub) from kiro-cli if available.
 * Returns undefined if no valid social token exists.
 * This is used to prefer social login when the user has logged in that way.
 */
export function getKiroCliSocialToken(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    return tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
  } catch {
    return undefined;
  }
}

/**
 * Like getKiroCliSocialToken but returns credentials even when the access token
 * is expired, as long as a refresh token exists.
 */
export function getKiroCliSocialTokenAllowExpired(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    return tryKiroCliToken(dbPath, "kirocli:social:token", "desktop", true);
  } catch {
    return undefined;
  }
}

const TOKEN_KEY_BY_AUTH_METHOD: Record<KiroAuthMethod, string[]> = {
  idc: ["kirocli:odic:token", "codewhisperer:odic:token"],
  desktop: ["kirocli:social:token"],
};

export function saveKiroCliCredentials(creds: KiroCredentials): void {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return;

  const rawRefreshToken = creds.refresh.split("|")[0] ?? "";
  // Our expires has a 5-min buffer subtracted; restore approximate actual expiry for kiro-cli
  const expiresAt = new Date(creds.expires + 5 * 60 * 1000).toISOString();
  const tokenKeys = TOKEN_KEY_BY_AUTH_METHOD[creds.authMethod] ?? [];

  for (const key of tokenKeys) {
    const existing = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${key}'`);
    if (!existing) continue;

    try {
      const rows = JSON.parse(existing) as Array<{ value: string }>;
      if (!rows[0]?.value) continue;
      const tokenData = JSON.parse(rows[0].value);

      tokenData.access_token = creds.access;
      tokenData.refresh_token = rawRefreshToken;
      tokenData.expires_at = expiresAt;
      if (creds.region) tokenData.region = creds.region;
      if (creds.profileArn) tokenData.profile_arn = creds.profileArn;

      const escaped = JSON.stringify(tokenData).replace(/'/g, "''");
      const sql = `UPDATE auth_kv SET value = '${escaped}' WHERE key = '${key}';`;
      if (execKiroCliDb(dbPath, sql)) return;
    } catch {}
  }
}

/**
 * Ask kiro-cli to refresh its own tokens via `kiro-cli debug refresh-auth-token`,
 * then re-read the SQLite DB for fresh credentials.
 *
 * Returns refreshed credentials on success, or undefined if kiro-cli is not
 * installed, the command fails, or the DB still has no valid tokens afterward.
 */
export function refreshViaKiroCli(): KiroCredentials | undefined {
  try {
    execFileSync("kiro-cli", ["debug", "refresh-auth-token"], {
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return getKiroCliCredentials();
  } catch (error) {
    console.warn(`[pi-provider-kiro] kiro-cli refresh failed: ${formatSafeError(error)}`);
    return undefined;
  }
}
