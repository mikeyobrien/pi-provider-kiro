# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-18

### Added

- Claude Opus 4.7 model ([#54](https://github.com/mikeyobrien/pi-provider-kiro/pull/54))

### Fixed

- Accurate output token counting for tool-call turns ([#53](https://github.com/mikeyobrien/pi-provider-kiro/pull/53))
- Eliminate echo loop caused by synthetic history padding ([#51](https://github.com/mikeyobrien/pi-provider-kiro/pull/51))

## [0.5.2] - 2026-04-16

### Fixed

- Exclude `@mariozechner/pi-tui` from the release bundle so `npm ci` / CI builds stop trying to inline `koffi` native binaries during `prepare`

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

[Unreleased]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.5.2...HEAD
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
