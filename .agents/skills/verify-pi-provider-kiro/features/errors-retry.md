# Errors and retries

When Kiro answers with a rate limit, an oversize error or a broken stream, the user sees either a short retry and then a normal answer, or a clear error. Nothing hangs and no garbage text appears. Code: `src/retry.ts` (classification, `USER_REQUEST_RATE_EXCEEDED` wait), `src/stream.ts` (request loop, mid-stream error retry, first-token/idle timeouts), `src/errors.ts`, `src/event-parser.ts` (`parseKiroExceptionFrame`).

## Sub-features

- HTTP 429 with JSON `reason: "USER_REQUEST_RATE_EXCEEDED"`: the provider retries itself, honouring the server wait hint (capped at 10 s, `src/retry.ts`). Other 429/5xx responses are left to pi's outer retry.
- HTTP 413, or 400 with a too-big pattern: the error goes straight back to the caller (`Kiro API error: context_length_exceeded (413 …)`) with no retry, so pi's compaction can handle it.
- Mid-stream exception frame (`:message-type: exception`, `throttlingError` / `validationError` / `serviceUnavailableError` / `error`): the stream is cancelled, retried with backoff, and the partial text from the failed attempt is discarded.
- First-token and idle timeouts, and the response-header timeout: retried with backoff (not mapped yet, needs `delayMs` scripts).
- 403: refresh from kiro-cli or the store, then retry (see credentials.md, the stub refuses kiro-cli).

## How to get to it (user POV)

This happens on its own under load or with very long sessions. The user sees a delay and then the answer, or a red error line in the TUI (`stopReason: "error"` in JSON mode).

## Driving it with pi.sh / tui.sh

```bash
S=.agents/skills/verify-pi-provider-kiro/scripts
RUN=$($S/sandbox.sh --fake chat | sed -n 's/^dir=//p')
FAKE=$(sed -n 's/^KIRO_VERIFY_FAKE_URL=//p' "$RUN/env")
for sc in rate-limit too-big stream-error; do
  curl -s -X POST "$FAKE/__verify/scenario?name=$sc"
  timeout 120 $S/pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "Say hello" \
    >"$RUN/evidence/$sc.jsonl" 2>"$RUN/evidence/$sc.stderr"
  jq -c 'select(.type=="message_end" and .message.role=="assistant") | .message | {t: [.content[]? | .text // .thinking], stopReason, errorMessage}' "$RUN/evidence/$sc.jsonl"
done
jq -c 'select(.path=="/generateAssistantResponse") | {ts, reply}' "$RUN/evidence/fake-kiro-requests.jsonl"   # attempts + spacing
$S/stop.sh "$RUN"
```

Proof (fake):

- `rate-limit`: two requests about 1.0 s apart (the 429 carries `retry-after: 1`), and the final message is the normal chat (`stop`).
- `too-big`: exactly one request, then `stopReason: "error"` with `errorMessage` starting `Kiro API error: context_length_exceeded (413`.
- `stream-error`: two requests about 1 s apart, the first ending in a `throttlingError` exception frame. The final text is `VERIFY-OK hello from fake Kiro`, with no leftover `partial `.

For your own cases, post a script, for example a 429 with a different `reason` (which should not be retried by the provider), or a 400 with a too-big message.

Live: do not provoke limits on the real service. Error PRs are proven in fake mode, plus one normal live turn showing the happy path still works.

Proven 2026-10-24 (fake): `~/.cache/verify-pi-provider-kiro/20261024T073311-fake-dzta/evidence/{rate-limit,too-big,stream-error}.jsonl`.

## Gotchas

- pi exits 0 on an errored turn: assert `stopReason`/`errorMessage`.
- Retry spacing is the proof of "honoured the wait hint": read the `ts` gaps in `fake-kiro-requests.jsonl`, not wall time.
- A non-Kiro-specific 429 or 5xx goes to pi's own retry layer, so the retries you see are pi's (in the JSON stream as auto-retry events), not the provider's. Prove which layer retried before you judge a retry PR.
