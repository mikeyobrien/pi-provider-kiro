#!/usr/bin/env bash
# Run the real pi binary inside a sandbox made by sandbox.sh, loading ONLY this worktree's dist.
# Usage: pi.sh <runDir> [pi args...]
#   pi.sh "$RUN" --list-models kiro
#   pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "Say hello"
#   pi.sh "$RUN"                      # interactive TUI (run it inside tmux; see SKILL.md)
# The environment is rebuilt from scratch (env -i): only PATH (with bin/ prepended)/TERM/LANG pass through, plus the
# sandbox's own env file. No discovered extensions, skills, themes, prompt templates, MCP or
# context files, no project trust (--no-approve); cwd is <runDir>/work, so the repo's own AGENTS.md is not in the prompt.
# stdin is closed when it is not a TTY (pi -p would wait for EOF); PI_SH_KEEP_STDIN=1 keeps it.
set -euo pipefail
run="${1:?usage: pi.sh <runDir> [pi args...]}"
shift
[ -f "$run/env" ] || {
	echo "pi.sh: $run is not a sandbox (no env file)" >&2
	exit 1
}
repo="$(cat "$run/repo")"
here="$(cd "$(dirname "$0")" && pwd)"

envs=()
while IFS= read -r line; do [ -n "$line" ] && envs+=("$line"); done <"$run/env"
pi_bin="$(sed -n 's/^PI_BIN=//p' "$run/env")"
mode="$(sed -n 's/^KIRO_VERIFY_MODE=//p' "$run/env")"

# verify-shim first: fake mode reroutes Kiro hosts to the fake, live mode blocks token refresh.
ext=(-e "$here/verify-shim.mjs" -e "$repo/dist/index.js")

# pi -p waits for stdin EOF when stdin is not a TTY (an agent's shell usually is not), which
# hangs a drive forever. Close it unless the caller pipes a prompt in on purpose.
stdin=/dev/stdin
if [ ! -t 0 ] && [ -z "${PI_SH_KEEP_STDIN:-}" ]; then stdin=/dev/null; fi

cd "$run/work"
# bin/ first on PATH: a kiro-cli stub that logs and refuses (the provider shells out to
# `kiro-cli debug refresh-auth-token` on a 403; the real one would refresh outside our control).
exec <"$stdin" env -i PATH="$here/bin:$PATH" TERM="${TERM:-xterm-256color}" LANG="${LANG:-C.UTF-8}" "${envs[@]}" \
	"$pi_bin" --no-extensions "${ext[@]}" --no-skills --no-prompt-templates --no-themes --no-mcp --no-context-files --no-approve "$@"
