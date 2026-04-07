# Release Process

This project publishes to npm as [`pi-provider-kiro`](https://www.npmjs.com/package/pi-provider-kiro). Releases are triggered by GitHub Releases and automated via GitHub Actions.

## Versioning

Follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **patch** (0.4.x) — bug fixes
- **minor** (0.x.0) — new features, backward-compatible
- **major** (x.0.0) — breaking changes

## Steps

### 1. Prepare the release commit

Update the version in `package.json` and `package-lock.json`:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

Update `CHANGELOG.md` with a new section following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Add a compare link at the bottom of the file.

Commit:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): v<VERSION>"
git push
```

### 2. Tag and push

```bash
git tag v<VERSION>
git push origin v<VERSION>
```

### 3. Create a GitHub Release

Go to [Releases](https://github.com/mikeyobrien/pi-provider-kiro/releases) → **Draft a new release**:

- Select the `v<VERSION>` tag
- Title: `v<VERSION>`
- Copy the changelog section into the release notes
- Click **Publish release**

### 4. Automated publish

The [`publish.yml`](.github/workflows/publish.yml) workflow runs on `release: [published]` events. It:

1. Checks out the tagged commit
2. Runs `npm ci`
3. Runs type checking (`npm run check`) and tests (`npm test`)
4. Publishes to npm with `--provenance --access public`

No manual npm publish is needed.

## CI

The [`ci.yml`](.github/workflows/ci.yml) workflow runs on every push and PR to `main`:

- Type checking (`npm run check`)
- Linting (`npm run lint`)
- Tests (`npm test`)

## Pre-release checklist

- [ ] All tests pass (`npm test`)
- [ ] Type check passes (`npm run check`)
- [ ] Lint passes (`npm run lint`)
- [ ] `CHANGELOG.md` updated
- [ ] Version bumped in `package.json` / `package-lock.json`
