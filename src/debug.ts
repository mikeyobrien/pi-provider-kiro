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
      data === undefined ? "" : typeof data === "string" ? ` ${data}` : ` ${JSON.stringify(data, redact, 2)}`;
    appendFileSync(LOG_FILE, `${ts} [${section}]${body}\n`);
  } catch {
    // best-effort; never break the provider
  }
}

/** Redact auth tokens in JSON output. */
function redact(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const k = key.toLowerCase();
  if (k === "authorization" || k === "access" || k === "refresh" || k.includes("token") || k.includes("secret")) {
    return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}(${value.length})` : "<redacted>";
  }
  return value;
}
