//! Newline-delimited JSON over the app socket.
//! Request: `{"id": n, "method": "...", "params": {...}}`.
//! Response: `{"id": n, "result": ...}` or `{"id": n, "error": "..."}`.
//! The first request of each connection is `hello` with `{"client": "mcp" | "native-host"}`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }

    pub fn err(id: u64, error: impl ToString) -> Self {
        Self { id, result: None, error: Some(error.to_string()) }
    }
}
