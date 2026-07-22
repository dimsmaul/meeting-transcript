import init, { TranscriberManager } from '../pkg/meet_transcriber.js';
import { BUILD } from '../lib/config.js';

console.info(`[Speaky] service worker build ${BUILD}`);

// storage.session keeps the armed tab across MV3 worker restarts. Fall back to
// storage.local if session is unavailable, so arming never silently breaks.
const sessionStore = chrome.storage?.session ?? chrome.storage?.local;

let manager;

// chrome:// / edge:// / extension pages cannot be captured.
const isCapturable = (url = '') => /^https?:\/\//.test(url) || url.startsWith('file://');

// --- Arming (RC3/RC4) -------------------------------------------------------
// Clicking the toolbar icon grants activeTab for that tab, which chrome.tabCapture
// requires. We persist only the TAB ID in storage.session (survives MV3 worker
// restarts) and request a fresh stream id on every Start — stream ids are
// single-use, so they must never be cached.

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action?.onClicked.addListener(async (tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (!isCapturable(tab.url)) {
    console.warn(`[Speaky] tab not capturable (${tab.url}) — not armed`);
    await sessionStore.remove('armed');
    return;
  }
  await sessionStore.set({
    armed: { tabId: tab.id, title: tab.title ?? '', url: tab.url },
  });
  console.info(`[Speaky] capture armed for tab ${tab.id} (${tab.url})`);
});

async function getArmed() {
  const { armed } = await sessionStore.get('armed');
  return armed ?? null;
}

// --- WASM transcript state --------------------------------------------------

const ready = (async () => {
  await init();
  manager = new TranscriberManager();
  const { live_transcript } = await chrome.storage.local.get('live_transcript');
  if (live_transcript) manager.load_from_json(live_transcript);
})();

let health = 'idle'; // 'idle' | 'waiting' | 'ok' | 'stale'

function setHealth(state) {
  health = state;
  if (state === 'stale') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Meet-only: the caption scraper is an enhancer, not the backbone.
// It must follow the ARMED tab — audio comes from there, so picking the active
// Meet tab instead paired audio from one meeting with captions from another.
const isMeet = (url = '') => url.startsWith('https://meet.google.com/');

async function getMeetTab() {
  const armed = await getArmed();
  if (!armed) return undefined;
  try {
    // Read the LIVE url: the tab may have navigated into a meeting after arming.
    const tab = await chrome.tabs.get(armed.tabId);
    return isMeet(tab.url) ? tab : undefined;
  } catch {
    return undefined; // armed tab closed
  }
}

// --- Offscreen document + handshake (RC2) -----------------------------------

async function offscreenReady() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
    return res?.ready === true;
  } catch {
    return false; // no listener yet
  }
}

async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio (and optionally the microphone) for recording and transcription.',
    });
  }
  // createDocument resolves before offscreen.js finishes evaluating, so poll
  // until its message listener is actually registered.
  for (let i = 0; i < 50; i++) {
    if (await offscreenReady()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('offscreen document did not become ready');
}

async function startAudioPipeline() {
  const armed = await getArmed();
  console.info('[Speaky] START_AUDIO; armed =', armed?.tabId ?? null);
  if (!armed) {
    return {
      ok: false,
      error: 'Not armed — click the Speaky toolbar icon on the tab you want to capture.',
    };
  }
  try {
    // A tab that isn't playing anything yields an empty recording — warn early
    // instead of letting the user discover it after pressing Stop.
    let silent = false;
    try {
      const live = await chrome.tabs.get(armed.tabId);
      silent = live.audible === false;
      if (silent) console.warn(`[Speaky] armed tab is not playing audio: ${live.url}`);
    } catch {
      /* tab may have closed; getMediaStreamId will surface it */
    }

    // Fresh stream id every Start (single-use).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: armed.tabId });
    await ensureOffscreen();
    console.info('[Speaky] offscreen ready, sending CONNECT_AUDIO');
    // Never wait forever on the offscreen document — surface a hang as an error.
    const ack = await Promise.race([
      chrome.runtime.sendMessage({ type: 'CONNECT_AUDIO', streamId }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('offscreen did not respond within 15s')), 15_000),
      ),
    ]);
    console.info('[Speaky] CONNECT_AUDIO ack =', JSON.stringify(ack));
    if (!ack?.ok) return { ok: false, error: ack?.error ?? 'offscreen did not acknowledge' };
    return { ok: true, tab: armed, silent };
  } catch (e) {
    console.error('[Speaky] startAudioPipeline error:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

async function stopAudioPipeline() {
  // Do NOT close the offscreen document here — that revokes the recording's
  // blob URL before the download completes. It stays idle and gets reused.
  try {
    const ack = await chrome.runtime.sendMessage({ type: 'DISCONNECT_AUDIO' });
    return { ok: true, saved: ack?.saved ?? false };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- Messaging (RC5: only keep the channel open when we actually reply) -----

const REPLIES = new Set([
  'START_TRANSCRIPTION',
  'STOP_TRANSCRIPTION',
  'START_AUDIO',
  'STOP_AUDIO',
  'DOWNLOAD_AUDIO',
  'EXPORT',
  'STATUS',
  'RESET',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Fire-and-forget messages: handle without holding the channel open.
  if (!REPLIES.has(message?.type)) {
    (async () => {
      await ready;
      switch (message?.type) {
        case 'CAPTION_LINE':
          manager.add_line(message.ts, message.speaker, message.text);
          await chrome.storage.local.set({ live_transcript: manager.get_all_json() });
          if (health !== 'ok') setHealth('ok');
          break;
        case 'HEALTH':
          setHealth(message.state);
          break;
        case 'SPEAKER_CHANGED':
          manager.set_speaker(message.name);
          break;
      }
    })();
    return false;
  }

  (async () => {
    await ready;
    switch (message.type) {
      case 'START_TRANSCRIPTION':
      case 'STOP_TRANSCRIPTION': {
        const tab = await getMeetTab();
        if (tab) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: message.type });
          } catch {
            sendResponse({ ok: false, error: 'content_script_not_ready' });
            return;
          }
        }
        setHealth(message.type === 'START_TRANSCRIPTION' && tab ? 'waiting' : 'idle');
        sendResponse({ ok: !!tab, error: tab ? undefined : 'no_meet_tab' });
        break;
      }

      case 'START_AUDIO': {
        const res = await startAudioPipeline();
        if (res.ok) setHealth('waiting');
        sendResponse(res);
        break;
      }

      case 'STOP_AUDIO':
        sendResponse(await stopAudioPipeline());
        break;

      // User-initiated save. The offscreen document holds the recording; it is
      // never written to disk unless this arrives.
      case 'DOWNLOAD_AUDIO':
        try {
          if (!(await chrome.offscreen.hasDocument())) {
            sendResponse({ saved: false, error: 'Nothing recorded yet — press Start first.' });
            break;
          }
          sendResponse(await chrome.runtime.sendMessage({ type: 'DOWNLOAD_AUDIO' }));
        } catch (e) {
          sendResponse({ saved: false, error: String(e?.message || e) });
        }
        break;

      case 'EXPORT':
        sendResponse({ json: manager.get_all_json(), count: manager.len() });
        break;

      case 'STATUS':
        sendResponse({ count: manager.len(), health, armed: await getArmed() });
        break;

      case 'RESET':
        manager.reset();
        await chrome.storage.local.remove('live_transcript');
        setHealth('idle');
        sendResponse({ ok: true });
        break;
    }
  })();
  return true; // async reply pending
});
