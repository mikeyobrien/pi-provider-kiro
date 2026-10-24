#!/usr/bin/env bash
# Create an isolated pi + Kiro-provider verification sandbox. Prints dir= mode= lines.
# Usage: sandbox.sh --fake [scenario|script.json] [--creds api-key|kiro-cli|kiro-cli-expired]
#        sandbox.sh --live                          # real Kiro, using a COPY of kiro-cli's DB
#   --fake: loopback fake Kiro (default scenario: chat). Credentials (all dummies, never real):
#     api-key (default)  KIRO_API_KEY=verify-fake-key
#     kiro-cli           a dummy kiro-cli DB with an unexpired social token (credential pickup)
#     kiro-cli-expired   same, expired: the provider must refresh via the fake /refreshToken
#
# The sandbox is a fresh run dir with its own HOME, PI_CODING_AGENT_DIR and session dir, so
# nothing the provider resolves via os.homedir() (kiro-cli DB, ~/.pi/agent model cache,
# ~/.pi/logs, ~/.aws/sso/cache) or pi resolves via its agent dir can touch the person's files.
# Live mode refuses when the copied access token is expired or close to it: a refresh would
# rotate the refresh token into the scratch copy only, leaving the person's real store stale.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)" # scripts -> verify-pi-provider-kiro -> skills -> .agents -> repo

usage="usage: sandbox.sh --fake [scenario|script.json] [--creds api-key|kiro-cli|kiro-cli-expired] | --live"
mode=""
scenario="chat"
creds="api-key"
case "${1:-}" in
--fake)
	mode=fake
	shift
	if [ -n "${1:-}" ] && [ "$1" != --creds ]; then
		scenario="$1"
		shift
	fi
	if [ "${1:-}" = --creds ]; then creds="${2:?$usage}"; fi
	case "$creds" in api-key | kiro-cli | kiro-cli-expired) ;; *)
		echo "$usage" >&2
		exit 2
		;;
	esac
	;;
--live) mode=live ;;
*)
	echo "$usage" >&2
	exit 2
	;;
esac
# A relative script path must survive the cd into the run dir.
if [ "$mode" = fake ] && [ -f "$scenario" ]; then scenario="$(cd "$(dirname "$scenario")" && pwd)/$(basename "$scenario")"; fi

# Resolve pi BEFORE HOME is swapped: ~/.local/bin/pi is a mise shim that needs the real HOME.
pi_bin="${PI_BIN:-$(mise which pi 2>/dev/null || command -v pi)}"
[ -x "$pi_bin" ] || {
	echo "sandbox.sh: no pi binary found (set PI_BIN)" >&2
	exit 1
}

# Build when dist is missing or any src file is newer than it.
if [ ! -f "$repo/dist/index.js" ] || [ -n "$(find "$repo/src" -newer "$repo/dist/index.js" -name '*.ts' -print -quit)" ]; then
	(cd "$repo" && npm run build >/dev/null)
fi

root="${KIRO_VERIFY_ROOT:-$HOME/.cache/verify-pi-provider-kiro}"
mkdir -p "$root"
run="$(mktemp -d "$root/$(date +%Y%m%dT%H%M%S)-$mode-XXXX")"
mkdir -p "$run"/{home,agent,work,sessions,evidence,logs}
chmod 700 "$run"
printf '{\n  "quietStartup": true\n}\n' >"$run/agent/settings.json"
printf '%s\n' "$repo" >"$run/repo"

# Fingerprint the person's real stores so doctor/stop can prove they were not touched.
real_db="$HOME/.local/share/kiro-cli/data.sqlite3"
for f in "$real_db" "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/settings.json"; do
	if [ -f "$f" ]; then printf '%s  %s\n' "$(sha256sum <"$f" | cut -d' ' -f1)" "$f"; fi
done >"$run/real-stores.sha256"

env_file="$run/env"
{
	printf 'HOME=%s\n' "$run/home"
	printf 'PI_CODING_AGENT_DIR=%s\n' "$run/agent"
	printf 'PI_CODING_AGENT_SESSION_DIR=%s\n' "$run/sessions"
	printf 'PI_TELEMETRY=0\n'
	printf 'KIRO_DEBUG=1\n'
	printf 'KIRO_DEBUG_LOG=%s\n' "$run/logs/kiro-debug.log"
	printf 'PI_BIN=%s\n' "$pi_bin"
	printf 'KIRO_VERIFY_MODE=%s\n' "$mode"
	printf 'KIRO_VERIFY_RUN=%s\n' "$run"
} >"$env_file"

if [ "$mode" = live ]; then
	[ -f "$real_db" ] || {
		echo "sandbox.sh: no kiro-cli DB at $real_db; live mode needs a kiro-cli login" >&2
		rm -rf "$run"
		exit 3
	}
	mkdir -p "$run/home/.local/share/kiro-cli"
	sqlite3 -readonly "$real_db" ".backup '$run/home/.local/share/kiro-cli/data.sqlite3'"
	chmod 600 "$run/home/.local/share/kiro-cli/data.sqlite3"
	# Same precedence as the provider: social, then IdC, then external IdP. Print expiry only.
	verdict="$(sqlite3 -readonly "$run/home/.local/share/kiro-cli/data.sqlite3" \
		"select key, value from auth_kv where key in ('kirocli:social:token','kirocli:odic:token','codewhisperer:odic:token','kirocli:external-idp:token');" -json |
		node -e '
			const rows = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
			const order = ["kirocli:social:token","kirocli:odic:token","codewhisperer:odic:token","kirocli:external-idp:token"];
			rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
			const row = rows[0];
			if (!row) { console.log("none"); process.exit(0); }
			const v = JSON.parse(row.value);
			const exp = Date.parse(v.expires_at ?? v.expiresAt ?? "");
			const mins = Math.floor((exp - Date.now()) / 60000);
			console.log(`${row.key} ${Number.isFinite(mins) ? mins : "unknown"}`);
		')"
	printf 'token=%s\n' "$verdict" >"$run/live-token"
	key="${verdict% *}"
	mins="${verdict##* }"
	if [ "$verdict" = none ] || [ "$mins" = unknown ] || [ "$mins" -lt 10 ]; then
		rm -rf "$run/home/.local/share/kiro-cli"
		echo "sandbox.sh: live refused: $key access token has ${mins} min left (need >= 10)." >&2
		echo "  A refresh here would rotate the refresh token into the scratch copy only." >&2
		echo "  Ask the person to use Kiro once on their own (pi or kiro-cli) to refresh it, then rerun." >&2
		echo "  Fake mode still works: sandbox.sh --fake" >&2
		echo "dir=$run (refused; nothing to stop)" >&2
		exit 3
	fi
	printf 'mode=live\ndir=%s\ntoken=%s (%s min left)\n' "$run" "$key" "$mins"
	exit 0
fi

# Fake mode: loopback fake Kiro + fetch shim (verify-shim.mjs, loaded by pi.sh).
nohup node "$here/fake-kiro.mjs" 0 "$scenario" "$run/evidence/fake-kiro-requests.jsonl" >"$run/logs/fake-kiro.log" 2>&1 &
fake_pid=$!
echo "$fake_pid" >"$run/fake.pid"
url=""
for _ in $(seq 1 50); do
	url="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$run/logs/fake-kiro.log" 2>/dev/null | head -1 || true)"
	[ -n "$url" ] && break
	kill -0 "$fake_pid" 2>/dev/null || {
		echo "fake-kiro died during boot:" >&2
		cat "$run/logs/fake-kiro.log" >&2
		exit 1
	}
	sleep 0.1
done
[ -n "$url" ] || {
	echo "fake-kiro not ready after 5s" >&2
	exit 1
}
printf 'KIRO_VERIFY_FAKE_URL=%s\n' "$url" >>"$env_file"
if [ "$creds" = api-key ]; then
	# A dummy, not ksk_: the provider resolves a profile via List-Available-Profiles like OAuth.
	printf 'KIRO_API_KEY=verify-fake-key\n' >>"$env_file"
else
	# A dummy kiro-cli DB in the scratch HOME, same schema/key the real kiro-cli writes.
	exp="$(date -u -d "$([ "$creds" = kiro-cli ] && echo '+2 hours' || echo '-1 hour')" +%Y-%m-%dT%H:%M:%SZ)"
	mkdir -p "$run/home/.local/share/kiro-cli"
	sqlite3 "$run/home/.local/share/kiro-cli/data.sqlite3" "create table auth_kv (key text primary key, value text);
		insert into auth_kv values ('kirocli:social:token', json_object(
			'access_token', 'aoaVERIFYDUMMYACCESS0000000000000000000000000000000',
			'refresh_token', 'aorVERIFYDUMMYREFRESH000000000000000000000000000000',
			'expires_at', '$exp', 'provider', 'google',
			'profile_arn', 'arn:aws:codewhisperer:us-east-1:000000000000:profile/VERIFYFAKE'));"
fi
printf 'mode=fake\ndir=%s\nfake=%s pid=%s scenario=%s creds=%s\n' "$run" "$url" "$fake_pid" "$scenario" "$creds"
