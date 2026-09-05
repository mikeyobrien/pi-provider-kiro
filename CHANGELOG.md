# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Preserve canonical `developer` messages emitted by newer Pi-compatible hosts by lowering them to Kiro user input. Agent reminders and advisories previously degraded to the neutral `"Please proceed with the task."` placeholder when current, and disappeared from historical context entirely.

## [0.10.2] - 2026-08-31

### Added

- Support kiro-cli external IdP credentials, so a kiro-cli session authenticated through an external identity provider can be reused by the provider instead of forcing a separate login ([#134](https://github.com/mikeyobrien/pi-provider-kiro/pull/134)).
- OAuth rework: interactive login, API key support, and PKCE social login ([#135](https://github.com/mikeyobrien/pi-provider-kiro/pull/135)).
- Keep the newest bounded image in history so follow-ups like "look at that image again" still resolve. The newest image-bearing turn is retained when its payload fits 512KB of base64; older turns are still stripped, and an oversized newest set is dropped rather than substituting an older image. Retention is conditional on the model actually accepting images, and `gpt-5.6-luna`'s vision capability is now mapped correctly with stale cache entries corrected on read ([#138](https://github.com/mikeyobrien/pi-provider-kiro/pull/138)).
- Export Kiro's reason-code vocabulary as a frozen `KIRO_REASON_CODES` record and re-export the `isTooBigError` / `isNonRetryableBodyError` / `isCapacityError` classification predicates from the entry point, so consumers stop hardcoding drifting copies of the same service strings ([#115](https://github.com/mikeyobrien/pi-provider-kiro/pull/115)). The same change makes the published entry point actually resolvable and loadable: `main`/`types` are declared, declarations are emitted, the esbuild bundle gains the `createRequire` banner its bundled CJS graph needs, and the pi host packages are declared as optional peerDependencies. `test/packaging.test.ts` pins the whole contract.
- The entry module now re-exports `KiroManagementHttpError` ([#144](https://github.com/mikeyobrien/pi-provider-kiro/pull/144)). The class already shipped in 0.10.0 and is thrown by every management-plane request that returns a non-OK status (profile discovery, model catalog, usage limits) and already caught in `stream.ts`, where a 403 drives the credential-refresh retry — but it was not re-exported from `src/index.ts`, and there is no per-module file to deep-import instead: the build bundles the whole graph into one `dist/index.js`. No behaviour change: the class, its `status` field, and every throw and catch site are unchanged. Same entry-point caveat as the 0.10.0 re-exports — this is the extension entry the pi host loads, not a resolvable npm entry point.

### Fixed

- Normalize cross-provider tool-call IDs before sending them to Kiro. OpenAI Responses persists compound IDs such as `call_…|fc_…` that exceed Kiro's 64-character limit and contain an unsupported pipe, which previously wedged a session with `400 REQUEST_BODY_INVALID` after switching models. Native Kiro IDs remain unchanged, while remapped tool uses and results retain the same deterministic ID ([#137](https://github.com/mikeyobrien/pi-provider-kiro/pull/137)).
- Profile discovery now continues probing the remaining canonical management regions after a regional 403 on ListAvailableProfiles, instead of aborting on the primary region. A region-mismatched token whose profile lives in another canonical region (e.g. us-east-1 token, eu-central-1 profile) previously surfacing `ListAvailableProfiles failed in <region>: 403 Forbidden` now resolves correctly ([#131](https://github.com/mikeyobrien/pi-provider-kiro/issues/131)). A 403 on every region is still rethrown so credential refresh/retry paths (#107) engage for genuine auth failures.
- Refresh credentials from the credential's own auth family. The refresh cascade previously handed an IdC session a social account's token (a different identity with a different profile ARN) and returned always-IdC Kiro IDE credentials for social sessions; every source lookup is now filtered by the credential's derived auth family ([#142](https://github.com/mikeyobrien/pi-provider-kiro/pull/142)).
- Bound Kiro response header waits and coordinate request throttles, so a stalled response no longer hangs a turn indefinitely ([#136](https://github.com/mikeyobrien/pi-provider-kiro/pull/136)).

## [0.10.1] - 2026-08-24

### Fixed

- Carry the profile ARN through the IDC kiro-cli token path and add a `KIRO_PROFILE_ARN` environment override with highest precedence, so users with multiple Kiro profiles can pin the one they want instead of silently getting the first profile's reduced model catalog ([#110](https://github.com/mikeyobrien/pi-provider-kiro/issues/110)). Every profile resolution source (env / provided / network) is debug-logged as `profile.resolve`.
- Recover tool calls emitted as XML-dialect markup in assistant text for models that fall back to that dialect, instead of surfacing the markup as visible text ([#125](https://github.com/mikeyobrien/pi-provider-kiro/pull/125)).
- Stop logging capacity retries to stderr; retry accounting still happens, the console noise does not ([#116](https://github.com/mikeyobrien/pi-provider-kiro/pull/116)).
- Resolve a missing Kiro profile when the SSO-derived API region is wrong ([#104](https://github.com/mikeyobrien/pi-provider-kiro/issues/104)). `ListAvailableProfiles` is regional to where the profile actually lives, not to the login region, so a token whose profile is in `us-east-1` while the SSO region maps to `eu-central-1` returned `{ profiles: [] }` and the provider gave up. Profile resolution now probes both `us-east-1` and `eu-central-1` when the primary region comes back empty, caches the result, and routes `ListAvailableModels` to the region where the profile was found. The failure message now lists every attempted region and directs the user to `kiro-cli whoami` when the profile cannot be reached in any canonical region.
- Preserve every literal `<thinking>`, ` thinking`, `<reasoning>`, or `<thought>` region in one streamed response as its own thinking block instead of leaking every region after the first into visible assistant text.
- Keep parsed thinking blocks in the order the wire delivered them instead of splicing them ahead of text already emitted. The parser moved a thinking block into the index of an existing text block to make the content array read thinking → text, which made the persisted array contradict the stream and reused one `contentIndex` for two different blocks — an index-addressed consumer such as pi-mono's proxy transport overwrote the text it had already placed and then threw on the following `text_end`. Empty tagged regions are still materialized. Presentation order is unaffected: outbound history still prepends every thinking block, and renderers drive thinking from stream events.

## [0.10.0] - 2026-08-16

### Fixed

- Stop flattening reasoning into the assistant text channel. `buildHistory` prepended `<thinking>…</thinking>` onto `assistantResponseMessage.content`, writing literal markup into the string the model reads back as its own prior speech — a dialect this provider invented outbound and then parsed back out again inbound in `thinking-parser.ts`. First-party Kiro Agent's `extractTextContent` type-filters to `text` blocks, so it never emits that markup. Structured `toolUses` are untouched. A turn whose only block was reasoning is now retained with `content: ""` rather than dropped: dropping it would collapse the surrounding user turns together and break `ALTERNATING_MESSAGES`. Residual divergence, stated rather than implied — first-party does not discard reasoning, it carries it in a typed `assistantResponseMessage.reasoningContent` field; this change reaches parity on the text channel only. Both flatten sites are covered: `buildHistory` for history turns, and the current-message assistant branch in `stream.ts`, which pushes its own `armContent` into the same `assistantResponseMessage.content` and so reaches the wire identically. The current-turn site needs no reasoning-only guard — `currentMsgStartIdx` increments past an assistant that declares no `toolCall`, so reaching that branch means one exists and the entry cannot be dropped for having empty content.
- Repair malformed tool structure before sending instead of only warning about it. Observed 2026-08-14: two concurrent tool executions interleaved into one transcript produced `assistant(toolUses=[A]) / user(text) / assistant(toolUses=[B]) / user(toolResults=[A])`, Kiro answered `400 … tool_use ids were found without tool_result blocks immediately after: <B>`, and because the retry resent byte-identical history the session was terminally wedged. `prepareHistory` could not see it — `sanitizeHistory` tests tool pairing by position, not by id, and `injectSyntheticToolCalls` only rescues orphaned results — so `streamKiro` now runs `repairKiroConversation` on the whole conversation (history plus the current message) and sends the repaired bytes. Two limits are deliberate and pinned by tests: a result displaced from its issuing tool use is discarded rather than relocated, because preserving it would require either reordering conversation chronology or putting the same `toolUseId` on the wire twice, neither of which is probed; and `ALTERNATING_MESSAGES` is not repaired, because this provider documents that the API accepts non-alternating history. The warning now describes what survived repair rather than what the input contained.
- Relocate a displaced tool result rather than discarding it, superseding the first of the two limits above. `relocateDisplacedToolResults` moves each result to sit immediately after the assistant turn that issued its call, matched by id, applied before anything positional runs. It is a pure reorder: nothing is fabricated, nothing is dropped, a result whose call appears nowhere is left in place for `injectSyntheticToolCalls`, and a well-formed transcript is returned unchanged. On the interleaved shape above, `A`'s real output now reaches the wire paired with `A` where it was previously stripped, and `B` is still answered synthetically — relocation changes which output is preserved, not how much is fabricated. It also supersedes the second limit for this shape: with the result moved behind its call the interjection merges into that carrier entry rather than following it, so one user entry carries both `A`'s real result and the user's verbatim text and all seven rules pass. Two costs, both pinned: wire chronology shifts, because the interjection was said before `A`'s result arrived but appears after it; and the same change closes a latent defect it exposed — `buildHistory`'s user-merge branch joined with an unconditional `\n\n`, which was harmless while carriers held prose but sent `"\n\ncontinue"` for a user who typed `continue` once carriers hold `content: ""`. Only non-empty sides are joined now.
- Stop injecting `"Tool results provided."` into tool-result turns. A tool turn's payload is `userInputMessageContext.toolResults`; Kiro's requirement is content **or** tool results, so its `content` is now empty. Previously every tool turn shipped that sentence as a user utterance — and the merge path appended it onto the text of a message the user had actually written. Wire-probed against `runtime.us-east-1.kiro.dev` with `origin: "KIRO_CLI"`: `content: ""` plus populated `toolResults` returns HTTP 200. Matches first-party Kiro Agent, which ships `content: ''` on synthesized and consolidated tool turns.
- Send a placeholder instead of an empty `content` when a turn carries no text, and stop reporting Kiro's generic "Improperly formed request." rejection as a context overflow. A host that appends a message whose role falls outside pi-ai's `Message` union produced `content: ""`, which Kiro rejects with `400 REQUEST_BODY_INVALID`; relabeling that as `context_length_exceeded` then drove the caller into a compaction loop against a request that was structurally invalid rather than oversized. Also covers image-only and empty-text user messages. That fallback is now scoped to turns with no tool results, so it cannot refill a tool turn.

### Added

- `src/history-validator.ts` (F11): the seven conversation invariants first-party Kiro Agent enforces, ported to this provider's request shape — `STARTS_WITH_USER_MESSAGE`, `ENDS_WITH_USER_MESSAGE`, `ALTERNATING_MESSAGES`, `TOOL_USES_AND_RESULTS`, `TOOL_RESULTS_AND_NO_USES`, `TOOL_RESULTS_ORPHAN_IDS`, `NON_EMPTY_USER_MESSAGE`. Re-exported from the extension entry module (`src/index.ts` → `dist/index.js`) as `validateKiroConversation`, `validateKiroToolStructure`, `repairKiroConversation`, `kiroConversationEntries`, `KiroValidationRule`, `KIRO_VALIDATION_MESSAGES`, `KIRO_TOOL_STRUCTURE_RULES`, `isKiroToolStructureRule`, and `SYNTHETIC_FAILED_TOOL_RESULT_TEXT`. Note that this is the extension entry, not a resolvable npm entry point: `package.json` declares no `main`, `exports`, or `types` and the build emits no declarations, so a bare `import { validateKiroConversation } from "pi-provider-kiro"` does not resolve from the published tarball. Making that surface a public API is a packaging change and is deliberately out of scope here. `streamKiro` repairs the conversation before sending and warns about any violation that survives repair; it does not throw, because failing closed would change behavior for callers whose histories send today. The `TOOL_RESULTS_AND_NO_USES` check also covers a tool-result carrier with no assistant predecessor at all — kiro-agent's sanitizer drops that shape before validating, but this provider can send one as the current message, where `prepareHistory` cannot reach it.
- The entry module also re-exports `EMPTY_CONTENT_PLACEHOLDER` and the `KiroHistoryEntry` / `KiroUserInputMessage` / `KiroToolResult` / `KiroToolUse` types, under the same entry-point caveat as above.

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

[Unreleased]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/mikeyobrien/pi-provider-kiro/compare/v0.9.3...v0.10.0
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
