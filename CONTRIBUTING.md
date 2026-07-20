# Contributing

Thanks for your interest in improving Meet Live Transcriber. This guide covers setup, the commit convention (which drives automatic versioning), and how changes get released.

## Prerequisites

- [Rust](https://rustup.rs/) toolchain (`rustup`)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) — `cargo install wasm-pack`
- A Chromium browser (Chrome/Brave/Edge) or Firefox for testing

## Local setup

```bash
git clone <repo-url>
cd meet-transcriber
wasm-pack build --target web --out-dir pkg
```

Then load the unpacked extension:

1. `chrome://extensions/` (or `brave://` / `edge://`) → enable **Developer mode**
2. **Load unpacked** → select the repo root

For Firefox, generate the variant first (`scripts/package.sh 0.0.0 firefox`) and load `dist/firefox/` via `about:debugging`.

## Project layout

See [README.md](README.md#structure). The architecture and design rationale live in [PRD.md](PRD.md); known limitations and rejected approaches are in [FEASIBILITY.md](FEASIBILITY.md). Read both before proposing a structural change.

## Commit messages (Conventional Commits — required)

Versioning and publishing are **fully automated from commit messages**. The prefix you use decides the release:

| Prefix | Effect | When |
|---|---|---|
| `fix:` | patch release (stable) | bug fix |
| `perf:` | patch release (stable) | performance improvement |
| `feat:` | minor release (stable) | new user-facing capability |
| `feat!:` / `fix!:` or `BREAKING CHANGE:` in body | major release (stable) | incompatible change |
| `feat(beta):` / `fix(beta):` / `perf(beta):` | prerelease (beta channel) | ship to testers first, GitHub pre-release only |
| `chore:` `docs:` `refactor:` `ci:` `test:` `style:` | no release | internal / non-product |

Examples:

```
fix: replace duplicated caption line on partial update
feat: add markdown export from the popup
docs: clarify Phase 3 audio pipeline caveats
feat!: change exported JSON schema to nested segments
feat(beta): experimental Whisper fallback (testers only)
```

**Beta channel**: the `(beta)` scope produces `X.Y.Z-beta.N` as a GitHub pre-release and does **not** submit to any store. A batch that mixes a plain `feat:`/`fix:` with `(beta)` commits promotes to a stable release. Full rules: [RELEASE.md](RELEASE.md#beta--prerelease-channel).

Keep the subject imperative and ≤ ~72 chars. Add a body only when the "why" isn't obvious. Full policy: [RELEASE.md](RELEASE.md).

## Before opening a PR

- `cargo fmt` (CI enforces `--check`)
- `cargo clippy --all-targets -- -D warnings` (CI enforces this)
- If you touched the DOM scraper, note which Meet selectors you verified and how (Meet's obfuscated classes change often).
- One logical change per PR. Don't bundle unrelated refactors.

## Selector changes

DOM selectors live centrally in the `SELECTORS` object in `content/content_script.js`. When Meet's markup shifts, update that object only — prefer semantic selectors (`role` / `aria-*` / `data-*`) over obfuscated class names.

## Release flow (maintainers)

Merging to `main` runs `.github/workflows/release.yml`, which computes the version, tags, builds, and publishes to configured stores. No manual tagging. See [RELEASE.md](RELEASE.md) for store secrets and account setup.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
