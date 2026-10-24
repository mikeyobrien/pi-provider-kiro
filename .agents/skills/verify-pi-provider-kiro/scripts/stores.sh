#!/usr/bin/env bash
# Fingerprint the person's real credential stores, and later prove they were not touched.
# Usage: stores.sh snapshot <runDir>   # sandbox.sh: writes <runDir>/real-stores.sha256
#        stores.sh check <runDir>      # doctor.sh/stop.sh: one OK/CHANGED line per store; exit 1 on CHANGED
# The kiro-cli DB is fingerprinted by its auth_kv rows (the credentials), not the whole file:
# a running `kiro-cli chat` writes its own state/history tables all the time, which would
# turn a whole-file hash into a false alarm. A whole-file change is reported as a note.
# Read-only throughout; prints hashes and paths, never a value.
set -euo pipefail
cmd="${1:?usage: stores.sh snapshot|check <runDir>}"
run="${2:?usage: stores.sh snapshot|check <runDir>}"
db="$HOME/.local/share/kiro-cli/data.sqlite3"
stores=("$db#auth_kv" "$db" "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/settings.json")

fp() {
	case "$1" in
	*#auth_kv)
		[ -f "${1%#auth_kv}" ] || return 1
		sqlite3 -readonly -cmd '.timeout 3000' "${1%#auth_kv}" 'select key, value from auth_kv order by key;' | sha256sum | cut -d' ' -f1
		;;
	*)
		[ -f "$1" ] || return 1
		sha256sum <"$1" | cut -d' ' -f1
		;;
	esac
}

case "$cmd" in
snapshot)
	for s in "${stores[@]}"; do
		if h="$(fp "$s")"; then printf '%s  %s\n' "$h" "$s"; fi
	done >"$run/real-stores.sha256"
	;;
check)
	[ -s "$run/real-stores.sha256" ] || {
		echo "no real-stores.sha256 in $run"
		exit 1
	}
	changed=0
	while read -r want s; do
		now="$(fp "$s" || echo missing)"
		if [ "$s" = "$db" ]; then
			# Whole-file DB hash: informational only (the auth_kv line is the gate).
			[ "$now" = "$want" ] || echo "NOTE $s: file changed, outside auth_kv (the person's kiro-cli writes its own tables while it runs)"
		elif [ "$now" = "$want" ]; then
			echo "OK $s"
		else
			echo "CHANGED $s"
			changed=1
		fi
	done <"$run/real-stores.sha256"
	exit "$changed"
	;;
*)
	echo "usage: stores.sh snapshot|check <runDir>" >&2
	exit 2
	;;
esac
