/**
 * @file services/inject_queue.rs
 * @description In-memory inject queue for Dual-Queue mid-execution steering (v1.5.0)
 */

use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

pub type RequestId = String;
pub type InjectMessage = String;

static INJECT_QUEUE: Lazy<Mutex<HashMap<RequestId, Vec<InjectMessage>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn push_inject_message(request_id: &str, message: String) {
    let mut queue = INJECT_QUEUE.lock().unwrap();
    queue.entry(request_id.to_string())
        .or_insert_with(Vec::new)
        .push(message);
}

pub fn drain_inject_messages(request_id: &str) -> Vec<InjectMessage> {
    let mut queue = INJECT_QUEUE.lock().unwrap();
    queue.remove(request_id).unwrap_or_default()
}

#[allow(dead_code)]
pub fn clear_inject_messages(request_id: &str) {
    let mut queue = INJECT_QUEUE.lock().unwrap();
    queue.remove(request_id);
}
