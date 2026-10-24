# Streamed chat turn with thinking

The user sends a prompt with a Kiro model selected. The answer streams in: reasoning first (a thinking block, for reasoning models), then text, then usage in the footer. Code: `src/stream.ts` (request + event loop), `src/event-parser.ts` (frame → event), `src/thinking-parser.ts` (`<thinking>` tags in text), `src/transform.ts` + `src/history-validator.ts` (history on the wire).

## Sub-features

- Request: `POST runtime.<region>.kiro.dev/generateAssistantResponse` with `conversationState.currentMessage.userInputMessage.{content, modelId, origin:"KIRO_CLI"}`, history in `conversationState.history`, and `profileArn` at the top level. The system prompt is folded into the first user content after `<thinking_mode>enabled</thinking_mode><max_thinking_length>…` when thinking is on.
- Native reasoning: `reasoningContentEvent{text}` → pi `thinking_start/thinking_delta/thinking_end`, and `{signature}` closes the block.
- Tag reasoning: `<thinking>…</thinking>` inside `assistantResponseEvent.content` is split out by `ThinkingTagParser` when thinking is enabled.
- Text: `assistantResponseEvent{content}` → `text_start/text_delta/text_end`. Repeated identical deltas are kept (#174).
- Usage: `metadataEvent.tokenUsage` → `usage.input/output/totalTokens`, `contextUsageEvent` → `usage.contextPercent`, `meteringEvent` → credits.
- Non-reasoning models (`claude-haiku-4-5`) show no thinking block.
- Historical reasoning is not replayed into `assistantResponseMessage.content` (AGENTS.md).

## How to get to it (user POV)

`pi --model kiro/claude-sonnet-4-6` and type a prompt, or `pi -p --model kiro/claude-sonnet-4-6 "…"` for one shot. In the TUI the thinking block renders above the answer, and the footer then shows `↑<in> ↓<out> <ctx>%/<window>`.

## Driving it with pi.sh / tui.sh

```bash
S=.agents/skills/verify-pi-provider-kiro/scripts
RUN=$($S/sandbox.sh --fake chat | sed -n 's/^dir=//p')      # live: --live, then login-cached.sh
$S/doctor.sh "$RUN"
timeout 90 $S/pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "Say hello" \
  >"$RUN/evidence/chat.jsonl" 2>"$RUN/evidence/chat.stderr"
# stream order: thinking deltas, then text deltas
jq -c 'select(.type=="message_update") | .assistantMessageEvent | {type, delta}' "$RUN/evidence/chat.jsonl"
# final message: a thinking block + a text block, stopReason stop, usage filled
jq -c 'select(.type=="message_end" and .message.role=="assistant") | .message | {content: [.content[] | {type, t: (.text // .thinking)}], stopReason, usage}' "$RUN/evidence/chat.jsonl"
# request side (fake only): what the provider put on the wire
jq -c 'select(.path=="/generateAssistantResponse") | .body.conversationState | {modelId: .currentMessage.userInputMessage.modelId, history: (.history|length)}' "$RUN/evidence/fake-kiro-requests.jsonl"
$S/stop.sh "$RUN"
```

Proof: in fake mode the deltas are `"The user wants a short greeting. "`, `"Answer with the marker."` and then `"VERIFY-OK "`, `"hello from fake Kiro"`. The final message has `stopReason: "stop"`, `usage.input 1200`, `output 24` and `contextPercent 0.12`, and the request shows `modelId: "claude-sonnet-4.6"`. Live: there is a non-empty thinking block (reasoning model) and text, with `stopReason: "stop"` and usage from Kiro.

For a multi-turn history check, run a second prompt with `--continue` in the same sandbox (sessions live in `$RUN/sessions`). Then assert the second request's `history` alternates `userInputMessage`/`assistantResponseMessage`.

TUI variant: `tui.sh start --model kiro/claude-sonnet-4-6`, then `send "Say hello"`, `wait '↑[0-9.]+k? ↓' 60` and `capture chat`.

Proven 2026-10-24 (live, `kiro/claude-haiku-4-5`): `~/.cache/verify-pi-provider-kiro/20261024T085801-live-e85H/evidence/chat.jsonl`. It shows `text_delta "VERIFY-LIVE-OK"`, `stopReason: "stop"` and usage from Kiro (`input 6036`, `output 5`, `contextPercent 3.02`), with no thinking block (non-reasoning model). The request side is in `live-requests.jsonl` (`modelId: "claude-haiku-4.5"`).

Proven 2026-10-24 (fake), the skill's end-to-end run: `~/.cache/verify-pi-provider-kiro/20261024T074248-fake-cUde/evidence/` (`chat.jsonl`, `tui-chat.txt`, `fake-kiro-requests.jsonl`, `e2e-transcript.txt`).

## Gotchas

- pi `-p` waits for stdin EOF when stdin is not a TTY, which hangs forever. `pi.sh` closes stdin for you, so don't bypass it.
- The exit code is 0 even for an errored turn: check `stopReason`/`errorMessage`.
- Thinking is on by default for reasoning models. `--thinking off` removes the `<thinking_mode>` prefix and suppresses thinking events, which is a different code path to prove separately.
- The fake's replies are scripted: it ignores the prompt, so "the answer is relevant" proves nothing in fake mode. Prove the shape and the plumbing.
