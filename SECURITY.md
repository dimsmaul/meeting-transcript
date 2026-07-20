# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Use GitHub's **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
  (Security tab → "Report a vulnerability"), or
- Contact the maintainer directly.

Include: affected version/commit, reproduction steps, impact, and any suggested
fix. Expect an initial acknowledgement within a few days.

## Supported versions

This is an early-stage project. Only the latest published version receives
fixes.

## Scope

In scope:

- The extension code (Rust/WASM engine, service worker, content script, popup)
- The build/release pipeline (`scripts/`, `.github/workflows/`)

Out of scope:

- Google Meet itself and its DOM (third-party; we only read it)
- Store-side infrastructure (Chrome Web Store, AMO, Edge Add-ons)

## Privacy & responsible use (read this)

This extension captures and stores **spoken content from meeting participants**.
That carries privacy and, in some jurisdictions, legal obligations that no code
change can remove:

- **Consent**: recording/transcribing conversations may require the consent of
  other participants. Rules differ by jurisdiction (one-party vs all-party
  consent). Obtaining consent is the **user's responsibility**.
- **No hidden capture**: the extension surfaces an active-recording indicator.
  Do not modify the build to hide it.
- **Local-only data**: transcripts are stored in `chrome.storage.local` and
  exported on the user's device. The extension performs **no telemetry and no
  upload**. Phase 1 sends nothing off-device; the optional Phase 3 STT runs
  locally (Whisper WASM) and likewise stays on-device.
- **Model weights** (Phase 3, if enabled) are fetched from a public CDN on first
  use and cached locally. No transcript data leaves the device during that
  fetch.

If you distribute a fork, keep these guarantees or document clearly where your
fork diverges.
