// ABOUTME: pi extension loaded by pi.sh before dist/index.js in every sandbox run.
// ABOUTME: Fake mode: reroutes Kiro/AWS fetches to the loopback fake. Live mode: blocks token refresh.
//
// The provider calls the global `fetch` at request time, so patching it here (same process,
// loaded first) controls runtime, management and token-refresh traffic.
// - fake: every *.kiro.dev / *.amazonaws.com request goes to KIRO_VERIFY_FAKE_URL (loopback
//   only); the original host travels in `x-verify-original-host` so the fake's log shows it.
// - live: requests pass through, EXCEPT token refresh (desktop auth, SSO OIDC /token, and
//   an external IdP's token endpoint): a refresh would rotate the refresh token into the
//   sandbox's copy only and leave the person's real store stale. Blocked calls are logged
//   to <run>/evidence/blocked-refresh.log and fail like a network error.

import { appendFileSync } from "node:fs";

const mode = process.env.KIRO_VERIFY_MODE;
const target = process.env.KIRO_VERIFY_FAKE_URL;
const runDir = process.env.KIRO_VERIFY_RUN;
const KIRO_HOST = /(^|\.)kiro\.dev$|(^|\.)amazonaws\.com$/;
const REFRESH = (url) =>
  /^prod\.[a-z0-9-]+\.auth\.desktop\.kiro\.dev$/.test(url.hostname) ||
  (/^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname === "/token") ||
  /\/(oauth2\/)?(v1\/)?token$/.test(url.pathname);

if (mode === "fake" && (!target || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(target))) {
  throw new Error("verify-shim: KIRO_VERIFY_FAKE_URL must be http://127.0.0.1:<port>; refusing to load");
}
if (mode !== "fake" && mode !== "live") {
  throw new Error("verify-shim: KIRO_VERIFY_MODE must be fake or live; load it only via pi.sh");
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function verifyFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (mode === "live") {
    if (REFRESH(url)) {
      if (runDir) appendFileSync(`${runDir}/evidence/blocked-refresh.log`, `${new Date().toISOString()} ${url.hostname}${url.pathname}\n`);
      throw new TypeError(`verify sandbox blocked token refresh to ${url.hostname} (live mode never refreshes)`);
    }
    return realFetch(input, init);
  }
  if (!KIRO_HOST.test(url.hostname)) return realFetch(input, init);
  const rerouted = new URL(url.pathname + url.search, target);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-verify-original-host", url.hostname);
  if (input instanceof Request && !init) {
    return realFetch(new Request(rerouted, input), { headers });
  }
  return realFetch(rerouted, { ...init, headers });
};

export default function verifyShim() {}
