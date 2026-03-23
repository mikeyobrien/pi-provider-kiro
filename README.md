# pi-provider-kiro

A [pi](https://github.com/nicholasgasior/pi-coding-agent) provider extension that connects pi to the **Kiro API** (AWS CodeWhisperer/Q), giving you access to 17 models through a single provider.

## Models

| Family | Models | Context | Reasoning |
|--------|--------|---------|-----------|
| Claude Opus 4.6 | opus-4-6, opus-4-6-1m | 200K / 1M | ✓ |
| Claude Sonnet 4.6 | sonnet-4-6, sonnet-4-6-1m | 200K / 1M | ✓ |
| Claude Opus 4.5 | opus-4-5 | 200K | ✓ |
| Claude Sonnet 4.5 | sonnet-4-5, sonnet-4-5-1m | 200K / 1M | ✓ |
| Claude Sonnet 4 | sonnet-4 | 200K | ✓ |
| Claude Haiku 4.5 | haiku-4-5 | 200K | ✗ |
| DeepSeek 3.2 | deepseek-3-2 | 128K | ✓ |
| Kimi K2.5 | kimi-k2-5 | 200K | ✓ |
| MiniMax M2.1 | minimax-m2-1 | 128K | ✗ |
| GLM 4.7 | glm-4-7, glm-4-7-flash | 128K | ✓ / ✗ |
| Qwen3 Coder | qwen3-coder-next, qwen3-coder-480b | 128K | ✓ |
| AGI Nova | agi-nova-beta-1m | 1M | ✓ |

All models are free to use through Kiro.

## Setup

Install the provider:

```bash
pi install npm:pi-provider-kiro
```

Or install via npm directly:

```bash
npm install -g pi-provider-kiro
```

Then log in:

```
/login kiro
```

This opens a browser for authentication. You can choose from:
- **AWS Builder ID** — Native device code flow (works in SSH/remote environments)
- **Google** — Social login (requires local browser or SSH port forwarding)
- **GitHub** — Social login (requires local browser or SSH port forwarding)

If you have [kiro-cli](https://kiro.dev) installed and already logged in, credentials are picked up automatically — no second login needed.

## Usage

Once logged in, select any Kiro model in pi:

```
/model claude-sonnet-4-6
```

Reasoning is automatically enabled for supported models. Use `/reasoning` to adjust the thinking budget.

## Retry Behavior

Generic transient retries such as HTTP `429` and `5xx` are handled by `pi-coding-agent` at the session layer.

This provider only keeps local recovery for Kiro-specific cases:
- `403` auth races, where it can refresh credentials from `kiro-cli`
- first-token / stalled-stream recovery
- empty-stream retries
- non-retryable Kiro body markers like `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY`

## Development

```bash
npm run build       # Compile TypeScript
npm run check       # Type check (no emit)
npm test            # Run all 248 tests
npm run test:watch  # Watch mode
```

## Architecture

The extension is organized as one feature per file:

```
src/
├── index.ts            # Extension registration
├── models.ts           # 17 model definitions + ID resolution
├── oauth.ts            # Multi-provider auth (Builder ID / Google / GitHub)
├── kiro-cli.ts         # kiro-cli credential sharing
├── transform.ts        # Message format conversion
├── history.ts          # Conversation history management
├── thinking-parser.ts  # Streaming <thinking> tag parser
├── event-parser.ts     # Kiro stream event parser
└── stream.ts           # Main streaming orchestrator
```

See [AGENTS.md](AGENTS.md) for detailed development guidance and [.agents/summary/](/.agents/summary/index.md) for full architecture documentation.

## License

MIT
