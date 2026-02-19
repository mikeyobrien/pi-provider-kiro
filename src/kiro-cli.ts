// Feature 4: kiro-cli Credential Fallback

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
