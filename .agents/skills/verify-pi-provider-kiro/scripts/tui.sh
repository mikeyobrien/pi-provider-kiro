#!/usr/bin/env bash
# Drive the sandboxed pi TUI through tmux on a PRIVATE socket (-L kiro-verify), never the
# person's tmux server. One session per run dir: kv-<runDir basename>.
# Usage:
#   tui.sh <runDir> start [pi args...]     # e.g. start --model kiro/claude-sonnet-4-6
#   tui.sh <runDir> wait <regex> [secs]    # poll the screen until regex matches (default 20 s)
#   tui.sh <runDir> type <text>            # literal text, no Enter
#   tui.sh <runDir> send <text>            # literal text + Enter
#   tui.sh <runDir> keys <tmux-key>...     # Enter, Down, Escape, C-c ...
#   tui.sh <runDir> capture [name]         # screen -> <runDir>/evidence/tui-<name>.txt (and stdout)
#   tui.sh <runDir> stop                   # kill this run's session
set -euo pipefail
run="${1:?usage: tui.sh <runDir> <start|wait|type|send|keys|capture|stop> ...}"
cmd="${2:?usage: tui.sh <runDir> <start|wait|type|send|keys|capture|stop> ...}"
shift 2
here="$(cd "$(dirname "$0")" && pwd)"
session="kv-$(basename "$run")"
tm() { tmux -L kiro-verify "$@"; }

case "$cmd" in
start)
	tm has-session -t "=$session" 2>/dev/null && {
		echo "tui.sh: session $session already running" >&2
		exit 1
	}
	printf '%s\n' "$session" >>"$run/tmux-sessions"
	args=""
	for a in "$@"; do args+=" $(printf '%q' "$a")"; done
	# The trailing sleep keeps the pane (and pi's exit status) readable after pi quits.
	tm new-session -d -s "$session" -x 160 -y 45 \
		"$(printf '%q' "$here/pi.sh") $(printf '%q' "$run")$args; echo PI-EXITED \$?; sleep 3600"
	echo "session=$session socket=kiro-verify"
	;;
wait)
	re="${1:?usage: tui.sh <runDir> wait <regex> [secs]}"
	secs="${2:-20}"
	for _ in $(seq 1 $((secs * 4))); do
		if tm capture-pane -p -t "$session:" | grep -Eq -- "$re"; then exit 0; fi
		sleep 0.25
	done
	echo "tui.sh: /$re/ not on screen after ${secs}s; screen follows" >&2
	tm capture-pane -p -t "$session:" | grep -v '^\s*$' >&2
	exit 1
	;;
type) tm send-keys -t "$session:" -l -- "$*" ;;
send)
	tm send-keys -t "$session:" -l -- "$*"
	tm send-keys -t "$session:" Enter
	;;
keys) tm send-keys -t "$session:" "$@" ;;
capture)
	name="${1:-$(date +%H%M%S)}"
	tm capture-pane -p -t "$session:" | tee "$run/evidence/tui-$name.txt"
	;;
stop) tm kill-session -t "=$session" 2>/dev/null && echo "killed $session" || echo "$session not running" ;;
*)
	echo "tui.sh: unknown command $cmd" >&2
	exit 2
	;;
esac
