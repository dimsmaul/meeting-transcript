// Local Whisper STT via Transformers.js + ONNX Runtime Web (vendored in
// lib/vendor/). Runs fully on-device; the model is downloaded from Hugging Face
// on first use and cached by the browser.
//
// ⚠️ NOT verifiable offline — MV3 CSP / worker / wasm paths need browser
// testing. If it fails on load, the console error tells us what to fix.
import { pipeline, env } from '../../lib/vendor/transformers.min.js';
import { send } from '../../lib/messaging.js';

// Everything is vendored on disk with the extension: the ORT wasm binaries and
// the model weights themselves (scripts/vendor-model.sh). Local weights survive
// an extension Remove and need no network. Remote stays enabled purely as a
// fallback for builds shipped without the bundled model.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/vendor/ort/');
env.backends.onnx.wasm.numThreads = 1; // no SharedArrayBuffer in extension pages
env.allowLocalModels = true;
env.allowRemoteModels = true; // fallback only — local is tried first
env.localModelPath = chrome.runtime.getURL('lib/vendor/models/');

// onnx-community models are the maintained builds for Transformers.js v3/v4 —
// their quantized weights load correctly on the ORT wasm backend.
const MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

export class WhisperLocal {
  constructor(config = {}) {
    this.modelId = MODELS[config.model] || MODELS.base;
    this.language = config.language || null;
    this.kind = 'local:whisper';
    this.pipe = null;
    this.loggedOpts = false;
  }

  // onProgress(p) is optional; also broadcasts progress for the side panel.
  async load(onProgress) {
    send({ type: 'DIAG', msg: `whisper: ${this.modelId} dtype=q8 (graph-opt off)` });
    if (this.modelId === MODELS.small) {
      send({
        type: 'DIAG',
        msg: 'whisper-small often stalls building its session on wasm — switch to base in Settings if nothing transcribes',
      });
    }
    // q8 (int8) for both graphs — the well-supported wasm path, and what
    // scripts/vendor-model.sh downloads (*_quantized.onnx). fp32 is ~3× larger
    // and stalls session creation in wasm.
    this.pipe = await pipeline('automatic-speech-recognition', this.modelId, {
      dtype: 'q8',
      device: 'wasm',
      // The wasm build's QDQ optimizer chokes on the block-quantized embedding
      // ("TransposeDQWeightsForMatMulNBits — missing required scale"). That step
      // is an optimization, not a requirement, so turn graph optimization off and
      // run the graph as authored.
      session_options: { graphOptimizationLevel: 'disabled' },
      progress_callback: (p) => {
        try {
          onProgress?.(p);
        } catch {}
        if (p.status === 'done') {
          console.info('[Speaky] whisper file loaded:', p.file, '— building session…');
        }
        if (p.status === 'progress' && typeof p.progress === 'number') {
          send({
            type: 'MODEL_PROGRESS',
            file: p.file,
            pct: Math.round(p.progress),
          });
        }
      },
    });
    // progress_callback never emits a 'ready' status (initiate/download/
    // progress/done only), so readiness is announced here — once the session
    // is actually built.
    send({ type: 'MODEL_READY' });
    return true;
  }

  // samples: Float32Array, mono, 16 kHz (one VAD phrase segment).
  async transcribe(samples) {
    if (!this.pipe) return '';
    // Prove once what the decoder is actually told. Without an explicit
    // language Whisper warns "No language specified - defaulting to English"
    // and translates instead of transcribing — invisible unless logged.
    if (!this.loggedOpts) {
      this.loggedOpts = true;
      send({
        type: 'DIAG',
        msg: `decode opts: language=${this.language ?? 'AUTO (will default to English)'} task=transcribe`,
      });
    }
    const out = await this.pipe(samples, {
      task: 'transcribe',
      language: this.language || undefined,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    return (out?.text ?? '').trim();
  }
}
