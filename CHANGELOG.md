# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.3] - 2026-07-24

### Fixed

- Restore `max` as a distinct thinking level instead of aliasing it to the highest catalog-listed effort ([#99](https://github.com/mikeyobrien/pi-provider-kiro/pull/99)).

## [0.9.2] - 2026-07-22

### Fixed

- Restore visible summarized thinking for Claude Sonnet 5, Opus 4.8, and other adaptive-thinking models by requesting and parsing Kiro's native thinking stream events ([#97](https://github.com/mikeyobrien/pi-provider-kiro/pull/97)).

## [0.9.1] - 2026-07-22

### Fixed

- Restore user-visible Claude thinking output after the Kiro runtime migration by retaining structured adaptive effort while also sending the thinking markers required by the runtime ([#95](https://github.com/mikeyobrien/pi-provider-kiro/pull/95)).

## [0.9.0] - 2026-07-20

### Added

- Claude Sonnet 5 and Claude Fable 5 models ([#87](https://github.com/mikeyobrien/pi-provider-kiro/pull/87), [#83](https://github.com/mikeyobrien/pi-provider-kiro/pull/83)).
- Schema-driven reasoning effort, model token limits, and region-keyed catalog caching.

### Changed

- Migrated model discovery and inference to Kiro's management and runtime services, matching the current kiro-cli and kiro-agent REST protocols ([#91](https://github.com/mikeyobrien/pi-provider-kiro/pull/91)).

### Fixed

- Map pi's highest supported reasoning level to Kiro `max` for models whose catalog omits `xhigh`.

## [0.8.0] - 2026-05-29

### Added

- Claude Opus 4.8 model ([#78](https://github.com/mikeyobrien/pi-provider-kiro/pull/78))

## [0.7.0] - 2026-05-26

### Added

- Fully dynamic model list loading and caching using Kiro's `/ListAvailableModels` API, which completely replaces hardcoding-staleness and dynamically adds any new models Kiro registers (resolves [#69](https://github.com/mikeyobrien/pi-provider-kiro/issues/69)).
- Add `"pi-package"` keyword to `package.json` for discoverability on https://pi.dev/packages (resolves [#61](https://github.com/mikeyobrien/pi-provider-kiro/issues/61)).

### Changed

- Migrated all dependencies and imports from the deprecated `@mariozechner/` package scope to the new `@earendil-works/` package scope (`pi-ai`, `pi-coding-agent`, `pi-tui`), upgrading them to version `^0.75.5`.
- Updated build script to use `esbuild` direct compilation on source TypeScript files, improving speed and removing dual-step `tsc` builds.

### Fixed

- Fixed Google/GitHub social login issues by checking and injecting `profileArn` directly from `kiro-cli` configuration when AWS returns empty lists (merged PR [#70](https://github.com/mikeyobrien/pi-provider-kiro/pull/70)).
- Fixed production Git installation issues (`pi install git:...`) by moving `esbuild` to production dependencies and aligning the `prepare` lifecycle hook (merged PR [#68](https://github.com/mikeyobrien/pi-provider-kiro/pull/68)).
- Removed `glm-5` from the `eu-central-1` set since it is only supported in `us-east-1` (resolves [#66](https://github.com/mikeyobrien/pi-provider-kiro/issues/66)).
- Expose `xhigh` thinking level in pi UI for all reasoning models by declaring `thinkingLevelMap` metadata.

## [0.6.1] - 2026-04-18

### Added

- `KIRO_DEBUG` env var for structured debug logging of requests, stream events, and responses with redacted auth tokens ([#57](https://github.com/mikeyobrien/pi-provider-kiro/pull/57))

### Fixed

- Recover from expired kiro-cli tokens on 403 by falling back to `refreshViaKiroCli()` instead of silently reusing the stale access token ([#57](https://github.com/mikeyobrien/pi-provider-kiro/pull/57))

## [0.6.0] - 2026-04-18

### Added

- Claude Opus 4.7 model ([#54](https://github.com/mikeyobrien/pi-provider-kiro/pull/54))

### Fixed

- Accurate output token counting for tool-call turns ([#53](https://github.com/mikeyobrien/pi-provider-kiro/pull/53))
- Eliminate echo loop caused by synthetic history padding ([#51](https://github.com/mikeyobrien/pi-provider-kiro/pull/51))

## [0.5.2] - 2026-04-16

### Fixed

- Exclude `@earendil-works/pi-tui` from the release bundle so `npm ci` / CI builds stop trying to inline `koffi` native binaries during `prepare`

### Changed

- Refresh README and package metadata to match the current 19-model surface and login flow

## [0.5.1] - 2026-04-14

### Fixed

- Recover npm publishing after the failed `v0.5.0` release by shipping the Node 24 publish workflow update already merged on `main`

## [0.5.0] - 2026-04-07

### Added

- MiniMax M2.5 model
- Kiro IDE token as auth fallback when kiro-cli is unavailable
- Use pi `sessionId` for Kiro `conversationId`

### Fixed

- Add `profileArn` to `generateAssistantResponse` requests ([#28](https://github.com/mikeyobrien/pi-provider-kiro/issues/28))
- Scale `HISTORY_LIMIT` dynamically to model context window ([#30](https://github.com/mikeyobrien/pi-provider-kiro/issues/30))
- `sanitizeHistory` strips leading invalid entries instead of returning `[]`

## [0.4.2] - 2026-03-20

### Fixed

- Preserve non-Kiro provider models when applying region-based Kiro model filtering in `modifyModels()`

## [0.4.1] - 2026-03-19

### Changed

- Delegate generic HTTP `429` / `5xx` retry behavior to `pi-coding-agent` instead of retrying them inside the provider

### Fixed

- Prevent `pi-coding-agent` outer auto-retry from misclassifying Kiro `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY` errors as generic retryable `429`s

## [0.4.0] - 2026-03-15

### Added

- Google and GitHub social login support via kiro-cli delegation
- `getKiroCliSocialToken()` to prefer social credentials when available
- OAuth name updated to "Kiro (Builder ID / Google / GitHub)" to reflect all auth methods

### Changed

- `loginKiro()` now prefers social tokens from kiro-cli if available
- `refreshKiroToken()` checks social tokens first to respect user's chosen login method
- Social login requires kiro-cli to be installed (delegates browser/PKCE flow)

### Fixed

- Pass through raw `contextUsagePercentage` as `usage.contextPercent` so UIs display accurate context usage instead of back-calculating from input tokens (which the usage event can overwrite with raw counts exceeding the context window)

## [0.3.0] - 2026-03-05

### Added

- Cap system prompt at 4096 tokens before sending to Kiro API
- Model-aware history byte budget derived from context window (70% × 4 bytes/token)
- `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY` as non-retryable error patterns (kiro-cli parity)
- Abortable retry delays — abort signal cancels in-progress backoff waits
- Expired kiro-cli credential fallback in OAuth refresh cascade

### Changed

- Lower max retry backoff from 30s to 10s
- Increase idle timeout from 120s to 300s to match kiro-cli behavior
- Read snake_case device registration credentials from kiro-cli

### Fixed

- Drop empty assistant messages from history sanitization
- Handle error events mid-stream and reset idle timer on meaningful events
- Refresh token from kiro-cli on 403 before retrying

## [0.2.2] - 2026-02-26

### Added

- 4-layer auth refresh with kiro-cli sync: IDC token refresh, desktop token refresh, kiro-cli DB sync, and OAuth device code flow fallback

### Fixed

- Skip malformed tool calls instead of crashing; retry on idle timeout
- Biome formatting in event-parser test

## [0.2.1] - 2026-02-26

### Added

- Desktop auth method with region-aware token refresh via `prod.{region}.auth.desktop.kiro.dev`
- Error handling, retry logic (up to 3 retries with 0.7x reduction factor on 413), and history truncation

### Fixed

- Response validation, error tests, template syntax, and stream safety net

## [0.1.1] - 2026-02-19

### Added

- Initial release: 17 models across 7 families, OAuth device code flow, kiro-cli SQLite credential fallback, streaming pipeline with thinking tag parser

[Unreleased]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.5.1...v0.5.2
[0.4.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.4.0...v0.4.1
[0.5.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.4.5...v0.5.0
[0.4.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.3.2...v0.4.0
[0.3.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.1.1...v0.2.1
[0.1.1]: https://github.com/mikeyobrien/pi-provider-kiro/releases/tag/v0.1.1
