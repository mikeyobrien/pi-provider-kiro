#!/usr/bin/env bash
# Read-only health check of a sandbox.sh run: "is this instance worth driving?"
# Usage: doctor.sh <runDir>      exit 0 = all PASS; prints one PASS/FAIL line per check.
# Never prints a token: credential checks report key name and minutes-to-expiry only.
set -uo pipefail
run="${1:?usage: doctor.sh <runDir>}"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
pass() { echo "PASS $*"; }
bad() {
	echo "FAIL $*"
	fail=1
}

[ -f "$run/env" ] || {
	bad "not a sandbox run dir: $run"
	exit 1
}
[ -d "$run/home" ] || {
	bad "run was already stopped (no scratch home); make a new sandbox"
	exit 1
}
repo="$(cat "$run/repo")"
mode="$(sed -n 's/^KIRO_VERIFY_MODE=//p' "$run/env")"
pi_bin="$(sed -n 's/^PI_BIN=//p' "$run/env")"
pass "mode=$mode dir=$run"

# 1. This worktree's build is current.
if [ -f "$repo/dist/index.js" ] && [ -z "$(find "$repo/src" -newer "$repo/dist/index.js" -name '*.ts' -print -quit)" ]; then
	pass "dist current: $repo/dist/index.js ($(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet -- src || echo '+dirty'))"
else
	bad "dist missing or older than src: run (cd $repo && npm run build)"
fi

# 2. pi binary.
v="$("$pi_bin" --version 2>/dev/null)" && pass "pi $v at $pi_bin" || bad "pi not runnable at $pi_bin"

# 3. Isolation: scratch HOME/agent dir, and the person's stores unchanged since sandbox start.
grep -q "^HOME=$run/home$" "$run/env" && grep -q "^PI_CODING_AGENT_DIR=$run/agent$" "$run/env" &&
	pass "isolated HOME and PI_CODING_AGENT_DIR under run dir" || bad "env file does not isolate HOME/agent dir"
if [ -s "$run/real-stores.sha256" ]; then
	sha256sum --quiet -c <(awk '{print $1"  "$2}' "$run/real-stores.sha256") >/dev/null 2>&1 &&
		pass "person's real stores unchanged" || bad "a real store changed since sandbox start (see stop.sh output)"
fi

# 4. Credentials / backend.
if [ "$mode" = fake ]; then
	url="$(sed -n 's/^KIRO_VERIFY_FAKE_URL=//p' "$run/env")"
	pid="$(cat "$run/fake.pid" 2>/dev/null)"
	health="$(curl -sf "$url/__verify/health")" || health=""
	if [ -n "$health" ] && [ "$(printf '%s' "$health" | jq -r .pid)" = "$pid" ]; then
		pass "fake Kiro up at $url (our pid $pid, scenario $(printf '%s' "$health" | jq -r .scenario))"
	else
		bad "fake Kiro at $url not answering as pid $pid"
	fi
else
	db="$run/home/.local/share/kiro-cli/data.sqlite3"
	if [ -f "$db" ]; then
		left="$(sqlite3 -readonly -json "$db" "select key, value from auth_kv where key in ('kirocli:social:token','kirocli:odic:token','codewhisperer:odic:token','kirocli:external-idp:token');" |
			node -e '
				const rows = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
				const order = ["kirocli:social:token","kirocli:odic:token","codewhisperer:odic:token","kirocli:external-idp:token"];
				rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
				if (!rows[0]) { console.log("none -1"); process.exit(0); }
				const v = JSON.parse(rows[0].value);
				console.log(rows[0].key, Math.floor((Date.parse(v.expires_at ?? v.expiresAt ?? "") - Date.now()) / 60000));
			')"
		mins="${left##* }"
		if [ "$mins" -ge 5 ] 2>/dev/null; then pass "live token ${left% *}: $mins min left"; else bad "live token ${left% *}: $mins min left; stop and ask the person to refresh"; fi
	else
		bad "no scratch kiro-cli DB copy (sandbox refused or stopped)"
	fi
fi

# 5. pi loads the provider from this worktree and lists Kiro models.
models="$(timeout 60 "$here/pi.sh" "$run" --list-models kiro 2>&1)"
if printf '%s\n' "$models" | grep -q '^kiro  *claude-'; then
	pass "pi lists $(printf '%s\n' "$models" | grep -c '^kiro ') kiro models"
else
	hint=""
	[ -f "$run/home/.local/share/kiro-cli/data.sqlite3" ] && ! jq -e .kiro "$run/agent/auth.json" >/dev/null 2>&1 && hint=" (kiro-cli creds need scripts/login-cached.sh first)"
	bad "pi --list-models kiro shows no kiro models$hint: $(printf '%s' "$models" | head -1)"
fi

# 6. Fake mode: the shim really rerouted management traffic (no fake call escaped to the internet).
if [ "$mode" = fake ]; then
	if grep -q '"originalHost":"management\.[a-z0-9-]*\.kiro\.dev"' "$run/evidence/fake-kiro-requests.jsonl" 2>/dev/null; then
		pass "shim rerouted management.*.kiro.dev to the fake"
	else
		bad "no rerouted management call in fake log; the shim may not be loaded"
	fi
fi

exit "$fail"
