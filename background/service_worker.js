import init, { TranscriberManager } from '../pkg/meet_transcriber.js';

let manager;

// Init WASM + hydrate state from storage (MV3 idle-kill recovery, FEASIBILITY N5).
const ready = (async () => {
  await init();
  manager = new TranscriberManager();
  const { live_transcript } = await chrome.storage.local.get('live_transcript');
  if (live_transcript) manager.load_from_json(live_transcript);
})();

async function getMeetTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: 'https://meet.google.com/*',
  });
  return tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
            // Content script not injected yet (tab opened before the extension loaded).
            sendResponse({ ok: false, error: 'content_script_not_ready' });
            return;
          }
        }
        sendResponse({ ok: !!tab, error: tab ? undefined : 'no_meet_tab' });
        break;
      }

      case 'CAPTION_LINE': {
        manager.add_line(message.ts, message.speaker, message.text);
        await chrome.storage.local.set({ live_transcript: manager.get_all_json() });
        break;
      }

      case 'SPEAKER_CHANGED': {
        manager.set_speaker(message.name);
        break;
      }

      case 'EXPORT': {
        sendResponse({ json: manager.get_all_json(), count: manager.len() });
        break;
      }

      case 'STATUS': {
        sendResponse({ count: manager.len() });
        break;
      }

      case 'RESET': {
        manager.reset();
        await chrome.storage.local.remove('live_transcript');
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true; // keep the channel open for async sendResponse
});
