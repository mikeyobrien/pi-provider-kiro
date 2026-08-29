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

## Retry Behavior

Generic transient retries such as `5xx` are handled by `pi-coding-agent` at the
session layer.

This provider keeps local recovery for Kiro-specific cases:
- `403` auth races, where it can refresh credentials from `kiro-cli`
- first-token / stalled-stream recovery
- empty-stream retries
- non-retryable Kiro body markers like `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY`
- account rate rejections (`429` / `USER_REQUEST_RATE_EXCEEDED`) — see below

### Rate limiting

Kiro's rate limit is scoped to the **account**, so a parallel fan-out competes
with itself: every concurrent stream, every session, and every pi process on the
machine draws from one budget. The provider owns this case rather than delegating
it, because recovering well needs three things the session layer cannot do —
honor `Retry-After`, spread simultaneous retries apart, and slow down the
requests that have not been sent yet.

- **Retry**: up to 8 attempts on a budget of its own, so a rejection never costs
  a token-refresh or timeout retry. Delays use full jitter over a growing window
  (1s–60s); a `Retry-After` header is taken as the floor. An exhausted budget
  surfaces the `429` so session-level retry remains the outer safety net.
- **Pacing**: spacing between request *starts* — never a concurrency cap, so a
  long stream cannot block a queued one. Zero until a rejection is observed, one
  step wider per rejection *burst* (rejections within 1s count once), decaying
  back to zero after 30s of quiet. State lives in
  `~/.pi/logs/kiro-pacing.json`, so a process that starts right after a
  rejection inherits the spacing instead of bursting into the same wall.

Measured on a 100-request burst against a live account: 15 rejections, 0
surfaced errors, 100/100 completed. Letting each rejection widen spacing
individually (instead of per burst) drove spacing to its ceiling from one
collision and tripled wall time — 38.0s versus 13.8s for identical work.

Rate-limit events are appended to `~/.pi/logs/capacity-retries.log`:

```
USER_REQUEST_RATE_EXCEEDED — retrying in 1903ms (2/8, pacing 400ms)
```

Environment overrides:

| Variable | Default | Effect |
| --- | --- | --- |
| `KIRO_REQUEST_PACING=off` | on | Disable pacing; retry still applies |
| `KIRO_PACING_SHARED=off` | on | Keep pacing state process-local |
| `KIRO_PACING_MIN_MS` | `200` | Spacing after the first rejection |
| `KIRO_PACING_MAX_MS` | `4000` | Spacing ceiling |
| `KIRO_PACING_DECAY_MS` | `30000` | Quiet period before relaxing one step |
| `KIRO_PACING_COALESCE_MS` | `1000` | Window in which rejections count once |
| `KIRO_PACING_POLL_MS` | `2000` | How often a dormant process re-reads shared state |
| `KIRO_PACING_STATE_FILE` | `~/.pi/logs/kiro-pacing.json` | Shared state location |

To reproduce load locally: `N=100 node scripts/kiro-loadtest.mjs` (reads the
credential from pi's auth store and prints only aggregates).

The reason codes this provider classifies on are published from the package
entry point, so consumers can interpret a code without hardcoding their own copy
of the literals:

```ts
import {
  KIRO_REASON_CODES,
  isCapacityError,
  isNonRetryableBodyError,
  isRateLimitError,
  isTooBigError,
} from "pi-provider-kiro";

isTooBigError(400, body); // size rejection → safe to compact and retry
isCapacityError(body); // transient capacity → safe to retry as-is
isRateLimitError(429, body); // account rate limit → retry after a delay
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
