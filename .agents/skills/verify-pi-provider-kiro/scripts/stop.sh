#!/usr/bin/env bash
# Tear down a sandbox.sh run: kill only what it started, scrub secrets, delete scratch creds.
# Usage: stop.sh <runDir>
# Keeps evidence/, logs/, sessions/ and work/ (the proof); deletes home/ (the kiro-cli DB copy)
# and agent/ (scratch pi config + any auth.json). Never kills by name.
set -euo pipefail
run="${1:?usage: stop.sh <runDir>}"
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$run/env" ] || {
	echo "stop.sh: $run is not a sandbox (no env file)" >&2
	exit 1
}

# The fake Kiro server, if this run started one. Check the PID is still ours before killing.
if [ -f "$run/fake.pid" ]; then
	pid="$(cat "$run/fake.pid")"
	if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'fake-kiro.mjs'; then
		kill "$pid"
		for _ in $(seq 1 30); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.1
		done
		kill -0 "$pid" 2>/dev/null && kill -9 "$pid" || true
		echo "stopped fake-kiro pid $pid"
	else
		echo "fake-kiro pid $pid already gone"
	fi
fi

# tmux sessions (private socket -L kiro-verify) a TUI drive recorded in <runDir>/tmux-sessions (one name per line).
if [ -f "$run/tmux-sessions" ]; then
	while IFS= read -r s; do
		[ -n "$s" ] && tmux -L kiro-verify kill-session -t "=$s" 2>/dev/null && echo "killed tmux session $s" || true
	done <"$run/tmux-sessions"
fi

node "$here/scrub.mjs" "$run"

# Prove the person's real stores were not modified by this run.
if [ -s "$run/real-stores.sha256" ]; then
	if "$here/stores.sh" check "$run" >"$run/evidence/real-stores-check.txt"; then
		echo "real stores unchanged:" | cat - "$run/evidence/real-stores-check.txt" >"$run/evidence/real-stores-check.tmp"
	else
		echo "WARNING: a real store changed during the run (may be the person's own pi/kiro-cli use):" | cat - "$run/evidence/real-stores-check.txt" >"$run/evidence/real-stores-check.tmp"
	fi
	mv "$run/evidence/real-stores-check.tmp" "$run/evidence/real-stores-check.txt"
	cat "$run/evidence/real-stores-check.txt"
fi

rm -rf "$run/home" "$run/agent"
echo "evidence: $run/evidence"
