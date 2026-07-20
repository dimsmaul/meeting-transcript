const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', warn);
}

async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

$('start').onclick = async () => {
  const res = await send('START_TRANSCRIPTION');
  if (res?.ok) setStatus('Recording — make sure captions (CC) are on in Meet');
  else if (res?.error === 'no_meet_tab') setStatus('Open a Google Meet tab first', true);
  else setStatus('Content script not ready — reload the Meet tab', true);
};

$('stop').onclick = async () => {
  await send('STOP_TRANSCRIPTION');
  const { count } = (await send('STATUS')) ?? {};
  setStatus(`Stopped — ${count ?? 0} lines saved`);
};

$('export').onclick = async () => {
  const { json, count } = (await send('EXPORT')) ?? {};
  if (!json || count === 0) {
    setStatus('No transcript yet', true);
    return;
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `meet-transcript-${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${count} lines`);
};

$('reset').onclick = async () => {
  await send('RESET');
  setStatus('Reset — transcript cleared');
};

// Refresh the count when the popup opens.
(async () => {
  const { count } = (await send('STATUS')) ?? {};
  if (count) setStatus(`${count} lines saved`);
})();
