import { loadConfig, saveConfig, BUILD } from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const previewEl = $('preview');
const toggleEl = $('toggle');
const recEl = $('rec');
const countEl = $('count');

let running = false;

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', warn);
}

function setRunning(on) {
  running = on;
  document.body.dataset.rec = on ? 'on' : 'off';
  recEl.textContent = on ? 'Recording' : 'Idle';
  toggleEl.textContent = on ? 'Stop capturing' : 'Start capturing';
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

// Stable accent color per speaker (readable in both themes).
function colorForSpeaker(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 65% 55%)`;
}

function renderEmpty() {
  previewEl.classList.add('empty');
  previewEl.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = '🦜';
  const msg = document.createElement('div');
  msg.textContent = running
    ? 'Listening… captions will appear here.'
    : 'No transcript yet. Arm a tab with the Speaky icon, then press Start.';
  wrap.append(big, msg);
  previewEl.appendChild(wrap);
}

function renderPreview(lines) {
  countEl.textContent = lines.length ? `${lines.length} lines` : '';
  if (!lines.length) {
    renderEmpty();
    return;
  }
  previewEl.classList.remove('empty');
  previewEl.replaceChildren();
  for (const l of lines.slice(-200)) {
    const line = document.createElement('div');
    line.className = 'line';

    const head = document.createElement('div');
    head.className = 'head';
    const spk = document.createElement('span');
    spk.className = 'spk';
    spk.textContent = l.speaker;
    spk.style.color = colorForSpeaker(l.speaker || '?');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = shortTime(l.timestamp);
    head.append(spk, ts);

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = l.text;

    line.append(head, txt);
    previewEl.appendChild(line);
  }
  previewEl.scrollTop = previewEl.scrollHeight;
}

// --- Export ---

function toTxt(lines) {
  return lines.map((l) => `[${shortTime(l.timestamp)}] ${l.speaker}: ${l.text}`).join('\n');
}

function toMd(lines) {
  return (
    '# Meeting transcript\n\n' +
    lines.map((l) => `- **${l.speaker}** _(${shortTime(l.timestamp)})_: ${l.text}`).join('\n') +
    '\n'
  );
}

function downloadFile(content, ext, mime) {
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
  if (!lines.length) return setStatus('Nothing to export yet', true);
  if (kind === 'json') downloadFile(JSON.stringify(lines, null, 2), 'json', 'application/json');
  else if (kind === 'txt') downloadFile(toTxt(lines), 'txt', 'text/plain');
  else if (kind === 'md') downloadFile(toMd(lines), 'md', 'text/markdown');
  setStatus(`Exported ${lines.length} lines as ${kind.toUpperCase()}`);
}

// --- Unified capture: captions + audio pipeline together ---

function renderArmed(armed) {
  const el = $('armed');
  if (!armed) {
    el.textContent = 'No tab armed — click the Speaky icon on the tab you want to capture.';
    return;
  }
  const label = armed.title || armed.url || `tab ${armed.tabId}`;
  el.textContent = `Capturing: ${label.length > 48 ? label.slice(0, 48) + '…' : label}`;
}

async function startCapture() {
  const cfg = await loadConfig();

  // The audio pipeline always runs: it records the armed tab to a downloadable
  // file (saved on Stop), whatever the transcript source is.
  const audio = await send('START_AUDIO');
  if (!audio?.ok) {
    setStatus(audio?.error ?? 'Audio capture failed', true);
    return;
  }
  renderArmed(audio.tab);

  // The captions source only exists on Google Meet. On any other site it can
  // never produce a line — say so instead of silently returning an empty list.
  const onMeet = (audio.tab?.url ?? '').startsWith('https://meet.google.com/');
  if (cfg.source === 'captions') {
    if (onMeet) {
      await send('START_TRANSCRIPTION');
    } else {
      addDiag('source=captions but this tab is not Google Meet → no transcript');
    }
  }

  setRunning(true);
  if (audio.silent) {
    setStatus('Recording, but that tab is silent — play audio in it or nothing is captured.', true);
  } else if (cfg.source === 'captions' && !onMeet) {
    setStatus('Recording audio. No transcript: switch source to Whisper or Cloud in Settings.', true);
  } else {
    setStatus(
      {
        captions: 'Recording audio + reading Meet captions (CC must be on)',
        cloud: 'Recording audio → cloud STT',
        local: 'Recording audio → local Whisper',
      }[cfg.source] ?? 'Recording…',
    );
  }
  renderPreview(await loadLines());
}

async function stopCapture() {
  setStatus('Stopping — saving audio recording…');
  const [, audio] = await Promise.all([send('STOP_TRANSCRIPTION'), send('STOP_AUDIO')]);
  setRunning(false);
  const { count } = (await send('STATUS')) ?? {};
  setStatus(
    audio?.saved
      ? `Stopped — ${count ?? 0} transcript lines. Audio ready — press Download audio.`
      : `Stopped — ${count ?? 0} transcript lines. No audio was captured.`,
    !audio?.saved,
  );
}

$('open-options').onclick = () => chrome.runtime.openOptionsPage();

// The language is read when the engine loads, i.e. at Start. Changing it while
// recording would silently do nothing, so restart the pipeline to apply it.
$('lang').onchange = async () => {
  const lang = $('lang').value;
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, local: { ...cfg.local, language: lang } });
  if (!running) {
    setStatus(lang ? `Language set to ${lang} — press Start.` : 'Language set to auto-detect.');
    return;
  }
  setStatus('Language changed — restarting capture to apply it…');
  await stopCapture();
  await startCapture();
};

// Guard against double-clicks kicking off two capture sessions.
let busy = false;
toggleEl.onclick = async () => {
  if (busy) return;
  busy = true;
  toggleEl.disabled = true;
  try {
    await (running ? stopCapture() : startCapture());
  } finally {
    busy = false;
    toggleEl.disabled = false;
  }
};

// Audio is never written to disk on its own — only this button saves it. Works
// mid-recording too (saves everything captured so far, without stopping).
$('download-audio').onclick = async () => {
  const btn = $('download-audio');
  btn.disabled = true;
  setStatus('Saving audio…');
  try {
    const res = await send('DOWNLOAD_AUDIO');
    setStatus(
      res?.saved ? 'Audio saved to Downloads ✓' : (res?.error ?? 'No recording to save'),
      !res?.saved,
    );
  } finally {
    btn.disabled = false;
  }
};

$('export-json').onclick = () => exportAs('json');
$('export-txt').onclick = () => exportAs('txt');
$('export-md').onclick = () => exportAs('md');

$('reset').onclick = async () => {
  await send('RESET');
  renderPreview([]);
  setStatus('Transcript cleared');
};

// --- Live refresh while the side panel is open ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.live_transcript) {
    renderPreview(JSON.parse(changes.live_transcript.newValue || '[]'));
  }
});

function addDiag(line) {
  const box = $('diag');
  const row = document.createElement('div');
  row.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  $('diag-box').open = true;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DIAG') addDiag(msg.msg);
  else if (msg.type === 'AUDIO_ERROR') {
    addDiag(`ERROR ${msg.error}`);
    setStatus(`Error: ${msg.error}`, true);
  }
  else if (msg.type === 'AUDIO_SAVED') setStatus('Audio recording saved to Downloads ✓');
  else if (msg.type === 'AUDIO_READY')
    setStatus(`Audio ready (${msg.kb} KB) — press Download audio to save it.`);
  else if (msg.type === 'MIC_UNAVAILABLE')
    setStatus('Recording tab audio only — grant microphone access in Settings.', true);
  else if (msg.type === 'ENGINE_LOADING') setStatus('Recording — loading speech engine…');
  else if (msg.type === 'ENGINE_READY') setStatus('Recording — speech engine ready, transcribing');
  else if (msg.type === 'MODEL_PROGRESS') setStatus(`Recording — loading model ${msg.pct}%`);
  else if (msg.type === 'MODEL_READY') setStatus('Recording — model ready');
});

$('build').textContent = `build ${BUILD}`;

(async () => {
  const [{ count, health, armed } = {}, lines, cfg] = await Promise.all([
    send('STATUS'),
    loadLines(),
    loadConfig(),
  ]);
  $('lang').value = cfg.local.language ?? '';
  setRunning(['waiting', 'ok', 'stale'].includes(health));
  renderArmed(armed);
  renderPreview(lines);
  if (health === 'stale') {
    setStatus('No captions detected — is CC on? Selectors may be stale.', true);
  } else if (count) {
    setStatus(`${count} lines saved`);
  }
})();
