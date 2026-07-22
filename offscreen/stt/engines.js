// STT engines behind one interface: transcribe(Float32 16k mono) → string.
//
//   - cloud (openai): OpenAI-compatible /audio/transcriptions (OpenAI, Groq,
//     LM Studio, most proxies). Widest "URL + key" standard.
//   - cloud (deepgram): Deepgram /v1/listen prerecorded.
//   - local: Whisper via Transformers.js + ONNX Runtime Web (whisper-local.js).
//
// NOTE: STT endpoints only. LLM APIs (Claude, OpenRouter, plain chat models)
// have no speech-to-text endpoint and will NOT work here.
import { pcmToWav } from './wav.js';

const SAMPLE_RATE = 16000;

function openAiCompatible(cfg) {
  return {
    kind: 'cloud:openai',
    async transcribe(samples) {
      const form = new FormData();
      form.append('file', pcmToWav(samples, SAMPLE_RATE), 'audio.wav');
      form.append('model', cfg.model || 'whisper-1');
      if (cfg.language) form.append('language', cfg.language);
      form.append('response_format', 'json');

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return (data.text ?? '').trim();
    },
  };
}

function deepgram(cfg) {
  return {
    kind: 'cloud:deepgram',
    async transcribe(samples) {
      const url = new URL(cfg.url || 'https://api.deepgram.com/v1/listen');
      url.searchParams.set('model', cfg.model || 'nova-2');
      url.searchParams.set('smart_format', 'true');
      if (cfg.language) url.searchParams.set('language', cfg.language);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${cfg.apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: pcmToWav(samples, SAMPLE_RATE),
      });
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
    },
  };
}

// Create an engine from config. Returns { kind, transcribe(samples) } or null
// for the 'captions' source (which does not use the audio pipeline).
export async function createEngine(config) {
  if (config.source === 'captions') return null;

  if (config.source === 'local') {
    const { WhisperLocal } = await import('./whisper-local.js');
    const eng = new WhisperLocal(config.local);
    await eng.load();
    return eng;
  }

  if (config.source === 'cloud') {
    const c = config.cloud;
    if (!c.apiKey) throw new Error('Cloud STT selected but no API key set (Options).');
    return c.format === 'deepgram' ? deepgram(c) : openAiCompatible(c);
  }

  throw new Error(`Unknown STT source: ${config.source}`);
}
