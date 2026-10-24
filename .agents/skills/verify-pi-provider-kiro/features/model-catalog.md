# Model catalog and selection

The user sees Kiro's models in pi (`--list-models`, `/model` picker, Ctrl+P cycling) and picks one. The request then carries the Kiro model ID. Code: `src/models.ts` (bootstrap `kiroModels`, `KIRO_MODEL_IDS`, `resolveKiroModel`, management cache), `src/management.ts` (`List-Available-Profiles`, `List-Available-Models`), `src/index.ts` (`refreshModels`, `modifyModels`).

## Sub-features

- Bootstrap catalog: the static `kiroModels` list (15 IDs on pi 1.4.0, e.g. `claude-sonnet-4-6`, `claude-haiku-4-5`, `auto`, `deepseek-3-2`, `glm-5`, `qwen3-coder-next`) is shown before any discovery.
- Discovery: on registration the provider calls `List-Available-Profiles` then `List-Available-Models?origin=KIRO_CLI&profileArn=…`, writing `$HOME/.pi/agent/kiro-management-models-cache.json` (the scratch HOME in a sandbox). The picker then shows the discovered catalog.
- ID mapping: the pi ID `claude-haiku-4-5` becomes the wire `modelId: "claude-haiku-4.5"` (`(\d)-(\d)` → `$1.$2`, or the cached `kiroModelId`).
- Region and profile: `modifyModels` pins `baseUrl` to the credential's region, and `KIRO_PROFILE_ARN` overrides discovery.
- Capabilities per model: context window, max output, reasoning, images (the `--list-models` columns).

## How to get to it (user POV)

`pi --list-models kiro`, or in the TUI type `/model`, pick a row and press Enter: the footer shows the new model. `pi --model kiro/<id>` selects one at start.

## Driving it with pi.sh / tui.sh

```bash
S=.agents/skills/verify-pi-provider-kiro/scripts
RUN=$($S/sandbox.sh --fake chat | sed -n 's/^dir=//p')
$S/pi.sh "$RUN" --list-models kiro | tee "$RUN/evidence/list-models.txt"
jq -c 'select(.path|test("List-Available")) | {path, originalHost, query}' "$RUN/evidence/fake-kiro-requests.jsonl"
# picker + selection + wire id
$S/tui.sh "$RUN" start --model kiro/claude-sonnet-4-6
$S/tui.sh "$RUN" wait '/work' 30
$S/tui.sh "$RUN" type "/model"; $S/tui.sh "$RUN" keys Enter
$S/tui.sh "$RUN" wait 'Enter to select' 10; $S/tui.sh "$RUN" capture model-picker
$S/tui.sh "$RUN" keys Down Enter            # second row
$S/tui.sh "$RUN" send "Say hello"; $S/tui.sh "$RUN" wait '↑[0-9.]+k? ↓' 60; $S/tui.sh "$RUN" capture model-after
$S/tui.sh "$RUN" stop
jq -c 'select(.path=="/generateAssistantResponse") | .body.conversationState.currentMessage.userInputMessage.modelId' "$RUN/evidence/fake-kiro-requests.jsonl"
$S/stop.sh "$RUN"
```

Proof (fake): the first `--list-models` prints the 15 bootstrap models, and the request log shows `List-Available-Profiles` + `List-Available-Models` from `management.us-east-1.kiro.dev`. The picker then lists the fake's 3 discovered models (`claude-sonnet-4-6`, `claude-haiku-4-5`, `auto`) with the line "Model catalogs refreshed.". After Down+Enter the footer shows `claude-haiku-4-5`, and the request carries `modelId: "claude-haiku-4.5"`.

Live: `--list-models kiro` after `login-cached.sh` should list your profile's real catalog. Compare it with the bootstrap list for catalog PRs.

Proven 2026-10-24 (fake): `~/.cache/verify-pi-provider-kiro/20261024T073311-fake-dzta/evidence/fake-kiro-requests.jsonl` (picker → `claude-haiku-4.5`).

## Gotchas

- The first `--list-models` in a fresh sandbox shows the bootstrap list. The discovered catalog appears on the next start, once the cache is written. Edit the `CATALOG` constant in `scripts/fake-kiro.mjs` (or post a scenario) to test catalog mapping.
- With no usable credential pi shows "No models available", which is not a catalog bug: a kiro-cli-only sandbox needs `login-cached.sh` first.
- Slash commands open autocomplete: you need Enter to accept the command and sometimes a second Enter to run it.
