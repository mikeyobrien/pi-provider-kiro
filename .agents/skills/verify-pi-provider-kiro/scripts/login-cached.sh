#!/usr/bin/env bash
# Log the sandbox's pi in to Kiro from the kiro-cli DB in the scratch HOME, through the real
# TUI path: /login kiro -> "Sign in with an account" -> "Use existing credentials".
# No browser, no device code, no OAuth: only the cached-credential branch is ever selected.
# Usage: login-cached.sh <runDir>     (needed for --live and --fake --creds kiro-cli*)
# Proof lands in <runDir>/evidence/tui-login-*.txt; the credential lands in <runDir>/agent/auth.json.
set -euo pipefail
run="${1:?usage: login-cached.sh <runDir>}"
here="$(cd "$(dirname "$0")" && pwd)"
tui="$here/tui.sh"

[ -f "$run/home/.local/share/kiro-cli/data.sqlite3" ] || {
	echo "login-cached.sh: no kiro-cli DB in the sandbox HOME (api-key sandboxes need no login)" >&2
	exit 1
}
"$tui" "$run" start >/dev/null
trap '"$tui" "$run" stop >/dev/null' EXIT
"$tui" "$run" wait '/work' 30
"$tui" "$run" type "/login kiro"
"$tui" "$run" keys Enter # first Enter accepts the autocomplete, second submits
sleep 0.5
"$tui" "$run" keys Enter
"$tui" "$run" wait 'Select authentication method for Kiro' 20
"$tui" "$run" capture login-1-method >/dev/null
"$tui" "$run" keys Enter # "Sign in with an account"
"$tui" "$run" wait 'Use existing credentials' 20
"$tui" "$run" capture login-2-options >/dev/null
# Refuse to press Enter unless the cursor is on the cached-credential row.
if ! "$tui" "$run" capture login-2-options | grep -q '→ Use existing credentials'; then
	echo "login-cached.sh: cursor is not on 'Use existing credentials'; not selecting anything" >&2
	exit 1
fi
"$tui" "$run" keys Enter
if "$tui" "$run" wait 'Logged in to Kiro|Login failed|rror' 30; then
	"$tui" "$run" capture login-3-result | grep -E 'Logged in|failed|rror' | sed 's/^ *//' || true
fi
jq -e '.kiro.access | length > 0' "$run/agent/auth.json" >/dev/null 2>&1 && {
	echo "login-cached: kiro credential saved to $run/agent/auth.json (authMethod $(jq -r .kiro.authMethod "$run/agent/auth.json"))"
	exit 0
}
echo "login-cached.sh: no kiro credential in $run/agent/auth.json; see evidence/tui-login-3-result.txt" >&2
exit 1
