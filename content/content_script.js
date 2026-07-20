// Content script — runs inside the Google Meet tab.
// Two jobs: (a) scrape Meet's built-in captions, (b) fallback observer for the
// active-speaker indicator.
//
// ⚠️ THE SELECTORS BELOW ARE PLACEHOLDERS. Meet's obfuscated classes (.zsA40 etc.)
// change periodically. They MUST be verified against live Meet during Phase 0.
// Priority: semantic selectors (role/aria/data-*) first, obfuscated class last.
const SELECTORS = {
  captionRegion: '[aria-label*="aption"], [jsname][role="region"]',
  captionRow: ':scope > div',
  captionSpeaker: '[data-speaker-name], .zs7s8d',
  captionText: '[jsname="tgaKEf"], .iTTPOb',
  speakingActive: '[data-is-speaking="true"]',
  speakingName: '[data-self-name], [data-participant-name]',
};

let observing = false;

// Health-check: if we are observing but no caption has been captured for a
// while, the selectors are likely stale (Meet DOM changed) or captions (CC)
// are off. See PRD R1 / FEASIBILITY R1.
const STALE_AFTER_MS = 60_000;
const HEALTH_TICK_MS = 15_000;
let lastCaptionAt = 0;
let healthTimer = null;
let reportedStale = false;

// (a) Scraper for Meet's built-in captions.
const captionObserver = new MutationObserver(() => {
  const region = document.querySelector(SELECTORS.captionRegion);
  if (!region) return;
  region.querySelectorAll(SELECTORS.captionRow).forEach((row) => {
    const speaker = row.querySelector(SELECTORS.captionSpeaker)?.textContent?.trim() ?? '';
    const text = row.querySelector(SELECTORS.captionText)?.textContent?.trim() ?? '';
    if (!text) return;
    lastCaptionAt = Date.now();
    if (reportedStale) {
      reportedStale = false;
      chrome.runtime.sendMessage({ type: 'HEALTH', state: 'ok' });
    }
    chrome.runtime.sendMessage({
      type: 'CAPTION_LINE',
      speaker,
      text,
      ts: new Date().toISOString(),
    });
  });
});

// (b) Fallback: the "currently speaking" indicator, used to fill in the name
// when a caption row does not carry one.
let lastActiveSpeaker = '';
const speakingObserver = new MutationObserver(() => {
  const active = document.querySelector(SELECTORS.speakingActive);
  if (!active) return;
  const name = active.querySelector(SELECTORS.speakingName)?.textContent?.trim();
  if (name && name !== lastActiveSpeaker) {
    lastActiveSpeaker = name;
    chrome.runtime.sendMessage({ type: 'SPEAKER_CHANGED', name });
  }
});

function startObserving() {
  if (observing) return;
  observing = true;
  lastCaptionAt = Date.now();
  reportedStale = false;
  captionObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  speakingObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-is-speaking'],
  });
  healthTimer = setInterval(() => {
    if (!observing || reportedStale) return;
    if (Date.now() - lastCaptionAt > STALE_AFTER_MS) {
      reportedStale = true;
      chrome.runtime.sendMessage({ type: 'HEALTH', state: 'stale' });
    }
  }, HEALTH_TICK_MS);
}

function stopObserving() {
  if (!observing) return;
  observing = false;
  captionObserver.disconnect();
  speakingObserver.disconnect();
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_TRANSCRIPTION') {
    startObserving();
    sendResponse({ ok: true, observing });
  } else if (msg.type === 'STOP_TRANSCRIPTION') {
    stopObserving();
    sendResponse({ ok: true, observing });
  } else if (msg.type === 'PING') {
    sendResponse({ ok: true, observing });
  }
});
