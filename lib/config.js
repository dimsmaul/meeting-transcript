// Build marker — shown in the side panel so a stale, cached extension build is
// immediately obvious without opening a console. Bump it with every change that
// must be reloaded.
export const BUILD = '2026-07-22g';

// Shared STT configuration, stored in chrome.storage.local (per-device, never
// synced — API keys must not leave this machine).
export const DEFAULT_CONFIG = {
  // Local Whisper is the default: it works on any tab. 'captions' only ever
  // produces lines on Google Meet with CC on, so as a default it silently
  // yielded an empty transcript everywhere else.
  source: 'local', // 'captions' | 'cloud' | 'local'
  // Tab audio is the primary source and always captured. The microphone is an
  // opt-in extra (your own voice in a meeting) — off by default so nothing ever
  // prompts for mic access unless it is explicitly wanted.
  captureMic: false,
  cloud: {
    format: 'openai', // 'openai' (OpenAI-compatible) | 'deepgram'
    url: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: '',
    model: 'whisper-1',
    language: '', // '' = auto-detect
  },
  local: {
    // base (~40 MB int8) is the largest model whose ONNX session actually
    // builds on the single-threaded wasm backend. small stalls session
    // creation — it stays selectable in Options for anyone willing to wait.
    model: 'base',
    // Whisper auto-detects per segment when this is empty, and on short VAD
    // phrases it guesses wrong — non-English audio comes back translated into
    // English. Setting the spoken language pins both detection and task.
    language: '', // '' = auto-detect
  },
};

const KEY = 'stt_config';

// Some contexts (audio worklets, library-spawned workers) have no extension
// APIs. Never throw there — fall back to defaults instead of breaking the caller.
function storage() {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

function merge(cfg) {
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    captureMic: cfg?.captureMic ?? DEFAULT_CONFIG.captureMic,
    cloud: { ...DEFAULT_CONFIG.cloud, ...(cfg?.cloud ?? {}) },
    local: { ...DEFAULT_CONFIG.local, ...(cfg?.local ?? {}) },
  };
}

export async function loadConfig() {
  const store = storage();
  if (!store) {
    console.warn('[Speaky] chrome.storage unavailable in this context — using defaults');
    return merge(null);
  }
  const { [KEY]: cfg } = await store.get(KEY);
  return merge(cfg);
}

export async function saveConfig(cfg) {
  const store = storage();
  if (!store) throw new Error('chrome.storage unavailable — cannot save settings');
  await store.set({ [KEY]: cfg });
}
