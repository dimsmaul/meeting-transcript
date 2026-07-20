# Feasibility Deep-Dive — Not Possible & Risks

Appendix to [PRD.md](PRD.md) §7. Each *not possible* item: root cause → alternative approach → recommendation. Each risk: root cause → approach solve.

---

## Section A — Not Possible (from original draft) + Alternative Approach

### N1 — Feed mixed audio into the Web Speech API

**Original draft claim:** tab audio + mic combined via the Web Audio API, then fed into `SpeechRecognition`.

**Root cause:** the Web Speech API specification never defined an input source. `SpeechRecognition` in Chrome is hard-wired to the **OS default microphone** — there is no property/parameter to hand it a `MediaStream`. The `MediaStreamTrack` produced by our mixing never touches its STT engine. This is a spec + implementation limitation, not a bug that can be worked around from JS.

**Alternative approaches:**

| Approach | How it works | Effort | Trade-off |
|---|---|---|---|
| **A. Caption scraping (chosen, Phase 1)** | Meet already transcribes all participants + names via its built-in captions. Scrape its DOM. | Low | Depends on Meet DOM + user must turn on CC. STT comes "for free from Google" indirectly. |
| **B. Whisper WASM (Phase 3)** | Mixed stream → `AudioWorklet` → PCM 16kHz → `whisper.cpp` WASM in-browser. Accepts any buffer. | High | Model 40–150 MB, CPU-heavy, latency 1–3 sec. But fully offline + private. |
| **C. Vosk / Moonshine WASM** | Same as B, lighter engine (Vosk ±50 MB, Moonshine smaller). | Medium-high | Indonesian accuracy below Whisper. Worth trying if Whisper is too heavy. |
| **D. Virtual audio device (BlackHole / VB-Cable)** | Route Meet audio → virtual device → set as OS default mic → Web Speech API "hears" everything. | Low (code), high (user) | Requires manual driver install per user + OS setting changes. Not viable as a product, OK as a personal hack. |
| **E. Cloud STT (Deepgram / AssemblyAI / Google STT)** | Mixed stream → WebSocket → cloud. Gets real acoustic diarization. | Medium | Conflicts with the "free" requirement. Limited free tier. Privacy leaves the device. |

**Recommendation:** A as the primary path; B as a fallback when captions are unavailable. D may be documented as a "power-user mode" without being made a product dependency.

---

### N2 — Web Speech API for long meeting sessions

**Original draft claim:** Web Speech is "100% free and accurate", auto-restart on `onend` is enough.

**Root cause:** two layers. (1) *Architecture*: in Chrome, audio is sent to Google's server — it requires internet, is not private, and Google imposes a session limit (auto-stop ±60 sec / on silence) because this is a free service with no SLA. (2) *Draft code*: `onend → start()` without a guard means the recognizer comes back to life even after the user presses Stop → infinite loop; and on each restart, audio during the restart gap (±300–800 ms) is lost → the start of sentences gets cut off.

**Alternative approaches:**

| Approach | How it works | Notes |
|---|---|---|
| **A. Don't use Web Speech at all (chosen)** | Caption path (N1-A) / Whisper (N1-B). | Eliminates this entire class of problems. |
| B. Guard flag + fast restart | `let intentionalStop = false;` → `onend: if (!intentionalStop) restart()`. Restarting in `onend` (not `onerror`) narrows the gap. | Fixes the loop bug only; gap loss + server limit remain. |
| C. Dual recognizer overlap | Two instances alternating: start the second instance before the first is stopped → no gap. | Hacky, Chrome sometimes refuses two active recognizers; audio can be double-counted. Not recommended. |

**Recommendation:** A. If Web Speech is ever still used (mic-only, personal notes mode), B is mandatory.

---

### N3 — `sender.tab.id` on a START message from the popup

**Root cause:** `sender.tab` is only populated when the message sender is a **content script in a tab**. A popup/extension page is not a tab context — `sender.tab === undefined`, and accessing `.id` throws. The original draft assumed all messages come from a tab.

**Alternative approaches:**

| Approach | How it works |
|---|---|
| **A. Explicit query (chosen, already in PRD §5.5)** | `chrome.tabs.query({ active: true, currentWindow: true, url: 'https://meet.google.com/*' })` in the service worker. |
| B. Popup sends its own tab id | Popup calls `chrome.tabs.query` then includes `tabId` in the message payload. Equivalent to A, just moves where the query happens. |
| C. Content script initiates START | User clicks an in-page overlay button → message comes from the content script → `sender.tab.id` is valid. Useful if we later want an in-meeting UI. |

**Recommendation:** A. C becomes a Phase 2+ UX option (floating button on the Meet page).

---

### N4 — Precise diarization from `data-is-speaking` for STT output

**Root cause:** two different clocks that are never synchronized. The DOM indicator lights up *while* a person is speaking (real-time), whereas STT text comes out **1–3 seconds after** the utterance ends (batch decode). By the time the text arrives, the "active speaker" in the DOM may already be the next person. Add overlapping speech: two indicators lit at once → no ground truth for who spoke which text. This is a temporal alignment problem, not a selector bug.

**Alternative approaches:**

| Approach | How it works | Quality |
|---|---|---|
| **A. Not needed (chosen for the primary path)** | Meet captions already carry a name per line — Google resolves the alignment server-side. | High precision. |
| **B. Speaker timeline buffer (for Phase 3)** | Store `SPEAKER_CHANGED` events as a timeline `[{name, t_start}]`. When STT text arrives with its audio duration, attribute it to the speaker dominant in the window `[t_text - duration, t_text]`, not the current speaker. | Best-effort, far better than "last speaker". |
| **C. Per-channel STT** | Don't mix. Run 2 Whisper instances: one for the mic (= always "Me"), one for the tab (= other participants, disambiguated via B). | "Me vs others" becomes 100% accurate; the rest stays best-effort. CPU cost 2×. |
| D. Acoustic diarization (pyannote-class model) | Voice embedding per segment → speaker clustering. | Too heavy for in-browser WASM right now. Skip. |

**Recommendation:** A for Phase 1. A combination of **B + C** if Phase 3 is undertaken.

---

### N5 — Transcript state surviving MV3 service-worker idle-kill

**Root cause:** by-design MV3 — Chrome kills the service worker ±30 sec after it goes idle to save resources. All in-memory state (including the `TranscriberManager` WASM instance) is destroyed. The original draft kept history only in WASM memory → the transcript is lost every time the worker dies.

**Alternative approaches:**

| Approach | How it works | Notes |
|---|---|---|
| **A. Write-through + hydrate (chosen, PRD §5.5)** | Each `CAPTION_LINE` is flushed immediately to `chrome.storage.local`. When the worker wakes, reconstruct `TranscriberManager` from `live_transcript`. | Most in line with the MV3 idiom. Requires a `load_from_json()` method in Rust. |
| B. Move state to the content script | The content script lives as long as the tab. WASM is loaded in the content script, the worker only relays. | Valid, but state dies on tab reload/meeting rejoin. A is still needed as a backup. |
| C. Offscreen document as state holder | The offscreen document outlives the worker. | Keeping an offscreen document permanently alive for the caption path = wasted resources; the offscreen document can also be closed by Chrome. |
| D. Keepalive hack (alarm / port ping every 20 sec) | Prevent the worker from dying. | Fights the platform, Chrome is increasingly aggressive at closing this loophole. Don't. |

**Recommendation:** A. B optional as an optimization (reduce write frequency), still with A behind it.

---

### N6 — Meet DOM selectors permanently stable

**Root cause:** Meet classes are the output of Google's obfuscation compiler (`.zsA40`, `.iTTPOb`) — they change on every Google release build with no changelog. Not a public API; there is no stability contract.

**Alternative approaches:**

| Approach | How it works | Resilience |
|---|---|---|
| **A. Semantic selectors first, class last (chosen)** | Priority: `role`/`aria-label`/`data-*` (relatively stable, Google's own a11y requirement) → then fall back to obfuscated classes. | Many times more resilient than class-only. |
| **B. Centralization + health-check (chosen)** | All selectors in a single `SELECTORS` object; monitor "CC active but 0 captions within 60 sec" → UI warning. | Turns a silent fail into a visible failure + a 1-file fix. |
| C. Remote selector config | Extension fetches selector JSON from a gist/server → updates without re-releasing. | Effective, but remote-code-adjacent (needs careful Web Store review) + requires infra. Defer. |
| D. Structural heuristic | Find the element whose text changes rapidly in the lower screen region (caption pattern) without a specific selector. | Robust but prone to false positives. Research only. |

**Recommendation:** A + B (in Phase 1–2). C only if the project is used long-term by more than 1 person.

---

## Section B — Risks: Root Cause & Approach Solve

### R1 — Google changes the Meet DOM, scraper dies suddenly

- **Root cause:** identical to N6 — dependency on a third party's internal markup with no contract. The *when* cannot be predicted (Google releases Meet periodically, sometimes A/B tested per account — selectors can differ between users at the same time).
- **Impact:** transcription stops without an error in the middle of a meeting; the user only realizes after the meeting ends. This is the worst impact — *silent data loss*.
- **Approach solve:**
  1. **Detection** — runtime health-check: if the observer is active + CC is on + 0 `CAPTION_LINE` for 60 sec → red badge on the extension icon + a warning in the popup ("captions not detected, selectors may be stale").
  2. **Localization** — all selectors in a single `SELECTORS` object (PRD §5.4); a patch = edit 1 file, reload the extension.
  3. **Layered defense** — semantic selectors (aria/role/data-*) as primary (N6-A) reduce the frequency of occurrence.
  4. **Recovery** — data already captured stays safe (write-through N5-A); only what is lost is from the moment the selector broke.

### R2 — Overlapping speech / rapid speaker changes → wrong name attribution

- **Root cause:** identical to N4 — temporal misalignment between DOM events and STT output, plus overlap = inherent ambiguity (one audio segment, two speakers).
- **Impact:** transcript lines with the wrong name on the alternative path (Phase 3). The primary path is unaffected (names come from Meet captions).
- **Approach solve:**
  1. Phase 1: nothing needed — use the caption path.
  2. Phase 3: speaker timeline buffer (N4-B) + per-channel mic/tab STT (N4-C).
  3. Mark confidence: lines resulting from window-overlap attribution get an `"attribution": "estimated"` field in the JSON, so data consumers know which ones are certain.

### R3 — ToS & privacy: transcribing participants' speech without their knowledge

- **Root cause:** the extension runs quietly on one participant's side; the other participants get no signal at all (unlike Meet's built-in recording feature, which shows a notification to everyone). Regulations on recording conversations differ per jurisdiction (one-party vs all-party consent); Google's ToS also restrict automated extraction.
- **Impact:** ethical/legal risk to the user; risk of rejection if submitted to the Chrome Web Store.
- **Approach solve:**
  1. **Product scope**: explicitly set "personal use, self-hosted, not published to the Web Store" — eliminates store review risk.
  2. **Local transparency**: clear visual indicator when transcription is active (icon badge + a small banner via content script) so that at minimum the user is aware they are recording.
  3. **Usage policy**: document in the README that the user is responsible for obtaining participant consent per local rules. This is a liability mitigation, not a technical mitigation — there is no full technical solution to this risk.
  4. **Local data only**: no telemetry/upload — reduces the privacy surface (already by-design).

### R4 — Whisper model size (40–150 MB) burdens the bundle & load

- **Root cause:** local STT needs a large neural model; MV3 also restricts resource size & source (strict CSP, cannot fetch-and-eval remote code — but *model weights* are not code, they may be fetched).
- **Impact:** Phase 3 only. Slow first-run, RAM rises ±300–500 MB during inference, weak laptops struggle.
- **Approach solve:**
  1. **Lazy download**: the model is NOT bundled in the extension. Fetch from the Hugging Face CDN the first time the user enables audio mode, with a progress bar.
  2. **Persistent cache**: store weights in OPFS (Origin Private File System) — download once, use forever.
  3. **Tiered models**: default `tiny` (±40 MB, fast), `base`/`small` options for accuracy. Benchmark first in a Phase 0 spike before committing.
  4. **Graceful degradation**: if the device can't cope (detected via decode-time > realtime), show a suggestion to fall back to the caption path.

---

## Decision Summary

| Item | Decision |
|---|---|
| N1, N2 | Web Speech API crossed out. Caption scraping primary, Whisper WASM backup. |
| N3 | Explicit `tabs.query` — already in PRD §5.5. |
| N4, R2 | Phase 1 free of this problem; Phase 3 uses timeline buffer + per-channel STT + `estimated` flag. |
| N5 | Write-through storage + hydrate — mandatory in Phase 2. |
| N6, R1 | Semantic selectors + centralization + health-check — Phase 1–2. |
| R3 | Personal use only + active indicator + consent as the user's responsibility. |
| R4 | Lazy download + OPFS cache + `tiny` model default — only if Phase 3 goes ahead. |
