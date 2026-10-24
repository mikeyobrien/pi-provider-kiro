# Tool-call round trip

The model asks for a tool (pi's `bash`, `read`, `edit`, `write`), pi runs it, and the result goes back to Kiro in the next request, which answers using it. Code: `src/event-parser.ts` (`toolUseEvent`), `src/stream.ts` (`flushToolCall`, tool specs), `src/transform.ts` (tool-result turn), `src/history-validator.ts` (pairing invariants), `src/tool-name-aliases.ts`.

## Sub-features

- Decode: `toolUseEvent{toolUseId,name,input}` chunks are concatenated until `stop:true`, giving a pi `toolCall` block with parsed arguments and `stopReason: "toolUse"`.
- Execute: pi emits `tool_execution_start/update/end`, and the result becomes a `toolResult` message.
- Return: the next request's `currentMessage.userInputMessage` has `content: ""` and `userInputMessageContext.toolResults: [{toolUseId, content:[{text}], status:"success"}]`. No invented carrier text (AGENTS.md).
- History pairing: the assistant turn with `toolUses` is followed by the matching `toolResults`, and displaced results are relocated by id.
- Text-format tool calls (`<invoke …>`, bracket syntax) are recovered unless the model opts out (#175). Not mapped yet.

## How to get to it (user POV)

Ask for something that needs a tool: `pi -p --model kiro/claude-haiku-4-5 "Run: echo verify-tool-ran"`. In the TUI the tool step renders as a bash block with its output, then the answer.

## Driving it with pi.sh / tui.sh

```bash
S=.agents/skills/verify-pi-provider-kiro/scripts
RUN=$($S/sandbox.sh --fake tool | sed -n 's/^dir=//p')
timeout 90 $S/pi.sh "$RUN" --mode json -p --model kiro/claude-sonnet-4-6 "Run echo verify-tool-ran" \
  >"$RUN/evidence/tool.jsonl" 2>"$RUN/evidence/tool.stderr"
jq -c 'select(.type|test("tool_execution_(start|end)")) | {type, toolName, args, out: .result.content[0].text?, isError}' "$RUN/evidence/tool.jsonl"
jq -c 'select(.type=="message_end") | .message | {role, c: [.content[]? | {type, t: (.text // .name)}], stopReason}' "$RUN/evidence/tool.jsonl"
jq -c 'select(.path=="/generateAssistantResponse") | .body.conversationState.currentMessage.userInputMessage | {content: (.content|.[0:30]), toolResults: .userInputMessageContext.toolResults}' "$RUN/evidence/fake-kiro-requests.jsonl"
$S/stop.sh "$RUN"
```

Proof (fake): `tool_execution_end` for `bash` shows `out: "verify-tool-ran\n"` and `isError: false`. The messages run user → assistant[text, toolCall bash] (`toolUse`) → toolResult → assistant `"VERIFY-OK tool said: verify-tool-ran"` (`stop`). Request 2 has `content: ""` and `toolResults[0].toolUseId == "tooluse_verify_1"`. The fake echoes the result it received, so the final text proves the round trip reached the wire.

Live: use one prompt that needs exactly one tool. Proof is the same event and message sequence, with Kiro's final answer quoting the output.

Proven 2026-10-24 (fake): `~/.cache/verify-pi-provider-kiro/20261024T073311-fake-dzta/evidence/tool.jsonl`.

## Gotchas

- The tool really runs, in `$RUN/work`, so script only harmless commands in fake replies. Side effects stay in the run dir.
- To prove a different tool (e.g. `write`), post a script whose `toolUseEvent.input` is that tool's argument JSON (see the `tool` scenario in `scripts/fake-kiro.mjs`), then check the file in `$RUN/work`.
- `--no-tools` / `--tools` change the tool specs sent to Kiro. A PR touching tool specs needs a live run: the fake accepts any spec.
