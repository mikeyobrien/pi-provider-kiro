# pi-provider-kiro launch pack — 2026-04-16

## Status snapshot

`main` is launch-clean again and ready for a new package release. The CI/build blocker caused by bundling `@mariozechner/pi-tui` has been fixed on `main`, and this release prep branch cuts the next package version from that repaired state.

## Verified facts

- npm package live before this release: `pi-provider-kiro@0.5.1`
- npm dist-tag before this release: `latest -> 0.5.1`
- current release candidate version: `0.5.2`
- latest GitHub release before this release: `v0.5.1`
- launch-readiness fix merged on `main`: PR `#49`, merge commit `1b0cfa0`
- latest `main` CI after the fix: success (`24521221133`)
- local release validation target: `npm ci`, `npm run build`, `npm run check`, `npm run lint`, `npm test`, and `npm pack --dry-run`
- current model surface: 19 models across 8 families/categories, including `minimax-m2-5` and `auto`

## What ships in v0.5.2

- Fix the build so `npm ci` / CI no longer fail when `prepare` runs the bundle step
- Keep `@mariozechner/pi-tui` external so native `koffi` binaries are not inlined into the release bundle
- Ship the refreshed README/package metadata that now match the real 19-model login and model surface

## Remaining caveats / blockers

- The release is not done until the `Publish` workflow triggered by `v0.5.2` finishes successfully.
- npm registry verification after publish is a hard gate; do not treat the GitHub release alone as success.

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

- [x] Commit and push the launch-prep branch
- [x] Open PR and get CI green
- [x] Merge to `main`
- [x] Confirm latest `main` CI is green
- [ ] Cut `v0.5.2` release + verify npm publish
- [ ] Post launch thread with repo + npm links

## Likely Q&A replies

**Does this require Kiro CLI?**
No for Builder ID. Google/GitHub social login delegates to `kiro-cli`, and existing `kiro-cli` credentials can be reused automatically.

**Is this free?**
The provider is MIT and the listed Kiro models are positioned here as free through Kiro.

**What’s the easiest starting point?**
`pi install npm:pi-provider-kiro`, then `/login kiro`, then `/model auto`.
