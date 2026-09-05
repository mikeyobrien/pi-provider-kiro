# AGENTS.md — pi-provider-kiro

> Context file for AI coding assistants working on this codebase.

## Project Overview

pi extension that connects the pi coding agent to the Kiro API (AWS CodeWhisperer/Q). Provides 17 models across 7 families with multi-provider authentication (AWS Builder ID, Google, GitHub).

## Directory Structure

```
pi-provider-kiro/
├── src/                    # TypeScript source (9 files, one feature each)
│   ├── index.ts            # F1: Extension registration entry point
│   ├── models.ts           # F2: Model catalog + ID resolution
│   ├── oauth.ts            # F3: Multi-provider OAuth (Builder ID / Google / GitHub)
│   ├── kiro-cli.ts         # F4: kiro-cli SQLite credential sharing
│   ├── transform.ts        # F5: pi ↔ Kiro message transformation
│   ├── history.ts          # F6: History truncation + sanitization
│   ├── thinking-parser.ts  # F7: Streaming <thinking> tag parser
│   ├── event-parser.ts     # F8: Kiro stream JSON event parser
│   ├── stream.ts           # F9: Main streaming orchestrator
│   ├── login.ts            # F10: Interactive login (Builder ID / IdC / social)
│   └── history-validator.ts # F11: Conversation invariant validation + repair
├── test/                   # 1:1 test files for each source file
├── dist/                   # Compiled output (tsc)
├── .agents/summary/        # Detailed documentation (architecture, components, etc.)
├── package.json            # Extension config: pi.extensions → dist/index.js
├── tsconfig.json           # ES2022, ESNext modules, strict
└── vitest.config.ts        # Test config
```

## Key Patterns

### Feature-per-file
Each `src/` file owns exactly one numbered feature (F1–F11). When modifying a feature, the relevant file is obvious. Each has a matching test file. The numbered set is not the whole tree — `src/` also holds unnumbered support modules (`endpoints.ts`, `retry.ts`, `debug.ts`, and others).

### Model ID Convention
pi uses dashes (`claude-sonnet-4-6`), Kiro API uses dots (`claude-sonnet-4.6`). Conversion in `resolveKiroModel()` via regex: `(\d)-(\d)` → `$1.$2`. The `KIRO_MODEL_IDS` Set is the source of truth for valid model IDs.

### Kiro History Format
Kiro requires strict alternating `userInputMessage` / `assistantResponseMessage` entries. Tool results must be wrapped in synthetic user messages. `buildHistory()` in transform.ts handles this; `history.ts` sanitizes and truncates.

A tool-result turn carries its payload in `userInputMessageContext.toolResults` and ships `content: ""`. Kiro's rule is content **or** tool results (`NON_EMPTY_USER_MESSAGE` in first-party Kiro Agent), so no carrier text is needed — and inventing some puts a sentence the user never wrote into the conversation as a user utterance. `EMPTY_CONTENT_PLACEHOLDER` is only for a turn with neither: image-only, empty-text, or an out-of-union role.

`history-validator.ts` (F11) owns the seven invariants. `streamKiro` calls `repairKiroConversation` on the whole conversation (history plus the current message) immediately before building the request and sends the repaired entries. It never throws; a violation that survives repair is warned about, not fatal. `prepareHistory` still runs first and still owns image stripping, truncation, and its own salvage passes — but its pairing test is positional, so a mismatched tool-use/tool-result pair reaches repair as the shape that actually needs fixing.

A tool result that arrived behind a later assistant turn than the one that called it is relocated back behind its issuing turn, matched by id, before anything positional runs (`relocateDisplacedToolResults`). That preserves the real tool output which positional sanitization would otherwise discard, and for the interleaved-transcript shape it also makes `ALTERNATING_MESSAGES` hold — the interjection merges into the relocated carrier instead of forming a second consecutive user entry. The cost is wire chronology: a user turn that interrupted between a call and its result now appears after that result. Pinned by tests in `test/stream.test.ts` and `test/transform.test.ts`; see the CHANGELOG entry.

Historical assistant reasoning is **not** serialized into `assistantResponseMessage.content`. First-party Kiro Agent's `extractTextContent` type-filters to `text`, and flattening reasoning to `<thinking>…</thinking>` fabricated an XML dialect into the model's own remembered speech. A reasoning-only assistant turn is retained with `content: ""` so alternation survives.

### Streaming Pipeline
Raw bytes → `parseKiroEvents()` → typed `KiroStreamEvent` → `ThinkingTagParser` (if reasoning) → pi `AssistantMessageEventStream` events.

### Retry with Reduction
On 413/too-large: error propagated immediately to the caller (no retry). The caller is responsible for handling context overflow (e.g., compaction or history trimming), matching kiro-cli behavior.

HTTP 429 is provider-retried only when its JSON `reason` is exactly `USER_REQUEST_RATE_EXCEEDED`; server wait hints and the 10-second fallback/cap are owned by `src/retry.ts`. Other generic 429/5xx responses remain owned by Pi's outer retry layer.

### Credential Cascade
1. kiro-cli SQLite DB — checks social token first (`kirocli:social:token`), then IDC token, then external IdP token (`kirocli:external-idp:token`)
2. OAuth device code flow (interactive, opens browser)

### Auth Methods
- `idc`: AWS Builder ID or IAM Identity Center (SSO). Refresh via SSO OIDC endpoint. Token format: `refreshToken|clientId|clientSecret|idc[|region]`. Preferred — has clientId/clientSecret for refresh.
- `desktop`: Google/GitHub social login via Kiro auth service. Refresh via `prod.{region}.auth.desktop.kiro.dev`. Token format: `refreshToken|desktop[|region]`
- `external-idp`: Enterprise OIDC IdP (e.g. Okta) configured by the org, established by `kiro-cli login`. Refresh is a public-client `refresh_token` grant against the tenant's own `token_endpoint` (form-encoded, snake_case response, no client secret). Token format: `refreshToken|clientId|tokenEndpoint|external-idp[|region]`. Requests **must** carry `tokentype: EXTERNAL_IDP` or Kiro answers 403 "Invalid token" — see `src/token-type.ts`.

### The Refresh String Is The Only Storage
pi persists an OAuth credential as `access` / `refresh` / `expires`; the extra `KiroCredentials` fields (`region`, `clientId`, `clientSecret`, `profileArn`, `authMethod`) are **not** returned on the next session. That is why the refresh field is a pipe-delimited record rather than an opaque token — anything the refresh chain still needs has to be packed into it. `src/refresh-token.ts` owns the format; encode and parse through it instead of splitting on `|` at a call site, and read the SSO region with `kiroCredentialRegion()` so the encoded value is used when the live field is gone. The auth-method marker keeps its historical position and the optional region follows it, so the marker is located by scanning and older strings still parse.

### Three Regions, Not One
A request's region is not a single value; conflating them is the root of #104, #131 and every "profile not found in \<region\>" report.
- **SSO region** — where the credential was issued (`eu-west-1`). Only the OIDC refresh endpoint uses it. Recover it with `kiroCredentialRegion()`.
- **API region** — `resolveApiRegion(ssoRegion)`, one of the canonical management regions. A starting guess, not an answer.
- **Profile region** — where the profile actually lives, discovered by probing (`kiroProfileRegion()`), and the region every profile-dependent call must address: `ListAvailableModels`, `GetUsageLimits`, and the runtime host in each model's `baseUrl`. The catalog cache stores it as `catalogRegion` so `modifyModels` can point models there without re-probing.

### Login Methods
Users can authenticate via:
- **Builder ID**: Native device code flow (works in SSH/remote)
- **Google**: Social login (delegates to `kiro-cli login`, requires local browser or SSH port forwarding)
- **GitHub**: Social login (delegates to `kiro-cli login`, requires local browser or SSH port forwarding)

## Development

```bash
npm run build     # tsc → dist/
npm run check     # tsc --noEmit (type check only)
npm test          # vitest run (248 tests)
npm run test:watch # vitest (watch mode)
```

## Testing Patterns

- All tests use Vitest
- External calls (`fetch`, `execSync`, `existsSync`) are mocked via `vi.fn()` / `vi.stubGlobal()`
- Stream tests mock `fetch` to return a `ReadableStream`-like reader with `read()` returning encoded JSON chunks
- No integration tests — all unit tests with mocks
- Test file naming: `test/<source-name>.test.ts`

## Adding a New Model

1. Add the Kiro model ID to `KIRO_MODEL_IDS` Set in `src/models.ts`
2. Add a model definition object to the `kiroModels` array with: id (dash format), name, reasoning, input modalities, contextWindow, maxTokens
3. Update test counts in `test/models.test.ts` and `test/registration.test.ts`
4. Run `npm test` to verify

## Common Gotchas

- `ZERO_COST` is a frozen shared object — don't try to mutate model costs
- The `as any` cast in `index.ts` is intentional — `ProviderConfig.oauth` doesn't type `getCliCredentials`
- `kiro-cli.ts` uses `sqlite3` CLI via `execSync`, not a Node native module
- Output token count is estimated (`content.length / 4`), not from the API
- `contextUsagePercentage` is the only usage metric Kiro provides; input tokens are back-calculated
- Social login (Google/GitHub) requires `kiro-cli` to be installed — pi delegates the auth flow to it

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
