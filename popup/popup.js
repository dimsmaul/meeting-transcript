const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const previewEl = $('preview');

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', warn);
}

async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

// --- Transcript source: the live JSON flushed to storage by the worker ---

async function loadLines() {
  const { live_transcript } = await chrome.storage.local.get('live_transcript');
  if (!live_transcript) return [];
  try {
    return JSON.parse(live_transcript);
  } catch {
    return [];
  }
}

function shortTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function renderPreview(lines) {
  previewEl.replaceChildren();
  const recent = lines.slice(-40);
  for (const l of recent) {
    const div = document.createElement('div');
    div.className = 'line';
    const spk = document.createElement('span');
    spk.className = 'spk';
    spk.textContent = `${l.speaker}: `;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = shortTime(l.timestamp);
    div.append(spk, document.createTextNode(l.text + ' '), ts);
    previewEl.appendChild(div);
  }
  previewEl.scrollTop = previewEl.scrollHeight;
}

// --- Export formatters ---

function toTxt(lines) {
  return lines.map((l) => `[${shortTime(l.timestamp)}] ${l.speaker}: ${l.text}`).join('\n');
}

function toMd(lines) {
  const header = `# Meeting transcript\n\n`;
  const body = lines
    .map((l) => `- **${l.speaker}** _(${shortTime(l.timestamp)})_: ${l.text}`)
    .join('\n');
  return header + body + '\n';
}

function download(content, ext, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `meet-transcript-${Date.now()}.${ext}`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAs(kind) {
  const lines = await loadLines();
  if (lines.length === 0) {
    setStatus('No transcript yet', true);
    return;
  }
  if (kind === 'json') download(JSON.stringify(lines, null, 2), 'json', 'application/json');
  else if (kind === 'txt') download(toTxt(lines), 'txt', 'text/plain');
  else if (kind === 'md') download(toMd(lines), 'md', 'text/markdown');
  setStatus(`Exported ${lines.length} lines as ${kind.toUpperCase()}`);
}

// --- Controls ---

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

$('export-json').onclick = () => exportAs('json');
$('export-txt').onclick = () => exportAs('txt');
$('export-md').onclick = () => exportAs('md');

$('reset').onclick = async () => {
  await send('RESET');
  renderPreview([]);
  setStatus('Reset — transcript cleared');
};

// --- Live refresh while the popup is open ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.live_transcript) {
    renderPreview(JSON.parse(changes.live_transcript.newValue || '[]'));
  }
});

(async () => {
  const [{ count, health } = {}, lines] = await Promise.all([send('STATUS'), loadLines()]);
  renderPreview(lines);
  if (health === 'stale') {
    setStatus('No captions detected — is CC on? Selectors may be stale.', true);
  } else if (count) {
    setStatus(`${count} lines saved`);
  }
})();
