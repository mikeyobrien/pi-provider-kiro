# Feature map: pi-provider-kiro

One file per user-facing feature. Each says what the feature is, how a pi user reaches it, the exact drive with this skill's harness (`scripts/pi.sh` print/JSON mode, `scripts/tui.sh` for the TUI), and the observable end state that proves it. A verification that drives one convenient entry point is incomplete while this map lists more for that feature.

| Feature | File | Surface | Fake proves | Live needed for |
| --- | --- | --- | --- | --- |
| Streamed chat turn with thinking | [streamed-chat.md](streamed-chat.md) | `pi -p --mode json`, TUI | thinking/text deltas, usage, history shape on the wire | real reasoning frames, real usage numbers |
| Tool-call round trip | [tool-round-trip.md](tool-round-trip.md) | `pi -p --mode json` | toolUse decode → pi runs the tool → `toolResults` turn with `content: ""` | Kiro accepting the tool spec and result turn |
| Model catalog and selection | [model-catalog.md](model-catalog.md) | `pi --list-models kiro`, TUI `/model`, `--model` | catalog discovery → cache → picker; dash→dot `modelId` | which models a real profile/region gets |
| Credentials: kiro-cli pickup, `/login`, refresh | [credentials.md](credentials.md) | TUI `/login kiro`, kiro-cli DB, `KIRO_API_KEY` | cached-credential login, desktop refresh + write-back, API-key path | a real token being accepted (`--live`) |
| Errors and retries | [errors-retry.md](errors-retry.md) | `pi -p --mode json` + fake scenarios | 429 `USER_REQUEST_RATE_EXCEEDED` retry, 413 no-retry, mid-stream exception retry | real throttling/limits (do not provoke them live) |

Proven in fake mode on 2026-10-24 against pi 1.4.0: every row above (see each file's "Proven" line). Proven live on 2026-10-24 (Google social token, `kiro/claude-haiku-4-5`): streamed chat and tool round trip, plus `/login` cached-credential pickup and `--list-models` (8 models on that profile). Run dirs `~/.cache/verify-pi-provider-kiro/20261024T085801-live-e85H` and `…/20261024T090108-live-MTvS`. Model-catalog picker and errors/retry are fake-only so far.

Not yet mapped (add a file before claiming them verified):

- Usage footer (`"pi-provider-kiro": {"showUsageInFooter": true}` in `$RUN/agent/settings.json`, `Get-Usage-Limits`). The fake answers it with an empty breakdown, so no badge shape is proven yet.
- Usage tracking estimates (`usageTracking.estimateDollarValue` / `estimateCacheUsage`).
- Images (an image input → `userInputMessage.images`; stripped from history).
- History truncation/repair on long or broken sessions (`--session`/`--continue` with a crafted session file).
- Reasoning effort / `--thinking` levels → request fields (`src/effort.ts`).
- Text-format tool-call recovery (`<invoke>`, bracket tool calls), a fake script with such text.
- IdC (Builder ID / Identity Center) refresh via `oidc.<region>.amazonaws.com/token`, external-IdP refresh, Kiro IDE `~/.aws/sso/cache` pickup. Only the desktop (social) refresh is mapped.
- First-token / idle stream timeouts (a fake script with `delayMs`).
