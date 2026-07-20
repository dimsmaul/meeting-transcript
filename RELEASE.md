# Release & CI/CD

Automatic publishing to extension stores via GitHub Actions. Trigger = **push to `main`**. The version is determined automatically from commit messages — no manual tagging.

## Versioning (automatic, from commit messages)

On every push to `main`, the workflow reads the commits since the last tag (conventional commits), computes the new version, creates a tag + GitHub Release, then builds & publishes — all in a single run.

| Commit prefix | Bump | Channel | Example |
|---|---|---|---|
| `fix:` / `perf:` | **patch** | stable | `0.1.0` → `0.1.1` |
| `feat:` | **minor** | stable | `0.1.0` → `0.2.0` |
| `feat!:` / `fix!:` / body contains `BREAKING CHANGE:` | **major** | stable | `0.1.0` → `1.0.0` |
| `fix(beta):` / `perf(beta):` | patch | **beta** | `0.1.0` → `0.1.1-beta.1` |
| `feat(beta):` | minor | **beta** | `0.1.0` → `0.2.0-beta.1` |
| `feat(beta)!:` | major | **beta** | `0.1.0` → `1.0.0-beta.1` |
| `chore:` `docs:` `refactor:` `ci:` `test:` / others | **no release** | — | version does not bump, workflow skips |

- **The version logic lives in `scripts/next-version.sh`** (not the workflow) — testable locally: `bash scripts/next-version.sh`.
- **No "bump version" commit.** `manifest.json` in the repo stays `0.1.0`; the real version is injected at build time (`scripts/package.sh`).
- If one push contains multiple commits, the highest bump wins (a `feat:` + `fix:` → minor).
- Emergency release with no releasing commit: **Actions → Release → Run workflow** (`workflow_dispatch`).

### Beta / prerelease channel

Mark a commit with the **`(beta)` scope** to cut a prerelease instead of a stable release. The commit type still sets the bump level; the scope only changes the channel.

```bash
git commit -m "feat(beta): experimental markdown export"
git push origin main
# → v0.2.0-beta.1, GitHub PRE-release, stores NOT touched
git push origin main   # another fix(beta): ...
# → v0.2.0-beta.2
```

- **Beta publishes to a GitHub *pre-release* only** — no Chrome/Edge/Firefox store submission (the `publish-*` jobs are gated to `channel == 'stable'`). Testers download the zip and load it unpacked.
- **Beta number auto-increments** (`beta.1`, `beta.2`, …) against the same target base version.
- **Promotion**: if a batch pushed to `main` contains **any** non-`(beta)` releasing commit, the whole release promotes to **stable** (e.g. `feat(beta):` + `fix:` → `0.2.0` stable). To keep it beta, keep every releasing commit `(beta)`-scoped.
- **Manifest version**: browsers reject SemVer prerelease strings, so a beta build writes a numeric `manifest.version` (`0.2.0-beta.3` → `0.2.0.3`) while the zip name and git tag keep the full `-beta.N`.

### How to release

Just merge/push to `main` with a correctly prefixed commit message:

```bash
git commit -m "fix: dedup duplicate captions on partial update"
git push origin main
# → the workflow creates tag v0.1.1, builds, and publishes automatically
```

`chore:`/`docs:` commits do not trigger a release — safe for non-product changes.

## Targets & auto-publish status

| Store | Job | Status | Notes |
|---|---|---|---|
| Chrome Web Store | `publish-chrome` | ✅ auto | Brave gets it automatically (uses the Chrome Web Store). |
| Edge Add-ons | `publish-edge` | ✅ auto | |
| Firefox (AMO) | `publish-firefox` | ✅ auto | A manifest variant is generated (`background.scripts`, gecko id). Needs manual verification the first time. |
| Opera | — | ⚠️ manual | Limited upload API; use the chromium zip from the GitHub Release. |
| Safari | — | ❌ manual | Requires Xcode + macOS + `safari-web-extension-converter` + Apple Dev ($99/yr). Out of auto scope. |

Each publish job **skips itself** when its main secret is empty — safe to run before every store is configured.

## Required secrets

Set them under **repo → Settings → Secrets and variables → Actions**.

### Chrome (`chrome-webstore-upload-cli`)
| Secret | Source |
|---|---|
| `CHROME_APP_ID` | Extension ID on the Chrome Web Store |
| `CHROME_CLIENT_ID` | Google Cloud OAuth client |
| `CHROME_CLIENT_SECRET` | Google Cloud OAuth |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token (scope `chromewebstore`) |

### Edge (Add-ons API)
| Secret | Source |
|---|---|
| `EDGE_PRODUCT_ID` | Partner Center product ID |
| `EDGE_CLIENT_ID` | API credential |
| `EDGE_API_KEY` | API key |

### Firefox (AMO API)
| Secret | Source |
|---|---|
| `AMO_JWT_ISSUER` | addons.mozilla.org → API keys |
| `AMO_JWT_SECRET` | addons.mozilla.org → API keys |

## Developer accounts (one-time prerequisite)

| Store | Cost | Link |
|---|---|---|
| Chrome Web Store | $5 once | chrome.google.com/webstore/devconsole |
| Edge Add-ons | Free | partner.microsoft.com |
| Firefox AMO | Free | addons.mozilla.org/developers |
| Safari (optional) | $99/year | developer.apple.com |

## What cannot be fully automated

- **Store review**: Chrome/Edge/Firefox have an initial manual review (hours to days). Auto-publish submits; go-live still waits for approval.
- **First submission**: the listing (description, icon, screenshots, privacy policy) must be created manually in the dashboard once. The API only updates subsequent version packages.
- **Safari**: no publish API; requires Xcode + manual submission.

## CI (non-release)

`ci.yml` runs on every push/PR to `main`: `cargo fmt --check`, `clippy -D warnings`, and builds a zip for every target as an artifact (7-day retention). It does not publish.
