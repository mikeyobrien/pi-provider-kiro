# kiro-gateway

An Anthropic Messages API gateway for **Claude Code**, wrapping this repo's
`streamKiro()` — the exact streaming function the pi extension runs in
production. No protocol re-implementation: Kiro auth (API key), profile
discovery, history repair, retry classification, thinking parsing and the
text-tool-call recovery all come from `src/` unchanged. The gateway only adds
two thin adapters:

- **In** (`src/convert-in.ts`): Anthropic Messages request → pi `Context`
  (system prompt, text/image blocks, `tool_use`/`tool_result`, thinking
  config → reasoning level, model id normalization incl. dated suffixes).
- **Out** (`src/convert-out.ts`): pi `AssistantMessageEvent` stream →
  Anthropic SSE (`message_start` → `content_block_*` → `message_delta` →
  `message_stop`) or an aggregated Message JSON for non-streaming calls.
  Includes the provider quirk that `toolcall_delta` carries the *full* input
  string — the writer diffs it into append-only `input_json_delta`s.

Models: the gateway serves and resolves the account's **dynamic catalog**
(the same `List-Available-Models` data pi shows, refreshed when stale using
the request's key), falling back to the static bootstrap list only before
discovery. A bootstrap-only id is still attempted upstream so Kiro's own
error (e.g. `INVALID_MODEL_ID`) surfaces instead of a silent model swap.

Endpoints: `POST /v1/messages` (stream + non-stream), `GET /v1/models`,
`POST /v1/messages/count_tokens` (local estimate), `GET /health`.
An SSE `: ping` comment heartbeat (15s) keeps Claude Code from idle-timing
out during Kiro's long first-token waits.

## Build & run

```bash
# from the repo root (parent deps provide esbuild + pi packages)
npm install
node gateway/build.mjs          # -> gateway/dist/main.js
node gateway/dist/main.js       # listens on 127.0.0.1:8990
```

Env: `GATEWAY_PORT` (default 8990), `GATEWAY_HOST` (default 127.0.0.1),
`KIRO_API_KEY` (fallback key), `PROXY_API_KEY` (optional local gate token —
clients sending it use the gateway's own `KIRO_API_KEY` instead).

Credentials per request: if the client sends a `ksk_...` token (Bearer or
`x-api-key`), it is used as the Kiro key — this is the intended cc-switch UX,
the key lives in the cc-switch provider form like any other API key. Profile
ARNs resolve through `GetProfile` (the only discovery call a `ksk_` key can
make) and are cached by the provider's management layer.

## Use with cc-switch

Add a custom provider for **Claude Code** (direct mode, no routing needed):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8990",
    "ANTHROPIC_AUTH_TOKEN": "<your ksk_ key>",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7"
  }
}
```

Notes:

- Model ids are the pi (dash) forms; dated Anthropic suffixes
  (`-20250929`) are stripped automatically.
- For 1M-context models (Opus 4.7/4.6, Sonnet 4.6) Claude Code otherwise
  assumes its default window — add `"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"`
  to the env if you want compaction timed to the real window.
- cc-switch needs **zero modifications**; the provider entry is plain user
  config and survives cc-switch upgrades. This is the same shape as the
  built-in Ollama / LM Studio / llama.cpp local presets.

## Keep it running (macOS launchd)

`~/Library/LaunchAgents/dev.kiro.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.kiro.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/pi-provider-kiro-new/gateway/dist/main.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/kiro-gateway.log</string>
  <key>StandardErrorPath</key><string>/tmp/kiro-gateway.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.kiro.gateway.plist
curl http://127.0.0.1:8990/health
```

## Tests

```bash
node gateway/smoke.mjs        # adapter stack, fake pi stream, no key needed
KIRO_API_KEY=<ksk_...> node gateway/smoke-live.mjs   # real Kiro end-to-end
```

Manual Claude Code checklist (after pointing cc-switch at the gateway):

- [ ] basic chat + streaming tool call (edit a file)
- [ ] parallel tool calls (ask for two independent reads in one turn)
- [ ] image paste / screenshot question
- [ ] Esc-interrupt a long answer, then continue the conversation
- [ ] long session → `/compact`, then keep working
- [ ] subagent (Task) round trip
- [ ] plan mode enter/exit

## Known MVP limits

- `count_tokens` and `message_start.usage.input_tokens` are local estimates
  (cl100k tokenizer); the accurate figure lands in `message_delta` from
  Kiro's `contextUsagePercentage`.
- Thinking blocks are emitted with an empty `signature` (Kiro provides
  none); inbound signatures are dropped, matching the provider's history
  handling.
- PDF `document` blocks are replaced with a placeholder note (Kiro accepts
  images only), same as the pi provider.
- Usage is credit-based on Kiro's side; the gateway reports the provider's
  token accounting as-is.
