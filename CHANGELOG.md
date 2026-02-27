# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.1.1...v0.2.1
[0.1.1]: https://github.com/mikeyobrien/pi-provider-kiro/releases/tag/v0.1.1
