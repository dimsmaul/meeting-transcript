# Root Cause Analysis & Recovery Plan

Why nothing currently works end-to-end (no transcript, no audio file), what is actually
broken in the code, and the plan to fix it — adjusted for the widened goal: capture audio
from **any tab** (Meet, Zoom, Teams, YouTube, …), not just Google Meet.

Status at time of writing: audio capture never completes, so every downstream feature
(recording, cloud STT, local Whisper) is blocked. Two of the causes below mask each other,
which is why the symptom looks like "nothing happens at all".

---

## 1. Root causes

### RC1 — Microphone permission cannot be prompted from an offscreen document (FATAL)

**Where:** [`offscreen/offscreen.js:49`](offscreen/offscreen.js#L49)

```js
micStream = await navigator.mediaDevices.getUserMedia({ audio: {...} });
```

An offscreen document has **no UI**, so Chrome cannot show a microphone permission prompt.
If the extension origin has not already been granted mic access, this call throws
`NotAllowedError`.

**Impact:** the throw happens *after* tab audio already succeeded, and aborts the rest of
`connectAudio()` — the `MediaRecorder` is created further down at line 61, so it never
starts. No recording, no file, no download, no STT. Tab capture itself was fine.

**Consequence for design:** the microphone must be **optional** (YouTube capture doesn't
need it at all), and its permission must be requested **once from a normal extension page**
(the options page), never from the offscreen document.

---

### RC2 — `CONNECT_AUDIO` race: message sent before the offscreen listener exists (FATAL)

**Where:** [`background/service_worker.js:83-85`](background/service_worker.js#L83-L85)

```js
await ensureOffscreen();
chrome.runtime.sendMessage({ type: 'CONNECT_AUDIO', streamId: ... });
```

`chrome.offscreen.createDocument()` resolves when the document is **created**, not when
`offscreen.js` has finished evaluating. `offscreen.js` is an ES module that imports the WASM
glue, the config helper and the STT engines; its `chrome.runtime.onMessage` listener is
registered only at the end of module evaluation.

`chrome.runtime.sendMessage` is fire-and-forget with no delivery guarantee and no retry, so
the message is silently dropped.

**Impact:** the offscreen document logs nothing, throws nothing, and does nothing. Start
appears to be a no-op. This matches the observed symptom exactly.

---

### RC3 — `pendingCapture` is lost when the service worker restarts (FATAL, intermittent)

**Where:** [`background/service_worker.js:11`](background/service_worker.js#L11)

```js
let pendingCapture = null; // module-level state
```

MV3 terminates the service worker after roughly 30 seconds of inactivity. The capture is
"armed" during the toolbar-icon click, but if the worker is killed before the user presses
Start, the variable is gone.

**Impact:** "Capture not armed. Click the Speaky toolbar icon…" even though the user just
clicked the icon. Non-deterministic, depends on how long they waited.

---

### RC4 — `streamId` is single-use

A stream id returned by `chrome.tabCapture.getMediaStreamId()` is consumed by the
`getUserMedia()` call that uses it. Arming once at icon-click can therefore only ever work
for the **first** Start; every Stop → Start cycle afterwards fails.

---

### RC5 — `return true` on every message hides real errors

**Where:** [`background/service_worker.js:171`](background/service_worker.js#L171)

The listener always returns `true` (keep channel open), but several branches
(`CAPTION_LINE`, `HEALTH`, `SPEAKER_CHANGED`) never call `sendResponse`. Chrome then logs
*"A listener indicated an asynchronous response by returning true, but the message channel
closed before a response was received"* for each one — noise that buries the genuine errors.

---

### RC6 — Architecture is hardcoded to Google Meet, but the goal is any tab

| Hardcoded to Meet | Where |
|---|---|
| `getMeetTab()` tab lookup | [`service_worker.js:58`](background/service_worker.js#L58) |
| `host_permissions` | [`manifest.json:8`](manifest.json#L8) |
| Content script `matches` | [`manifest.json:33`](manifest.json#L33) |
| Output filename `meet-audio-*.webm` | [`offscreen.js:106`](offscreen/offscreen.js#L106) |
| Product copy / description | `manifest.json`, side panel, options |

This blocks the stated goal (Zoom, Teams, YouTube, arbitrary tabs, plus a companion app
later).

---

### RC7 — Local Whisper session build hangs (downstream, not yet diagnosable)

The Transformers.js pipeline stalls at session creation. This cannot be meaningfully debugged
until the audio pipeline reliably delivers segments, so it is deliberately sequenced last.

---

## 2. Recovery plan

### Phase A — make audio capture actually work

Unblocks recording, cloud STT and local Whisper simultaneously.

1. **Microphone becomes optional.** Wrap the mic `getUserMedia` in its own `try/catch`; on
   failure log a warning and continue with tab audio only. The mic must never be able to
   abort the pipeline. Add an explicit "Include microphone" toggle (off by default for
   non-meeting captures).
2. **Grant mic permission from a real page.** Add a "Grant microphone access" button to the
   options page, which can legitimately show the prompt; the grant then applies to the
   offscreen document.
3. **Handshake before `CONNECT_AUDIO`.** The offscreen document posts `OFFSCREEN_READY` once
   its listener is registered; the service worker waits for it (with timeout + retry) before
   sending `CONNECT_AUDIO`. Alternatively switch the SW↔offscreen link to a
   `chrome.runtime.connect` port.
4. **Persist only the armed tab id, acquire the stream id fresh.** Store `armedTabId` in
   `chrome.storage.session` (survives worker restarts) and call `getMediaStreamId()` at each
   Start. Fixes RC3 and RC4 together.
5. **Return `true` only for branches that actually respond**, so real errors stop being
   buried.

### Phase B — decouple from Google Meet

6. **Tab picker in the side panel.** List capturable tabs via `chrome.tabs.query` and let the
   user choose the capture source; default to the tab the icon was clicked on.
7. **Generic naming and copy.** `speaky-audio-<timestamp>.webm`, and UI text that no longer
   assumes a meeting.
8. **Caption scraping is demoted to a Meet-only enhancer**, not the backbone. Zoom/Teams
   caption adapters can follow later behind the same centralized `SELECTORS` pattern used in
   [`content/content_script.js`](content/content_script.js).

### Phase C — restore STT, in dependency order

9. Prove recording works on a YouTube tab (guaranteed audio, no meeting required).
10. Cloud STT next — fastest to verify once an API key exists.
11. Local Whisper last: only then debug the session hang (model/dtype), against a pipeline
    already known to be sound.

### Phase D — later

Companion desktop app; Zoom/Teams caption adapters; capturing tab and microphone as separate
tracks to improve speaker attribution.

---

## 3. Verification

Run this once, on a **YouTube tab** (audio is guaranteed, no meeting setup needed):

1. Remove the extension, then Load unpacked again (a plain reload does not always pick up
   permission changes).
2. Open a YouTube video and play it.
3. Click the Speaky toolbar icon **on that tab** → side panel opens.
4. Press **Start**, wait ~10 seconds, press **Stop**.

Expected log chain — the last line that appears identifies the break point:

| Context | Expected line |
|---|---|
| Service worker | `[Speaky] capture armed for tab <id> (<url>)` |
| Service worker | `[Speaky] START_AUDIO; armed = true` |
| Service worker | `[Speaky] offscreen ready, sending CONNECT_AUDIO` |
| Offscreen | `[Speaky] connectAudio: streamId = …` |
| Offscreen | `[Speaky] tab audio stream OK` |
| Offscreen | `[Speaky] audio pipeline running …` |
| Offscreen | `[Speaky] saving audio recording, NN KB` |

Success criterion for Phase A: a `.webm` file lands in Downloads and plays back cleanly.
Only after that does STT work get resumed.
