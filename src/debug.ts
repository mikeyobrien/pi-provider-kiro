// ABOUTME: Debug logging — dumps requests, responses, stream events, and errors
// ABOUTME: to a log file when KIRO_DEBUG=1. Custom path via KIRO_DEBUG_LOG.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENABLED = !!process.env.KIRO_DEBUG && process.env.KIRO_DEBUG !== "0";
const LOG_FILE = process.env.KIRO_DEBUG_LOG || join(homedir(), ".pi", "logs", "kiro-debug.log");

let dirReady = false;

export function debugEnabled(): boolean {
  return ENABLED;
}

export function debugLog(section: string, data?: unknown): void {
  if (!ENABLED) return;
  try {
    if (!dirReady) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      dirReady = true;
    }
    const ts = new Date().toISOString();
    const body =
      data === undefined
        ? ""
        : typeof data === "string"
          ? ` ${redactSensitiveText(data)}`
          : ` ${JSON.stringify(data, redact, 2)}`;
    appendFileSync(LOG_FILE, `${ts} [${section}]${body}\n`);
  } catch {
    // best-effort; never break the provider
  }
}

const PROFILE_ARN_PATTERN = /arn:[a-z0-9-]+:codewhisperer:[^:\s"']*:[^:\s"']*:profile\/[^\s"',}\]]+/gi;
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)[^\s"',}\]]+/gi;
const QUOTED_SECRET_PATTERN =
  /(["'](?:access|refresh|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']\s*:\s*["'])[^"']*(["'])/gi;
const ASSIGNED_SECRET_PATTERN = /(\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*=\s*)[^\s,;&]+/gi;

/** Remove credentials and profile identities from text before exposing it in logs or errors. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(QUOTED_SECRET_PATTERN, "$1<redacted>$2")
    .replace(ASSIGNED_SECRET_PATTERN, "$1<redacted>")
    .replace(BEARER_TOKEN_PATTERN, "$1<redacted>")
    .replace(PROFILE_ARN_PATTERN, "<redacted-profile-arn>");
}

/** Return a safe message for an unknown caught value. */
export function formatSafeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

/** Redact auth tokens and profile identities in structured debug output. */
function redact(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (
    normalizedKey === "authorization" ||
    normalizedKey === "access" ||
    normalizedKey === "refresh" ||
    normalizedKey === "profilearn" ||
    normalizedKey.includes("token") ||
    normalizedKey.includes("secret")
  ) {
    return normalizedKey === "profilearn" ? "<redacted-profile-arn>" : "<redacted>";
  }
  return redactSensitiveText(value);
}
