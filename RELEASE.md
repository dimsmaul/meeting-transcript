# Release & CI/CD

Automatic publishing to extension stores via GitHub Actions. Trigger = **push to `main`**. The version is determined automatically from commit messages — no manual tagging.

## Versioning (automatic, from commit messages)

On every push to `main`, the workflow reads the commits since the last tag (conventional commits), computes the new version, creates a tag + GitHub Release, then builds & publishes — all in a single run.

| Commit prefix | Bump | Example |
|---|---|---|
| `fix:` / `perf:` | **patch** | `0.1.0` → `0.1.1` |
| `feat:` | **minor** | `0.1.0` → `0.2.0` |
| `feat!:` / `fix!:` / body contains `BREAKING CHANGE:` | **major** | `0.1.0` → `1.0.0` |
| `chore:` `docs:` `refactor:` `ci:` `test:` / others | **no release** | version does not bump, workflow skips |

- **The mapping is editable** in `release.yml` → job `version` → the `custom_release_rules` input.
- **No "bump version" commit.** `manifest.json` in the repo stays `0.1.0`; the real version is injected at build time (`scripts/package.sh`).
- If one push contains multiple commits, the highest bump wins (a `feat:` + `fix:` → minor).
- Emergency release with no releasing commit: **Actions → Release → Run workflow** (`workflow_dispatch`).

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
