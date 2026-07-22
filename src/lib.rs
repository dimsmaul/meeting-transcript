use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConversationLine {
    pub timestamp: String,
    pub speaker: String,
    pub text: String,
}

#[wasm_bindgen]
pub struct TranscriberManager {
    history: Vec<ConversationLine>,
    active_speaker: String,
}

#[wasm_bindgen]
impl TranscriberManager {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TranscriberManager {
        TranscriberManager {
            history: Vec::new(),
            active_speaker: "Unknown Speaker".to_string(),
        }
    }

    pub fn set_speaker(&mut self, name: String) {
        if !name.trim().is_empty() {
            self.active_speaker = name;
        }
    }

    /// Add a line. If the speaker matches the last line and the new text is an
    /// extension of the old text (a partial caption update), the last line is
    /// replaced rather than appended — preventing duplicates.
    pub fn add_line(&mut self, timestamp: String, speaker: String, text: String) -> JsValue {
        let speaker = if speaker.trim().is_empty() {
            self.active_speaker.clone()
        } else {
            self.active_speaker = speaker.clone();
            speaker
        };

        let line = ConversationLine { timestamp, speaker, text };

        let replace_last = matches!(
            self.history.last(),
            Some(last) if last.speaker == line.speaker
                && (line.text.starts_with(&last.text) || last.text.starts_with(&line.text))
        );
        if replace_last {
            *self.history.last_mut().unwrap() = line.clone();
        } else {
            self.history.push(line.clone());
        }

        serde_wasm_bindgen::to_value(&line).unwrap_or(JsValue::NULL)
    }

    /// Rebuild history from JSON — used by the service worker to hydrate
    /// after an MV3 idle-kill (see PRD §5.5, FEASIBILITY N5).
    pub fn load_from_json(&mut self, json: String) {
        if let Ok(lines) = serde_json::from_str::<Vec<ConversationLine>>(&json) {
            self.history = lines;
        }
    }

    pub fn get_all_json(&self) -> String {
        serde_json::to_string_pretty(&self.history).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn len(&self) -> usize {
        self.history.len()
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.active_speaker = "Unknown Speaker".to_string();
    }
}

// ============================================================================
// Phase 3 — audio pipeline preprocessing (real CPU work, hence Rust/WASM).
// The mixed audio (tab + mic) arrives from an AudioWorklet at the AudioContext
// sample rate (typically 48 kHz, mono). Whisper wants 16 kHz mono f32. This
// module resamples and accumulates samples into fixed-size chunks.
// ============================================================================

const TARGET_RATE: usize = 16_000;

// Voice-activity segmentation, tuned for clean (non-fragmented) transcripts:
// cut at a silence gap after speech, not on a fixed timer, so each segment is
// a whole phrase. All in 16 kHz samples.
const SILENCE_THRESH: f32 = 0.015; // |amplitude| below this = silence
const SILENCE_FLUSH: usize = 8_000; // 0.5 s of trailing silence ends a segment
const MIN_SEG: usize = 4_000; // 0.25 s — ignore blips
const MAX_SEG: usize = 400_000; // 25 s hard cap so a monologue still flushes

#[wasm_bindgen]
pub struct AudioProcessor {
    input_rate: usize,
    ratio: f64, // input_rate / TARGET_RATE
    pos: f64,   // fractional read position into the running input buffer
    tail: Vec<f32>, // input samples not yet consumed by resampling
    seg: Vec<f32>,  // current segment being built (16 kHz)
    ready: Vec<Vec<f32>>, // completed phrase-aligned segments
    silence_run: usize,
    had_speech: bool,
}

#[wasm_bindgen]
impl AudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(input_rate: usize) -> AudioProcessor {
        let rate = if input_rate == 0 { 48_000 } else { input_rate };
        AudioProcessor {
            input_rate: rate,
            ratio: rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            tail: Vec::new(),
            seg: Vec::new(),
            ready: Vec::new(),
            silence_run: 0,
            had_speech: false,
        }
    }

    /// Feed a frame of input samples (context-rate, mono). Resamples to 16 kHz
    /// and runs voice-activity segmentation.
    pub fn push_samples(&mut self, frame: &[f32]) {
        self.tail.extend_from_slice(frame);
        let last_index = self.tail.len() as f64 - 1.0;
        while self.pos + 1.0 <= last_index {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let s = self.tail[i] * (1.0 - frac) + self.tail[i + 1] * frac;
            self.feed(s);
            self.pos += self.ratio;
        }
        let consumed = self.pos.floor() as usize;
        if consumed > 0 && consumed <= self.tail.len() {
            self.tail.drain(0..consumed);
            self.pos -= consumed as f64;
        }
    }

    fn feed(&mut self, s: f32) {
        self.seg.push(s);
        if s.abs() < SILENCE_THRESH {
            self.silence_run += 1;
        } else {
            self.silence_run = 0;
            self.had_speech = true;
        }
        let end_by_silence =
            self.had_speech && self.silence_run >= SILENCE_FLUSH && self.seg.len() >= MIN_SEG;
        if end_by_silence || self.seg.len() >= MAX_SEG {
            self.finalize();
        }
    }

    fn finalize(&mut self) {
        if self.had_speech && self.seg.len() >= MIN_SEG {
            self.ready.push(std::mem::take(&mut self.seg));
        } else {
            self.seg.clear();
        }
        self.silence_run = 0;
        self.had_speech = false;
    }

    /// Force the in-progress segment out (call on stop).
    pub fn flush(&mut self) {
        self.finalize();
    }

    pub fn has_segment(&self) -> bool {
        !self.ready.is_empty()
    }

    /// Completed segments waiting to be consumed. Used to bound memory while an
    /// STT engine is still loading.
    pub fn segment_count(&self) -> usize {
        self.ready.len()
    }

    /// Pop the oldest completed phrase segment (empty if none).
    pub fn take_segment(&mut self) -> Vec<f32> {
        if self.ready.is_empty() {
            Vec::new()
        } else {
            self.ready.remove(0)
        }
    }

    pub fn input_rate(&self) -> usize {
        self.input_rate
    }
}

// ---------------------------------------------------------------------------
// Speaker attribution by time window (FEASIBILITY N4-B). STT text arrives
// 1–3 s after the utterance, so "current speaker" is wrong. We keep a timeline
// of speaker-change events and, given the audio window a transcript covers,
// return the speaker dominant during that window.
// ---------------------------------------------------------------------------

struct SpeakerEvent {
    name: String,
    t_ms: f64,
}

#[wasm_bindgen]
pub struct SpeakerTimeline {
    events: Vec<SpeakerEvent>,
}

#[wasm_bindgen]
impl SpeakerTimeline {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SpeakerTimeline {
        SpeakerTimeline { events: Vec::new() }
    }

    /// Record that `name` became the active speaker at `t_ms`.
    pub fn mark(&mut self, name: String, t_ms: f64) {
        if name.trim().is_empty() {
            return;
        }
        if let Some(last) = self.events.last() {
            if last.name == name {
                return; // no change
            }
        }
        self.events.push(SpeakerEvent { name, t_ms });
    }

    /// Speaker dominant over [start_ms, end_ms]: the one holding the floor for
    /// the largest slice of that window. Empty string if the timeline is empty.
    pub fn attribute(&self, start_ms: f64, end_ms: f64) -> String {
        if self.events.is_empty() {
            return String::new();
        }
        let (start, end) = if start_ms <= end_ms {
            (start_ms, end_ms)
        } else {
            (end_ms, start_ms)
        };

        let mut best_name = String::new();
        let mut best_dur = -1.0_f64;

        for (idx, ev) in self.events.iter().enumerate() {
            let seg_start = ev.t_ms;
            let seg_end = self
                .events
                .get(idx + 1)
                .map(|n| n.t_ms)
                .unwrap_or(f64::INFINITY);
            let overlap = seg_end.min(end) - seg_start.max(start);
            if overlap > best_dur {
                best_dur = overlap;
                best_name = ev.name.clone();
            }
        }

        // If the window predates all events, fall back to the earliest speaker.
        if best_dur <= 0.0 {
            return self.events[0].name.clone();
        }
        best_name
    }

    pub fn reset(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_halves_rate_roughly() {
        // 32 kHz → 16 kHz should output ~half the samples. Loud signal (never
        // silent) → one segment on flush.
        let mut p = AudioProcessor::new(32_000);
        let frame: Vec<f32> = (0..20_000).map(|i| ((i as f32) * 0.1).sin()).collect();
        p.push_samples(&frame);
        p.flush();
        assert!(p.has_segment());
        let seg = p.take_segment();
        // ratio 2.0 → ~10 000 out for 20 000 in.
        assert!((seg.len() as i32 - 10_000).abs() < 20, "got {} samples", seg.len());
    }

    #[test]
    fn segments_split_on_silence() {
        let mut p = AudioProcessor::new(16_000); // passthrough
        // Speech, then >0.5 s of silence → one finalized segment.
        p.push_samples(&vec![0.5; 6000]);
        p.push_samples(&vec![0.0; SILENCE_FLUSH + 100]);
        assert!(p.has_segment(), "silence gap should finalize a segment");
        let seg = p.take_segment();
        assert!(seg.len() >= 6000);
        assert!(!p.has_segment(), "only one segment expected");
    }

    #[test]
    fn silence_only_yields_nothing() {
        let mut p = AudioProcessor::new(16_000);
        p.push_samples(&vec![0.0; 20_000]);
        p.flush();
        assert!(!p.has_segment());
    }

    #[test]
    fn timeline_dominant_speaker() {
        let mut t = SpeakerTimeline::new();
        t.mark("Alice".into(), 0.0);
        t.mark("Bob".into(), 1000.0);
        t.mark("Alice".into(), 1200.0);
        // Window 0..1000 → Alice held 0..1000 (1000ms) vs Bob 0 → Alice.
        assert_eq!(t.attribute(0.0, 1000.0), "Alice");
        // Window 1000..1150 → Bob holds 1000..1150.
        assert_eq!(t.attribute(1000.0, 1150.0), "Bob");
        // Window before any event → earliest speaker.
        assert_eq!(t.attribute(-500.0, -100.0), "Alice");
    }

    #[test]
    fn timeline_empty_is_blank() {
        let t = SpeakerTimeline::new();
        assert_eq!(t.attribute(0.0, 100.0), "");
    }
}
