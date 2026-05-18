# @vsm/pi-provider-kiro

[pi-provider-kiro](https://github.com/anthropics/pi-provider-kiro) 포크. Kiro API(AWS CodeWhisperer/Q) 프로바이더 확장.

## 설치

### 방법 1: pi install (권장)

`~/.pi/agent/npm/.npmrc`에 다음 내용 추가:

```
registry=https://registry.npmjs.org/
@vsm:registry=https://nexus.tmapmp.com/repository/npm-private/
```

```bash
pi install npm:@vsm/pi-provider-kiro
```

### 방법 2: 전역 npm

`~/.npmrc`에 다음 내용 추가:

```
registry=https://registry.npmjs.org/
@vsm:registry=https://nexus.tmapmp.com/repository/npm-private/
```

```bash
npm install -g @vsm/pi-provider-kiro
```

### 사전 요구사항

- [kiro-cli](https://github.com/anthropics/kiro-cli) 설치 필수 (인증 전담)

## Fork Changes

### 원본 문제점

원본의 `refreshKiroTokenDirect`가 리전 매핑 문제로 토큰 리프레시에 실패하여,
토큰 만료 시 반복적으로 로그인 페이지가 표시되고 결국 kiro-cli로 직접 로그인하지 않으면 사용 불가한 상태였음.

### 해결: Token Refresh를 kiro-cli에 전임

- 직접 OAuth 리프레시 엔드포인트 호출 로직(`refreshKiroTokenDirect`) 제거
- 토큰 갱신은 kiro-cli DB 확인만 수행, 유효한 토큰 없으면 재로그인 유도
- `refreshViaKiroCli` (kiro-cli debug 명령 호출) 제거
- 403 응답 시 kiro-cli DB에 유효 토큰 없으면 즉시 에러 (무의미한 재시도 방지)

### 인증 흐름

```
토큰 만료 감지
  → refreshKiroToken: IDE/kiro-cli DB 확인
  → 유효 토큰 없음 → throw
  → pi 프레임워크가 loginKiro 호출
  → kiro-cli login 실행 (브라우저 인증)
  → 토큰 저장 → 정상 동작 재개
```
---

## Original README (pi-provider-kiro)

> 이하 원본 README 내용입니다.

# pi-provider-kiro

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Kiro API** (AWS CodeWhisperer/Q), exposing **19 free models across 8 families** through one provider surface.

## Why this exists

Kiro gives you a strong free model menu, but pi needs a provider that speaks Kiro's auth, model catalog, and streaming protocol cleanly. `pi-provider-kiro` handles that bridge, including:

- AWS Builder ID, IAM Identity Center, Google, and GitHub login flows
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

If you already use [kiro-cli](https://kiro.dev), the provider can reuse those credentials instead of forcing a second login.

## Models

| Family | Models | Context | Reasoning |
|--------|--------|---------|-----------|
| Claude Opus 4.6 | `claude-opus-4-6`, `claude-opus-4-6-1m` | 200K / 1M | ✓ |
| Claude Sonnet 4.6 | `claude-sonnet-4-6`, `claude-sonnet-4-6-1m` | 200K / 1M | ✓ |
| Claude Opus 4.5 | `claude-opus-4-5` | 200K | ✓ |
| Claude Sonnet 4.5 | `claude-sonnet-4-5`, `claude-sonnet-4-5-1m` | 200K / 1M | ✓ |
| Claude Sonnet 4 | `claude-sonnet-4` | 200K | ✓ |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | ✗ |
| DeepSeek 3.2 | `deepseek-3-2` | 128K | ✓ |
| Kimi K2.5 | `kimi-k2-5` | 200K | ✓ |
| MiniMax | `minimax-m2-1`, `minimax-m2-5` | 200K | ✗ |
| GLM 4.7 | `glm-4-7`, `glm-4-7-flash` | 128K | ✓ / ✗ |
| Qwen3 Coder | `qwen3-coder-next`, `qwen3-coder-480b` | 256K / 128K | ✓ |
| AGI Nova | `agi-nova-beta-1m` | 1M | ✓ |
| Auto | `auto` | 200K | ✓ |

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
npm test            # Run the Vitest suite
npm run test:watch  # Watch mode
```

## Architecture

The extension is organized as one feature per file:

```
src/
├── index.ts            # Extension registration
├── models.ts           # 19 model definitions + ID resolution
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
