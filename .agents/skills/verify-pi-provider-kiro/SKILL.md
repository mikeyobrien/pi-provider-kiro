---
name: verify-pi-provider-kiro
description: "Drive the real pi CLI/TUI with this worktree's pi-provider-kiro build the way a user does: isolated sandbox, a streamed chat, a tool round trip, the model picker, /login credential pickup, error/retry handling, captured as evidence. Live against the Kiro API when a fresh kiro-cli token exists, else against a loopback fake Kiro (weaker). Use for any PR verdict or behaviour claim beyond the mocked vitest suite, after changing src/, or before saying a provider change works."
---

# Verify pi-provider-kiro

Proves behaviour on the **real pi binary** (`pi` 1.4.0, an ELF installed by mise) loading **this worktree's `dist/index.js`** as an extension, in a sandbox that cannot touch the person's `~/.pi/agent`, `~/.local/share/kiro-cli/data.sqlite3` or tmux server. The production boundary is the Kiro HTTP API (`runtime.<region>.kiro.dev/generateAssistantResponse`, `management.<region>.kiro.dev/*`, `prod.<region>.auth.desktop.kiro.dev/refreshToken`).

Two modes:

| Mode | Backend | Proves | Needs |
| --- | --- | --- | --- |
| `--live` | the real Kiro API | everything, including what Kiro actually accepts | a kiro-cli token with ≥ 10 min left |
| `--fake` | `scripts/fake-kiro.mjs` on 127.0.0.1, real AWS event-stream framing | pi + the provider: request shaping, stream decoding, thinking, tools, retries, refresh write-back | nothing |

**Fake mode is weaker than live.** It proves the provider against the wire contract the fake encodes, not against what Kiro itself accepts or answers. State the mode in every verdict. Keep live calls minimal: one short prompt per proof.

## Launch

pi here is a short-lived CLI/TUI, not a server. Launch = make one sandbox; every drive is then its own `pi.sh` process (print mode) or tmux session (TUI).

```bash
cd <worktree>                      # the checkout under test; npm ci once in a fresh worktree
S=.agents/skills/verify-pi-provider-kiro/scripts
$S/sandbox.sh --fake               # or: --fake tool | --fake <script.json> | --fake chat --creds kiro-cli | --live
# -> mode=fake
#    dir=/home/<user>/.cache/verify-pi-provider-kiro/20261024T073007-fake-tNps
#    fake=http://127.0.0.1:46695 pid=594667 scenario=chat creds=api-key
RUN=<the dir= value>
```

What `sandbox.sh` does:

- runs `npm run build` if `dist/index.js` is missing or older than any `src/*.ts`;
- resolves the real pi binary (`mise which pi`) **before** swapping HOME (`~/.local/bin/pi` is a mise shim that needs the real HOME);
- makes `$RUN/{home,agent,work,sessions,evidence,logs}` and an env file setting `HOME=$RUN/home`, `PI_CODING_AGENT_DIR=$RUN/agent`, `PI_CODING_AGENT_SESSION_DIR=$RUN/sessions`, `KIRO_DEBUG=1`, `KIRO_DEBUG_LOG=$RUN/logs/kiro-debug.log`. A scratch HOME matters: the provider resolves the kiro-cli DB, `~/.pi/agent/kiro-management-models-cache.json`, `~/.pi/logs` and `~/.aws/sso/cache` with `os.homedir()`, not with `PI_CODING_AGENT_DIR`;
- writes sha256 fingerprints of the person's real stores to `$RUN/real-stores.sha256` (doctor and stop compare them);
- `--fake`: starts the fake on a free loopback port (ready when `logs/fake-kiro.log` prints `fake-kiro listening http://127.0.0.1:<port>`), and adds dummy credentials: `KIRO_API_KEY=verify-fake-key` (default), or a dummy kiro-cli DB (`--creds kiro-cli`, or `--creds kiro-cli-expired`, which forces a refresh);
- `--live`: copies the kiro-cli DB with `sqlite3 -readonly <real> .backup <scratch>`, and **refuses (exit 3) unless the token the provider would choose has ≥ 10 min left**. A refresh would rotate the refresh token into the scratch copy only and leave the person's real store stale. Then log the sandbox pi in from that copy: `$S/login-cached.sh "$RUN"`.

Ready when `doctor.sh` passes. Teardown is in Cleanup.

## Doctor

Run first, and again whenever anything looks off. It is read-only and never prints a token.

```bash
$S/doctor.sh "$RUN"       # one PASS/FAIL line per check, exit 0 = worth driving
```

It checks that `dist` is current with `src` (it shows the commit and `+dirty`), that pi runs, that the env isolates HOME and the agent dir, that the person's stores are unchanged, and that the backend is up: the fake answers `/__verify/health` with **our** PID, or the live token has ≥ 5 min left (key name and minutes only). It also checks that `pi --list-models kiro` lists kiro models, and in fake mode that the shim rerouted a `management.*.kiro.dev` call (so no fake request reached the internet). If the list-models check fails on a kiro-cli sandbox, run `login-cached.sh` first.

## Drive

`pi.sh "$RUN" <pi args>` is the only way to start pi. It rebuilds the env from scratch (`env -i` plus the sandbox env) and adds `--no-extensions -e scripts/verify-shim.mjs -e <repo>/dist/index.js --no-skills --no-prompt-templates --no-themes --no-mcp --no-context-files --no-approve`. It runs in `$RUN/work`, puts `scripts/bin` (a refusing `kiro-cli` stub) first on PATH, and closes stdin when it is not a TTY.

**Print/JSON mode** (the main harness: each pi event is a line of JSON):

```bash
pi_json() { timeout 90 $S/pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "$@"; }
pi_json "Say hello" >"$RUN/evidence/chat.jsonl" 2>"$RUN/evidence/chat.stderr"
jq -c 'select(.type=="message_update") | .assistantMessageEvent | {type, delta}' "$RUN/evidence/chat.jsonl"
jq -c 'select(.type=="message_end" and .message.role=="assistant") | .message | {content, stopReason, errorMessage, usage}' "$RUN/evidence/chat.jsonl"
$S/pi.sh "$RUN" --list-models kiro
```

pi exits 0 even when the turn ends in an error. Judge a turn by the final assistant `stopReason` (`stop`, `toolUse`, `error`) and `errorMessage`, never by the exit code.

**TUI** (for `/model`, `/login` and the footer). This uses tmux on a private socket, `-L kiro-verify`, never the person's server:

```bash
$S/tui.sh "$RUN" start --model kiro/claude-sonnet-4-6
$S/tui.sh "$RUN" wait '/work' 30           # ready: the footer shows the cwd and model
$S/tui.sh "$RUN" type "/model"; $S/tui.sh "$RUN" keys Enter
$S/tui.sh "$RUN" wait 'Enter to select' 10
$S/tui.sh "$RUN" capture model-picker      # -> $RUN/evidence/tui-model-picker.txt
$S/tui.sh "$RUN" keys Down Enter
$S/tui.sh "$RUN" send "Say hello"; $S/tui.sh "$RUN" wait '↑[0-9.]+k? ↓' 60   # footer token counts = turn done
$S/tui.sh "$RUN" stop
```

Typing a slash command opens autocomplete: the first Enter accepts it, and the command may need a second Enter (`login-cached.sh` does both).

**Fake scenarios.** You can switch them on a running fake. Each switch resets the reply counter, and every request is logged to `$RUN/evidence/fake-kiro-requests.jsonl` with auth headers redacted:

```bash
FAKE=$(sed -n 's/^KIRO_VERIFY_FAKE_URL=//p' "$RUN/env")
curl -s -X POST "$FAKE/__verify/scenario?name=tool"     # chat | tool | rate-limit | too-big | stream-error
curl -s -X POST "$FAKE/__verify/scenario" --data-binary @my-script.json   # your own replies, in order
jq -c 'select(.path=="/generateAssistantResponse") | {ts, reply, model: .body.conversationState.currentMessage.userInputMessage.modelId}' "$RUN/evidence/fake-kiro-requests.jsonl"
```

Script format (each `generateAssistantResponse` request gets the next reply, and the last reply repeats): `{"events":[{"type":"<ChatResponseStream member>","payload":{…}}]}`, `{"status":429,"body":{…},"headers":{…}}`, or `{"events":[…],"exception":{"type":"throttlingError","payload":{…}}}`. In a text payload, `{{toolResult}}` is replaced by the tool result the request carried. Event member names are in `src/event-parser.ts` (`KIRO_EVENT_KEYS`).

**Live:** the same commands after `sandbox.sh --live` and `login-cached.sh`. Use one prompt per proof, and pick a cheap model (`kiro/claude-haiku-4-5`) unless the PR is about a specific model.

Feature recipes: `features/README.md`. **A proof that drives one entry point is incomplete while the map lists others for that feature.**

## Evidence

Everything goes under `$RUN/`, which lives in `~/.cache/verify-pi-provider-kiro/` (override with `KIRO_VERIFY_ROOT`) and survives cleanup and worktree removal:

- `evidence/<name>.jsonl` and `.stderr`: pi `--mode json` streams, one per drive. Name them after the claim (`chat.jsonl`, `tool.jsonl`, `rate-limit.jsonl`).
- `evidence/fake-kiro-requests.jsonl`: every request the provider sent, with the full body. This is the request-side proof, for history shape, `modelId`, `toolResults` and `profileArn`.
- `evidence/tui-<name>.txt`: TUI screen captures.
- `evidence/kiro-cli-calls.log`: each time the provider tried to shell out to `kiro-cli` (the stub refused it).
- `evidence/blocked-refresh.log` (live only): token refreshes the shim blocked.
- `evidence/real-stores-check.txt`: written by stop, it proves the person's stores were untouched.
- `sessions/*.jsonl` (pi's session file), `logs/kiro-debug.log` (provider debug log), `logs/fake-kiro.log`.

Proof standard:

- Drive the user path (the pi CLI or TUI) and capture both sides: the action (prompt or keys) and the resulting state, meaning the stream events, the final message and the screen. Verify side effects alongside: the request body the fake received, files a tool wrote in `$RUN/work`, a refreshed token written back to the scratch kiro-cli DB, and `agent/auth.json` after `/login`.
- Never call provider internals or test-only setters as "proof". The fake replaces only the HTTP boundary.
- Say live or fake in the verdict, with the run dir. A fake proof of a change to what Kiro accepts (request shape, new fields, model IDs) is not a proof: ask for a live run.
- Never paste tokens. `stop.sh` scrubs, but don't rely on it: quote `jq` extracts, not raw headers or credential files.

## Cleanup

```bash
$S/stop.sh "$RUN"
```

`stop.sh` kills the fake only if the recorded PID still runs `fake-kiro.mjs`, and kills only the tmux sessions this run recorded (`$RUN/tmux-sessions`, socket `kiro-verify`). It then runs `scrub.mjs`, which redacts every credential value found in the scratch DB, `auth.json` and env, plus Bearer, `aoa…`/`aor…` and `ksk_…` patterns, in `evidence/`, `logs/`, `sessions/` and `work/`, and fails if a known secret survives. It re-checks the real-store fingerprints, and deletes `$RUN/home` (the credential copy) and `$RUN/agent` (the scratch config and `auth.json`). Evidence stays. Never `pkill pi` or `pkill node`: the person's own pi and editors run on this host. Run `stop.sh` after every failed iteration too. A refused `--live` leaves only a run dir with `live-token` (key name and minutes), with nothing to stop.

## Helpers

All of these are in `scripts/` and executable:

- `sandbox.sh --fake [chat|tool|rate-limit|too-big|stream-error|<script.json>] [--creds api-key|kiro-cli|kiro-cli-expired]` / `sandbox.sh --live`: build if stale, isolate, start the fake, print `mode= dir=`.
- `doctor.sh <runDir>`: the read-only readiness check above.
- `pi.sh <runDir> [pi args…]`: the real pi with this worktree's dist only. Set `PI_SH_KEEP_STDIN=1` to pipe a prompt in.
- `tui.sh <runDir> start|wait <re> [s]|type <text>|send <text>|keys <k…>|capture [name]|stop`: drives the TUI over a private tmux socket.
- `login-cached.sh <runDir>`: `/login kiro` → "Sign in with an account" → "Use existing credentials". It refuses to press Enter on any other row, so it never starts an OAuth or browser flow.
- `stop.sh <runDir>`: targeted teardown, scrub, store check. Evidence stays.
- `scrub.mjs <runDir>`: the redaction pass on its own (stop runs it). It prints counts and file names only.
- `fake-kiro.mjs <port> <scenario|script.json> <log.jsonl>`: the fake. `sandbox.sh` starts it; run it by hand only to debug it.
- `verify-shim.mjs`: the pi extension `pi.sh` loads first. In fake mode it reroutes `*.kiro.dev`/`*.amazonaws.com` to the fake (loopback only). In live mode it blocks token-refresh endpoints.
- `bin/kiro-cli`: a stub on the sandbox PATH that logs the call and exits 1.
- Feature map: `features/README.md`. Keep it honest as the app changes.
