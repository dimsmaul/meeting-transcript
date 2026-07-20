# Meet Live Transcriber (Rust/WASM)

A Chrome/Brave extension — real-time Google Meet transcription with speaker names via caption scraping. See [PRD.md](PRD.md) + [FEASIBILITY.md](FEASIBILITY.md).

**Status:** Phase 1 scaffold. DOM selectors are still placeholders — verify against live Meet (Phase 0) before use.

## Build

```bash
# Prerequisites: rustup (present), wasm-pack (NOT installed yet)
cargo install wasm-pack

# Compile Rust → WASM (output to pkg/)
wasm-pack build --target web --out-dir pkg
```

## Install in the browser

1. `chrome://extensions/` or `brave://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select this repo folder

## Usage

1. Open Google Meet, **turn on Captions (CC)**.
2. Click the extension icon → **Start**.
3. When the meeting ends → **Export JSON**.

## Structure

| Path | Function |
|---|---|
| `src/lib.rs` | Rust engine — transcript state, dedup, JSON serialization |
| `content/content_script.js` | Caption scraper + speaker observer (selectors in the `SELECTORS` object) |
| `background/service_worker.js` | Message router, storage flush, hydrate on SW restart |
| `popup/` | Start/stop/export UI |
| `pkg/` | wasm-pack output (auto-generated, gitignored) |

## Notes

- **No Whisper/AI in Phase 1** — STT is handled by Meet captions (Google). Whisper WASM only enters the optional Phase 3 (see PRD §5.7).
- Meet selectors change periodically → if the transcript stops, update the `SELECTORS` object in `content/content_script.js`.

## Releasing

Versioning is automated from commit messages (conventional commits) — push to `main` triggers build + publish. See [RELEASE.md](RELEASE.md).

## License

[MIT](LICENSE) © Dimas Maulana Ahmad. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
