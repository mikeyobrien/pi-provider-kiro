#!/usr/bin/env node
// ABOUTME: Prints the provider's debug-log entries of one kind as JSONL: request-side proof in live mode.
// ABOUTME: Live has no fake request log; logs/kiro-debug.log holds every [request.send] body instead.
//
// Usage: node requests.mjs <runDir> [tag]     tag defaults to request.send
//   one line per entry: {"ts":…,"tag":…, …entry}  (pipe to jq)
// The provider never logs auth headers here; stop.sh's scrub still runs over logs/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [run, tag = "request.send"] = process.argv.slice(2);
const log = run && join(run, "logs/kiro-debug.log");
if (!log || !existsSync(log)) {
  console.error("usage: requests.mjs <runDir> [tag]  (needs <runDir>/logs/kiro-debug.log)");
  process.exit(2);
}

const head = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[([^\]]+)\] ?(.*)$/;
let cur = null;
const flush = () => {
  if (!cur || cur.tag !== tag) return;
  let body;
  try {
    body = JSON.parse(cur.lines.join("\n"));
  } catch {
    body = { raw: cur.lines.join("\n") };
  }
  console.log(JSON.stringify({ ts: cur.ts, tag: cur.tag, ...(body && typeof body === "object" ? body : { value: body }) }));
};
for (const line of readFileSync(log, "utf8").split("\n")) {
  const m = head.exec(line);
  if (m) {
    flush();
    cur = { ts: m[1], tag: m[2], lines: [m[3]] };
  } else if (cur) cur.lines.push(line);
}
flush();
