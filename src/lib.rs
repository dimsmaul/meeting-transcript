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
