#!/usr/bin/env node
// ABOUTME: Redacts credentials from a verification run's evidence, logs, sessions and work dirs.
// ABOUTME: Exact values come from the sandbox's own credential copies; patterns catch the rest.
//
// Usage: node scrub.mjs <runDir>        (stop.sh runs it before deleting the scratch HOME)
// Prints only counts and file names, never a matched value. Exit 1 if a known secret survives.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = process.argv[2];
if (!run || !existsSync(join(run, "env"))) {
  console.error("usage: scrub.mjs <runDir>  (a sandbox.sh run dir)");
  process.exit(2);
}

const SECRET_FIELDS =
  /^(access_?token|refresh_?token|client_?secret|accessToken|refreshToken|clientSecret|access|refresh|key|id_?token)$/i;
const secrets = new Set();

function collect(value) {
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && SECRET_FIELDS.test(k) && v.length >= 12) {
      secrets.add(v);
      // Stored refresh strings are `token|clientId|...|method`; scrub the token part alone too.
      const head = v.split("|")[0];
      if (head.length >= 12) secrets.add(head);
    } else if (typeof v === "string" && v.trim().startsWith("{")) {
      try {
        collect(JSON.parse(v));
      } catch {}
    } else collect(v);
  }
}

const db = join(run, "home/.local/share/kiro-cli/data.sqlite3");
if (existsSync(db)) {
  try {
    const rows = JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, "select value from auth_kv;"], { encoding: "utf-8" }) || "[]");
    for (const row of rows) collect(row);
  } catch {
    console.error("scrub: could not read the sandbox kiro-cli DB; pattern scrub only");
  }
}
for (const f of ["agent/auth.json"]) {
  const p = join(run, f);
  if (existsSync(p)) {
    try {
      collect(JSON.parse(readFileSync(p, "utf-8")));
    } catch {}
  }
}
for (const line of readFileSync(join(run, "env"), "utf-8").split("\n")) {
  const m = /^KIRO_API_KEY=(.+)$/.exec(line);
  if (m && m[1] !== "verify-fake-key") secrets.add(m[1]);
}

const PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]"],
  [/\baor[A-Za-z0-9_-]{40,}[A-Za-z0-9:_=-]*/g, "[REDACTED-refresh]"],
  [/\baoa[A-Za-z0-9_-]{40,}[A-Za-z0-9:_=-]*/g, "[REDACTED-access]"],
  [/\bksk_[A-Za-z0-9_-]{16,}/g, "[REDACTED-api-key]"],
  [/("(?:access_?token|refresh_?token|client_?secret|accessToken|refreshToken|clientSecret)"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"'],
];

const dirs = ["evidence", "logs", "sessions", "work"].map((d) => join(run, d)).filter(existsSync);
let changed = 0;
const leaks = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && st.size < 50 * 1024 * 1024) scrubFile(p);
  }
}

function scrubFile(p) {
  const before = readFileSync(p, "utf-8");
  let after = before;
  for (const s of secrets) after = after.split(s).join("[REDACTED]");
  for (const [re, rep] of PATTERNS) after = after.replace(re, rep);
  if (after !== before) {
    writeFileSync(p, after);
    changed++;
    console.log(`scrubbed ${p.slice(run.length + 1)}`);
  }
  for (const s of secrets) if (after.includes(s)) leaks.push(p);
}

for (const d of dirs) walk(d);
console.log(`scrub: ${secrets.size} known secret value(s), ${changed} file(s) rewritten`);
if (leaks.length) {
  console.error(`scrub: a known secret survives in: ${[...new Set(leaks)].join(", ")}`);
  process.exit(1);
}
