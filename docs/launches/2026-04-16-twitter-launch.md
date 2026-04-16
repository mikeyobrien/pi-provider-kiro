# pi-provider-kiro launch pack — 2026-04-16

## Status snapshot

Launch surface is close, but `main` is not currently launch-clean because the latest CI run fails during `npm ci`.

This prep pass fixes that blocker locally by excluding `@mariozechner/pi-tui` from the release bundle, and refreshes the public docs so the README/package metadata match the current product surface.

## Verified facts

- npm package live: `pi-provider-kiro@0.5.1`
- npm dist-tag: `latest -> 0.5.1`
- latest GitHub release: `v0.5.1`
- latest remote commit before this prep pass: `1f799cc feat(login): interactive login with all sign-in methods and native TUI (#41)`
- latest CI run on `main` before this prep pass: failed in `npm ci` because `prepare` triggered an esbuild bundle that tried to inline `koffi` native binaries from `@mariozechner/pi-tui`
- local validation after the fix: `npm run build`, `npm run check`, `npm run lint`, `npm test`, and `npm pack --dry-run`
- current model surface: 19 models across 8 families/categories, including `minimax-m2-5` and `auto`

## What changed in this prep pass

- Fixed the build script so CI no longer tries to bundle `@mariozechner/pi-tui`
- Updated README first-screen copy and quick start
- Updated model table to reflect the live 19-model surface
- Added `auto` and `minimax-m2-5` to public docs
- Updated package description metadata
- Added changelog notes for the unreleased launch-prep fixes

## Remaining caveats / blockers

- The fix still needs to be committed, pushed, and merged before the repo is truly launch-ready.
- A fresh GitHub Actions green run on the fix branch should be treated as a hard pre-launch gate.
- If you want to launch a new version rather than just the repo, cut a release only after the CI fix lands on `main`.

## Recommended launch angle

Position this as the cleanest way to use Kiro’s free model surface from pi:

- free model menu with one install command
- cleaner auth story than hand-rolled setup
- region-aware filtering and Kiro-specific retry/stream handling
- supports Builder ID, org SSO, Google, and GitHub sign-in

## Primary post draft

pi users: I shipped a Kiro provider that gives pi one clean bridge into Kiro’s free model surface.

`pi-provider-kiro` gives you 19 models across Claude, Qwen, DeepSeek, GLM, Kimi, MiniMax, AGI Nova, and Auto — with Builder ID / org SSO / Google / GitHub login support and `kiro-cli` credential reuse.

Install:
```bash
pi install npm:pi-provider-kiro
```

Then:
```text
/login kiro
/model auto
```

Repo: https://github.com/mikeyobrien/pi-provider-kiro
npm: https://www.npmjs.com/package/pi-provider-kiro

## Optional thread draft

1. Kiro has a surprisingly good free model surface, but pi needed a clean provider bridge.
2. `pi-provider-kiro` handles auth, model resolution, region filtering, and streaming so it feels native inside pi.
3. It supports Builder ID, org SSO, Google, GitHub, and can reuse `kiro-cli` credentials if you already have them.
4. It now exposes 19 models, including `auto`, `minimax-m2-5`, Qwen3 Coder, and 1M-context options.
5. Install with `pi install npm:pi-provider-kiro` and log in with `/login kiro`.

## Demo order

1. Fresh install with `pi install npm:pi-provider-kiro`
2. `/login kiro`
3. Choose a login method from the new interactive menu
4. `/model auto`
5. Show a second switch to a named model like `/model claude-sonnet-4-6`

## Pre-flight checklist

- [ ] Commit and push the launch-prep branch
- [ ] Open PR and get CI green
- [ ] Merge to `main`
- [ ] Confirm latest `main` CI is green
- [ ] If shipping a new package version, cut release + verify npm publish
- [ ] Post launch thread with repo + npm links

## Likely Q&A replies

**Does this require Kiro CLI?**
No for Builder ID. Google/GitHub social login delegates to `kiro-cli`, and existing `kiro-cli` credentials can be reused automatically.

**Is this free?**
The provider is MIT and the listed Kiro models are positioned here as free through Kiro.

**What’s the easiest starting point?**
`pi install npm:pi-provider-kiro`, then `/login kiro`, then `/model auto`.
