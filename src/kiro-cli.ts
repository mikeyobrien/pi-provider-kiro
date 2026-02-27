// ABOUTME: Reads and writes credentials from the kiro-cli SQLite database.
// ABOUTME: Provides fallback auth and write-back to keep kiro-cli in sync after refresh.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";

export function getKiroCliDbPath(): string | undefined {
  const p = platform();
  let dbPath: string;
  if (p === "win32")
    dbPath = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  else if (p === "darwin") dbPath = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  else dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function queryKiroCliDb(dbPath: string, sql: string): string | undefined {
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

function tryKiroCliToken(dbPath: string, tokenKey: string, authMethod: KiroAuthMethod): KiroCredentials | undefined {
  const tokenResult = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${tokenKey}'`);
  if (!tokenResult) return undefined;
  const rows = JSON.parse(tokenResult) as Array<{ value: string }>;
  if (!rows[0]?.value) return undefined;
  const tokenData = JSON.parse(rows[0].value);
  if (!tokenData.access_token || !tokenData.refresh_token) return undefined;
  let expiresAt = Date.now() + 3600000;
  if (tokenData.expires_at) expiresAt = new Date(tokenData.expires_at).getTime();
  if (Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;
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
    };
  }

  // IDC — need device registration credentials for refresh
  let clientId = "";
  let clientSecret = "";
  const deviceResult = queryKiroCliDb(
    dbPath,
    "SELECT value FROM auth_kv WHERE key LIKE '%device-registration%' LIMIT 1",
  );
  if (deviceResult) {
    try {
      const d = JSON.parse(JSON.parse(deviceResult)[0]?.value);
      clientId = d.clientId || "";
      clientSecret = d.clientSecret || "";
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

      const escaped = JSON.stringify(tokenData).replace(/'/g, "''");
      const sql = `UPDATE auth_kv SET value = '${escaped}' WHERE key = '${key}';`;
      if (execKiroCliDb(dbPath, sql)) return;
    } catch {
      continue;
    }
  }
}
