import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const SOURCE_HINTS = {
  captions: 'Reads Google Meet\'s on-screen captions (Meet only). No audio captured.',
  cloud: 'Captures the active tab\'s audio (any site) and transcribes via your provider. Highest accuracy.',
  local: 'On-device Whisper (base by default, ~80 MB), any tab. Private, no cloud. Download once below; not real-time.',
};

// Sensible endpoint defaults per provider format.
const FORMAT_DEFAULTS = {
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
  deepgram: { url: 'https://api.deepgram.com/v1/listen', model: 'nova-2' },
};

function applySourceUI() {
  const src = $('source').value;
  document.body.dataset.source = src;
  $('source-hint').textContent = SOURCE_HINTS[src] ?? '';
}

$('source').addEventListener('change', applySourceUI);

$('format').addEventListener('change', () => {
  const d = FORMAT_DEFAULTS[$('format').value];
  if (d && !$('url').value) $('url').value = d.url;
  if (d && !$('model').value) $('model').value = d.model;
});

// Mic permission must be requested from a real extension page — an offscreen
// document cannot show the prompt (see ROOT_CAUSE.md RC1).
async function refreshMicState() {
  const el = $('mic-state');
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    el.textContent =
      status.state === 'granted'
        ? 'granted ✓'
        : status.state === 'denied'
          ? 'denied — reset it in site settings'
          : 'not granted yet';
  } catch {
    el.textContent = '';
  }
}

$('grant-mic').onclick = async () => {
  const el = $('mic-state');
  el.textContent = 'requesting…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
    el.textContent = 'granted ✓';
  } catch (e) {
    el.textContent = `denied: ${e.message || e}`;
  }
};

function flashSaved() {
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 1500);
}

// The side panel writes local.language too. Building the config purely from
// this form would overwrite whatever was set there with this page's stale
// select, so always merge onto what is actually stored right now.
async function patchLocal(patch) {
  const cur = await loadConfig();
  await saveConfig({ ...cur, local: { ...cur.local, ...patch } });
  flashSaved();
}

// The model/language selects apply immediately — requiring a separate Save
// click made a changed model look like it was ignored at the next Start.
$('local-model').addEventListener('change', () => patchLocal({ model: $('local-model').value }));
$('local-language').addEventListener('change', () =>
  patchLocal({ language: $('local-language').value }),
);

$('save').onclick = async () => {
  const cur = await loadConfig();
  const cfg = {
    ...cur,
    source: $('source').value,
    captureMic: $('captureMic').checked,
    cloud: {
      format: $('format').value,
      url: $('url').value.trim() || FORMAT_DEFAULTS[$('format').value].url,
      apiKey: $('apiKey').value,
      model: $('model').value.trim() || FORMAT_DEFAULTS[$('format').value].model,
      language: $('language').value.trim(),
    },
    // local.* is deliberately NOT written here. Those selects save themselves
    // on change (patchLocal), and the side panel writes local.language too —
    // submitting this form's copy would reset a language chosen elsewhere.
    local: cur.local,
  };
  // Cloud fetch needs host permission for the endpoint (this click is the
  // required user gesture).
  if (cfg.source === 'cloud') {
    try {
      const origin = new URL(cfg.cloud.url).origin + '/*';
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        $('source-hint').textContent = 'Permission for that endpoint was denied — cloud STT will be blocked.';
      }
    } catch {
      $('source-hint').textContent = 'Invalid endpoint URL.';
      return;
    }
  }

  await saveConfig(cfg);
  flashSaved();
};

// Explicit, upfront model download (so the big fetch isn't hidden behind Start).
$('download-model').onclick = async () => {
  const btn = $('download-model');
  const prog = $('dl-progress');
  const fill = $('dl-fill');
  btn.disabled = true;
  prog.textContent = 'Loading runtime…';
  try {
    const { WhisperLocal } = await import('../offscreen/stt/whisper-local.js');
    const eng = new WhisperLocal({ model: $('local-model').value });
    await eng.load((p) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        fill.style.width = `${p.progress}%`;
        prog.textContent = `Downloading ${p.file ?? ''} — ${Math.round(p.progress)}%`;
      } else if (p.status === 'done') {
        prog.textContent = 'Finalizing…';
      }
    });
    fill.style.width = '100%';
    prog.textContent = 'Model ready ✓ — cached, no re-download needed.';
  } catch (e) {
    prog.textContent = `Failed: ${e.message || e}`;
  } finally {
    btn.disabled = false;
  }
};

(async () => {
  const cfg = await loadConfig();
  $('source').value = cfg.source;
  $('format').value = cfg.cloud.format;
  $('url').value = cfg.cloud.url;
  $('apiKey').value = cfg.cloud.apiKey;
  $('model').value = cfg.cloud.model;
  $('language').value = cfg.cloud.language;
  $('local-model').value = cfg.local.model;
  $('local-language').value = cfg.local.language ?? '';
  $('captureMic').checked = cfg.captureMic;
  applySourceUI();
  refreshMicState();
})();
