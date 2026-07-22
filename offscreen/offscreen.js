import init, { AudioProcessor, SpeakerTimeline } from '../pkg/meet_transcriber.js';
import { loadConfig, BUILD } from '../lib/config.js';
import { send } from '../lib/messaging.js';
import { createEngine } from './stt/engines.js';

console.info(`[Speaky] offscreen build ${BUILD}`);

let audioCtx = null;
let workletNode = null;
let tabStream = null;
let micStream = null;

let processor = null;
let engine = null;
let timeline = null; // created after wasm init (SpeakerTimeline is a wasm export)

let takenSamples = 0; // 16 kHz samples consumed → audio clock (ms) = /16
let draining = false;

// Recording runs whenever the pipeline runs → downloadable file on stop.
let recorder = null;
let recordedChunks = [];
// Kept after Stop so "Download audio" can re-save the last session's file.
let lastRecordingUrl = null;

const wasmReady = init();

// Mirror every pipeline step to the side panel so diagnosing never requires
// hunting for the offscreen document's console.
function diag(msg) {
  console.info('[Speaky]', msg);
  send({ type: 'DIAG', msg });
}

// Registered immediately so the service worker's readiness ping succeeds as
// early as possible (RC2 handshake).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'OFFSCREEN_PING':
      sendResponse({ ready: true });
      return false;

    case 'CONNECT_AUDIO':
      connectAudio(message.streamId).then(
        () => sendResponse({ ok: true }),
        (e) => {
          console.error('[Speaky] connectAudio failed:', e?.message || e);
          sendResponse({ ok: false, error: String(e?.message || e) });
        },
      );
      return true;

    case 'DOWNLOAD_AUDIO':
      downloadRecording().then(
        (saved) => sendResponse({ saved }),
        (e) => sendResponse({ saved: false, error: String(e?.message || e) }),
      );
      return true;

    case 'DISCONNECT_AUDIO':
      disconnectAudio().then(
        (saved) => sendResponse({ saved }),
        () => sendResponse({ saved: false }),
      );
      return true;

    case 'SPEAKER_CHANGED': {
      // Mark on the SAME clock segments are attributed with (samples consumed
      // / 16). audioCtx.currentTime is a wall clock and drifts from it whenever
      // the context was suspended or worklet frames were dropped, which mapped
      // segments onto the wrong speaker.
      timeline?.mark(message.name, takenSamples / 16);
      return false;
    }

    default:
      return false;
  }
});

async function connectAudio(streamId) {
  await wasmReady;
  await disconnectAudio(); // idempotent

  const config = await loadConfig();
  // Stored settings survive an update, so a stale saved config (the old
  // 'captions' / 'small' defaults) silently overrides the new ones. Show what
  // is actually in effect instead of leaving it to guesswork.
  diag(
    `config: source=${config.source} model=${config.local?.model} ` +
      `lang=${config.local?.language || 'auto'} mic=${config.captureMic}`,
  );
  engine = null; // loaded in the background — must never block capture

  console.info('[Speaky] connectAudio: streamId =', streamId);
  audioCtx = new AudioContext();
  // An offscreen document has no user activation, so the context starts
  // suspended — nothing would flow and the recording would be empty.
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  diag(`AudioContext ${audioCtx.state} @ ${audioCtx.sampleRate} Hz`);
  processor = new AudioProcessor(audioCtx.sampleRate);
  timeline = new SpeakerTimeline();
  takenSamples = 0;
  droppedSegments = 0;

  // Tab audio: digital, lossless. This is the essential source and must succeed.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  const tracks = tabStream.getAudioTracks();
  if (!tracks.length) throw new Error('The captured tab exposes no audio track.');
  const t = tracks[0];
  diag(`tab track: state=${t.readyState} muted=${t.muted} enabled=${t.enabled}`);

  const srcTab = audioCtx.createMediaStreamSource(tabStream);
  const recordDest = audioCtx.createMediaStreamDestination();
  srcTab.connect(recordDest);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet');
  srcTab.connect(workletNode);

  // CRITICAL: loop tab audio back to the speakers, else tabCapture mutes the tab.
  srcTab.connect(audioCtx.destination);

  // Microphone is OPTIONAL (RC1). An offscreen document cannot show a permission
  // prompt, so a missing grant must never abort the capture — tab-only recording
  // still works (and is all that's needed for e.g. YouTube). Grant the mic from
  // the options page to include your own voice.
  if (config.captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const srcMic = audioCtx.createMediaStreamSource(micStream);
      srcMic.connect(recordDest);
      srcMic.connect(workletNode);
      console.info('[Speaky] mic stream OK');
    } catch (e) {
      micStream = null;
      console.warn('[Speaky] mic unavailable, continuing with tab audio only:', e?.message || e);
      send({ type: 'MIC_UNAVAILABLE', error: String(e?.message || e) });
    }
  }

  startRecording(recordDest.stream);
  workletNode.port.onmessage = (e) => onFrame(e.data);
  diag(`pipeline running, mic=${!!micStream}`);

  // Loading an STT engine can take a long time (a Whisper session build in
  // particular). It must NEVER sit in the capture path — recording starts now,
  // the engine attaches when it is ready.
  if (config.source !== 'captions') loadEngineInBackground(config);
}

async function loadEngineInBackground(config) {
  const sessionId = audioCtx; // capture identity; ignore if session changed
  try {
    console.info('[Speaky] loading STT engine:', config.source);
    send({ type: 'ENGINE_LOADING', source: config.source });
    const eng = await createEngine(config);
    if (audioCtx !== sessionId) return; // capture stopped/restarted meanwhile
    engine = eng;
    console.info('[Speaky] STT engine ready:', eng?.kind);
    send({ type: 'ENGINE_READY', kind: eng?.kind ?? null });
    await drainSegments();
  } catch (e) {
    console.error('[Speaky] STT engine failed:', e?.message || e);
    send({
      type: 'AUDIO_ERROR',
      error: `STT engine failed (recording still running): ${e?.message || e}`,
    });
  }
}

function startRecording(stream) {
  recordedChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  recorder = new MediaRecorder(stream, { mimeType: mime });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      recordedChunks.push(e.data);
      if (recordedChunks.length === 1) diag(`first chunk ${e.data.size} B — data flowing`);
    }
  };
  recorder.onerror = (e) => console.error('[Speaky] MediaRecorder error:', e.error);
  recorder.start(1000); // gather in 1 s slices
  diag(`recorder ${recorder.state} (${mime})`);
}

async function saveChunks(chunks) {
  const blob = new Blob(chunks, { type: chunks[0].type });
  const url = URL.createObjectURL(blob);
  diag(`saving recording ${Math.round(blob.size / 1024)} KB`);
  await chrome.downloads.download({
    url,
    filename: `speaky-audio-${Date.now()}.webm`,
    saveAs: false,
  });
  return url;
}

// Download on demand, without ending the session. While recording, flush the
// recorder first so the file includes everything captured up to this moment;
// once stopped, re-save the last session's blob.
async function downloadRecording() {
  if (recorder?.state === 'recording') {
    await new Promise((resolve) => {
      const onData = () => {
        recorder.removeEventListener('dataavailable', onData);
        resolve();
      };
      recorder.addEventListener('dataavailable', onData);
      recorder.requestData();
    });
  }
  if (recordedChunks.length) {
    const url = await saveChunks(recordedChunks);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    send({ type: 'AUDIO_SAVED' });
    return true;
  }
  if (lastRecordingUrl) {
    await chrome.downloads.download({
      url: lastRecordingUrl,
      filename: `speaky-audio-${Date.now()}.webm`,
      saveAs: false,
    });
    send({ type: 'AUDIO_SAVED' });
    return true;
  }
  send({ type: 'AUDIO_ERROR', error: 'Nothing recorded yet — press Start first.' });
  return false;
}

// Stop the recorder and KEEP the result in memory. Nothing is written to disk
// here — the file is only saved when "Download audio" is pressed.
// Returns true when a recording is available to download.
async function stopRecording() {
  if (!recorder) return false;
  if (recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
  }
  recorder = null;
  const totalBytes = recordedChunks.reduce((n, c) => n + c.size, 0);
  diag(`STOP: ${recordedChunks.length} chunk(s), ${totalBytes} B`);
  if (!recordedChunks.length) {
    diag('STOP: zero chunks — tab produced no sound');
    send({
      type: 'AUDIO_ERROR',
      error: 'The captured tab produced no sound. Play audio in that tab, then record again.',
    });
    return false;
  }

  // Hold the blob URL so the button can still save it after the session ends.
  if (lastRecordingUrl) URL.revokeObjectURL(lastRecordingUrl);
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type });
  recordedChunks = [];
  lastRecordingUrl = URL.createObjectURL(blob);
  diag(`recording ready: ${Math.round(blob.size / 1024)} KB — press Download audio`);
  send({ type: 'AUDIO_READY', kb: Math.round(blob.size / 1024) });
  return true;
}

// Keep at most this many phrase segments queued. The bound applies at all
// times, not only while the engine loads: local Whisper on wasm transcribes
// slower than realtime, so without it the queue grows for the whole meeting and
// the transcript silently falls minutes behind.
const MAX_PENDING_SEGMENTS = 60;

let droppedSegments = 0;

// Dropping must still advance the audio clock, otherwise every later segment
// (and every speaker mark) is timestamped as if the dropped audio never played.
function dropBacklog() {
  if (!processor) return;
  let dropped = 0;
  while (processor.segment_count() > MAX_PENDING_SEGMENTS) {
    takenSamples += processor.take_segment().length;
    dropped++;
  }
  if (!dropped) return;
  droppedSegments += dropped;
  diag(`backlog: dropped ${dropped} segment(s) (${droppedSegments} total) — STT can't keep up`);
}

async function onFrame(frame) {
  if (!processor) return;
  processor.push_samples(frame);
  if (engine) await drainSegments();
  dropBacklog();
}

// Not real-time: transcribe whole phrase-aligned segments as they complete.
async function drainSegments() {
  if (draining || !processor || !engine) return;
  draining = true;
  try {
    while (processor.has_segment()) {
      const startMs = takenSamples / 16;
      const seg = processor.take_segment();
      takenSamples += seg.length;
      const endMs = takenSamples / 16;

      let text = '';
      try {
        text = (await engine.transcribe(seg)).trim();
      } catch (e) {
        send({ type: 'AUDIO_ERROR', error: String(e.message || e) });
        continue;
      }
      if (!text) continue;

      const speaker = timeline?.attribute(startMs, endMs) || 'Unknown Speaker';
      send({
        type: 'CAPTION_LINE',
        speaker,
        text,
        ts: new Date().toISOString(),
      });
    }
  } finally {
    draining = false;
  }
}

async function disconnectAudio() {
  if (processor) processor.flush();
  if (engine) await drainSegments();
  const saved = await stopRecording();

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  for (const s of [tabStream, micStream]) s?.getTracks().forEach((t) => t.stop());
  tabStream = micStream = null;
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  processor = null;
  engine = null;
  timeline = null;
  return saved;
}
