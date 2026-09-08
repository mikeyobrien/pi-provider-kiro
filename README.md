# pi-provider-kiro

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Kiro API** (AWS CodeWhisperer/Q), exposing **12 kiro-cli-verified models** through one provider surface.

## Why this exists

Kiro gives you a strong free model menu, but pi needs a provider that speaks Kiro's auth, model catalog, and streaming protocol cleanly. `pi-provider-kiro` handles that bridge, including:

- AWS Builder ID, IAM Identity Center, Google, GitHub, and enterprise external IdP (OIDC) login flows
- shared credentials from an existing `kiro-cli` session when available
- reasoning-aware streaming
- region-aware model filtering so pi only shows models your Kiro region can actually use

## Quick start

Install the provider:

```bash
pi install npm:pi-provider-kiro
```

Or install it globally with npm:

```bash
npm install -g pi-provider-kiro
```

Then log in from pi:

```text
/login kiro
```

The login flow supports:
- **AWS Builder ID** — native device-code flow, works well over SSH/remotes
- **Your organization** — IAM Identity Center start URL
- **Google** — social login via `kiro-cli`
- **GitHub** — social login via `kiro-cli`

If your organization uses an external identity provider (e.g. Okta) through Kiro, log in once with
`kiro-cli login` and the provider reuses that session — no separate pi login needed.

If you already use [kiro-cli](https://kiro.dev), the provider can reuse those credentials instead of forcing a second login.

## Models

| Family | Models | Context | Reasoning |
|--------|--------|---------|-----------|
| Claude Opus | `claude-opus-4-7`, `claude-opus-4-6` | 1M | ✓ |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | ✓ |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | 200K | ✓ |
| Claude Sonnet 4 | `claude-sonnet-4` | 200K | ✓ |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | ✗ |
| DeepSeek 3.2 | `deepseek-3-2` | 164K | ✓ |
| MiniMax | `minimax-m2-1`, `minimax-m2-5` | 196K | ✗ |
| GLM 5 | `glm-5` | 200K | ✓ |
| Qwen3 Coder | `qwen3-coder-next` | 256K | ✓ |
| Auto | `auto` | 1M | ✓ |

All listed models are free to use through Kiro.

## Usage

Once logged in, select any Kiro model in pi:

```text
/model claude-sonnet-4-6
```

Or let Kiro pick automatically:

```text
/model auto
```

Reasoning is automatically enabled for supported models. Use `/reasoning` to adjust the thinking budget.

### Estimated usage cost

Kiro reports an exact credit count for completed turns, but not a per-turn USD charge. In `~/.pi/agent/settings.json`, you can opt in to converting those credits into an estimated USD-equivalent value for Pi usage dashboards:

```json
{
  "pi-provider-kiro": {
    "usageTracking": {
      "enabled": true
    }
  }
}
```

When enabled, `usdPerCredit` defaults to Kiro's published add-on rate of `$0.04` per credit. Override it when a different equivalent rate is appropriate:

```json
{
  "pi-provider-kiro": {
    "usageTracking": {
      "enabled": true,
      "usdPerCredit": 0.025
    }
  }
}
```

This value is an estimate, not an invoice or confirmed marginal charge. Credits included in a subscription may have no marginal cost. Tracking is disabled by default, and invalid settings fail closed to disabled. Pi's HTML session export currently recomputes component costs and may therefore show `$0`; cost dashboards and summaries that read `usage.cost.total` show the estimate.

## Retry Behavior

Generic transient retries such as HTTP `429` and `5xx` are handled by `pi-coding-agent` at the session layer.

This provider only keeps local recovery for Kiro-specific cases:
- `403` auth races, where it can refresh credentials from `kiro-cli`
- first-token / stalled-stream recovery
- empty-stream retries
- non-retryable Kiro body markers like `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY`

The reason codes this provider classifies on are published from the package
entry point, so consumers can interpret a code without hardcoding their own copy
of the literals:

```ts
import {
  KIRO_REASON_CODES,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
} from "pi-provider-kiro";

isTooBigError(400, body); // size rejection → safe to compact and retry
isCapacityError(body); // transient capacity → safe to retry as-is
isNonRetryableBodyError(body); // hard quota → do not retry
```

These are Kiro's own codes, not a provider taxonomy: mapping them to your own
semantics is the consumer's job.

One caveat for consumers outside pi: the entry point is the whole provider, so
importing it loads modules that import pi's host packages
(`@earendil-works/pi-ai`, `-pi-coding-agent`, `-pi-tui`). They are declared as
optional peer dependencies — present already wherever this runs as a pi
extension, but a standalone project must install them itself or the import fails
with `ERR_MODULE_NOT_FOUND`. The types resolve without them under the usual
`skipLibCheck`.

## Development

```bash
npm run build       # Compile TypeScript
npm run check       # Type check (no emit)
npm test            # Run the Vitest suite
npm run test:watch  # Watch mode
```

## Architecture

The extension is organized as one feature per file:

```
src/
├── index.ts            # Extension registration
├── models.ts           # 12 model definitions + ID resolution
├── oauth.ts            # Multi-provider auth (Builder ID / Google / GitHub)
├── kiro-cli.ts         # kiro-cli credential sharing
├── transform.ts        # Message format conversion
├── history.ts          # Conversation history management
├── thinking-parser.ts  # Streaming <thinking> tag parser
├── token-type.ts       # `tokentype` header for external IdP bearer tokens
├── event-parser.ts     # Kiro stream event parser
└── stream.ts           # Main streaming orchestrator
```

See [AGENTS.md](AGENTS.md) for detailed development guidance and [.agents/summary/](/.agents/summary/index.md) for full architecture documentation.

## License

MIT
