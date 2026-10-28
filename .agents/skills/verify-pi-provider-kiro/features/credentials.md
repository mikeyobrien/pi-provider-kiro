# Credentials: kiro-cli pickup, /login, refresh

The user gets pi talking to Kiro without a second login when kiro-cli is already signed in. They run `/login kiro` → "Sign in with an account" → "Use existing credentials". Expired tokens refresh silently. Code: `src/oauth.ts` (`loginKiro`, `refreshKiroToken`, desktop/IdC/external-IdP refresh), `src/kiro-cli.ts` (DB read and write-back, `refreshViaKiroCli`), `src/login.ts` + `src/login-ui.ts` (menu), `src/pi-auth-store.ts`, `src/kiro-ide.ts`, `src/token-type.ts`.

## Sub-features

- Sources, in the order the provider tries them: `KIRO_API_KEY` env; the kiro-cli DB `auth_kv` keys `kirocli:social:token` (desktop), `kirocli:odic:token`/`codewhisperer:odic:token` (IdC, with `…:odic:device-registration`) and `kirocli:external-idp:token`; the Kiro IDE `~/.aws/sso/cache`; pi's own `auth.json` `kiro` entry.
- **pi 1.4.0 does not pick up kiro-cli credentials on its own.** With only a kiro-cli DB, pi says `No API key found for kiro` and lists no models (observed 2026-10-24), and the user must run `/login kiro` once. The extension's own startup catalog call does use the kiro-cli token.
- Login menu: `/login kiro` → "Select authentication method": `Sign in with an account` / `Sign in with an API key`. Account → "Kiro Login": `Use existing credentials` / `API Key` / `Web Login` / `Device Code`. Only the first is safe to drive: the others start OAuth, open a browser or need a real key.
- After login pi prints `Logged in to Kiro (Builder ID / Google / GitHub). Credentials saved to <agentDir>/auth.json`, followed by `Error: … no default model is configured for provider "kiro". Use /model to select a model.` That second line is a known UX wart, not a failure.
- Desktop refresh: an expired social token → `POST prod.<region>.auth.desktop.kiro.dev/refreshToken` → the new access token (and possibly a rotated refresh token) is written back to the kiro-cli DB and `auth.json`.
- On a runtime 403 the provider shells out to `kiro-cli debug refresh-auth-token`. In the sandbox the `bin/kiro-cli` stub logs this to `evidence/kiro-cli-calls.log` and refuses.
- External IdP requests carry `tokentype: EXTERNAL_IDP`.

## How to get to it (user POV)

Sign in with `kiro-cli login`, start `pi`, type `/login kiro` and choose "Sign in with an account" → "Use existing credentials". After that, `pi --model kiro/<id>` works with no prompt.

## Driving it with pi.sh / tui.sh

```bash
S=.agents/skills/verify-pi-provider-kiro/scripts
# fake, expired dummy kiro-cli token -> refresh through the fake
RUN=$($S/sandbox.sh --fake chat --creds kiro-cli-expired | sed -n 's/^dir=//p')
$S/pi.sh "$RUN" --list-models kiro               # expect: "No models available" (pi 1.4.0, no pickup)
$S/login-cached.sh "$RUN"                        # TUI: /login kiro -> account -> Use existing credentials
jq -c '{path, originalHost}' "$RUN/evidence/fake-kiro-requests.jsonl"     # /refreshToken from prod.us-east-1.auth.desktop.kiro.dev
jq -r '.kiro | {type, authMethod, region, expires}' "$RUN/agent/auth.json"  # never print .access/.refresh
sqlite3 -readonly "$RUN/home/.local/share/kiro-cli/data.sqlite3" \
  "select json_extract(value,'\$.expires_at') from auth_kv where key='kirocli:social:token'"   # moved forward = write-back
timeout 90 $S/pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "Say hello" >"$RUN/evidence/chat.jsonl"
$S/stop.sh "$RUN"
```

Use `--creds kiro-cli` for pickup without a refresh (no `/refreshToken` call), and `--creds api-key` (the default) for the `KIRO_API_KEY` path, which needs no login.

Live: `sandbox.sh --live`, which copies the real DB and refuses unless the token has ≥ 10 min left. Then run `login-cached.sh`, `doctor.sh` and one chat. The shim blocks any refresh attempt (`evidence/blocked-refresh.log`), because a refresh would rotate the person's refresh token into the scratch copy.

Proof (fake): the screens `evidence/tui-login-{1-method,2-options,3-result}.txt`, an `auth.json` `kiro` entry with `authMethod: "desktop"`, a `/refreshToken` request with `originalHost: prod.us-east-1.auth.desktop.kiro.dev`, the scratch DB `expires_at` moved about 1 h ahead, and the follow-up chat succeeding with `Authorization` present (`[REDACTED len=…]`).

Proven 2026-10-24 (fake): `~/.cache/verify-pi-provider-kiro/20261024T073914-fake-HLQ1/evidence/` (refresh + write-back), and `…/20261024T073751-fake-n1aZ/evidence/` (unexpired pickup, then chat).

## Gotchas

- Never select Web Login or Device Code, and never run a real `kiro-cli login`. Both are interactive OAuth and out of scope for agents. `login-cached.sh` refuses to press Enter unless the cursor is on "Use existing credentials".
- Never print `auth.json` or the DB values. Extract the non-secret fields with `jq`/`json_extract` as above. `stop.sh` scrubs, and deletes `home/` and `agent/`.
- The live refusal is deliberate. If the person's token is stale, ask them to use Kiro once themselves (their own pi or kiro-cli refreshes their real store), then rerun.
- IdC and external-IdP refresh are not mapped: the fake has no `oidc …/token` route, and no dummy IdC DB is created.
