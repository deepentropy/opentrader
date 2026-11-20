/*
 * Questions to the user through the app (plugins/PROTOCOL.md, "Prompts"): `plugin.prompt` opens a dialog in the
 * app, `plugin.promptAnswer` brings the user's answer back (null when they cancelled) and `plugin.promptDone` closes a
 * dialog that no longer waits for anything. A direct login asks its second factor this way.
 */
use crate::rpc::Out;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};

/// A dialog in the app.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Prompt {
    pub title: String,
    pub message: String,
    /// The field the user types the answer in: "text", "password"; None for a message alone.
    pub input: Option<&'static str>,
    /// A picture to show above the field (PNG, a security code card's indexes).
    pub image: Vec<u8>,
}

pub struct Prompts {
    out: Out,
    next: AtomicU64,
    waiting: Mutex<HashMap<String, mpsc::Sender<Option<String>>>>,
}

impl Prompts {
    pub fn new(out: Out) -> Self {
        Self { out, next: AtomicU64::new(1), waiting: Mutex::new(HashMap::new()) }
    }

    fn new_id(&self) -> String {
        format!("p{}", self.next.fetch_add(1, Ordering::SeqCst))
    }

    fn open(&self, id: &str, p: &Prompt) {
        let image = (!p.image.is_empty()).then(|| base64(&p.image));
        self.out.notify(
            "plugin.prompt",
            json!({ "id": id, "title": p.title, "message": p.message, "input": p.input, "image": image }),
        );
    }

    /// Show a message; it stays until `done`.
    pub fn show(&self, p: &Prompt) -> String {
        let id = self.new_id();
        self.open(&id, p);
        id
    }

    /// Ask and wait for the answer: None when the user cancelled. Blocks the calling thread.
    pub fn ask(&self, p: &Prompt) -> Option<String> {
        let (tx, rx) = mpsc::channel();
        let id = self.new_id();
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
        self.open(&id, p);
        let answer = rx.recv().ok().flatten();
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        answer
    }

    /// The app's `plugin.promptAnswer`.
    pub fn answer(&self, id: &str, value: Option<String>) {
        if let Some(tx) = self.waiting.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            let _ = tx.send(value);
        }
    }

    /// Close a dialog.
    pub fn done(&self, id: &str) {
        self.out.notify("plugin.promptDone", json!({ "id": id }));
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                s.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn ask_waits_for_the_answer() {
        let (out, mut sent) = Out::channel();
        let prompts = std::sync::Arc::new(Prompts::new(out));
        let p = prompts.clone();
        let asker = std::thread::spawn(move || p.ask(&Prompt { title: "Code".into(), input: Some("text"), ..Default::default() }));
        let line = sent.blocking_recv().unwrap();
        let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(msg["method"], "plugin.prompt");
        assert_eq!(msg["params"]["input"], "text");
        prompts.answer(msg["params"]["id"].as_str().unwrap(), Some("1234".into()));
        assert_eq!(asker.join().unwrap().as_deref(), Some("1234"));
    }
}
