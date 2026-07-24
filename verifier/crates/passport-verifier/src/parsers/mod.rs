//! Trace parsers for supported AI coding harnesses.
//!
//! Each parser turns a raw JSONL session trace into normalized [`SessionStats`].
//! These are a line-for-line port of the TypeScript parsers in `worker/src/parsers/`,
//! kept in sync via shared test fixtures.

mod claude_code;
mod codex;
// Scaffolding for the Rust harness parsers landing in Task 9-11; nothing in
// this crate calls it yet (only its own test suite does), so dead-code is
// silenced here at the module boundary rather than per-item inside the module.
#[allow(dead_code)]
mod heuristics;

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Normalized statistics extracted from a single harness session trace.
#[derive(Debug, Serialize)]
pub struct SessionStats {
    /// Harness identifier: `claude-code` or `codex`.
    pub harness: String,
    /// Session UUID taken from the trace, used for per-passport dedup.
    pub external_id: String,
    /// Earliest timestamp seen in the trace (ISO 8601).
    pub started_at: Option<String>,
    /// Latest timestamp seen in the trace (ISO 8601).
    pub ended_at: Option<String>,
    /// Number of user + assistant messages.
    #[serde(with = "qos_json::string_or_numeric")]
    pub message_count: u64,
    /// Number of tool invocations.
    #[serde(with = "qos_json::string_or_numeric")]
    pub tool_call_count: u64,
    /// Total input tokens reported by the harness.
    #[serde(with = "qos_json::string_or_numeric")]
    pub input_tokens: u64,
    /// Total output tokens reported by the harness.
    #[serde(with = "qos_json::string_or_numeric")]
    pub output_tokens: u64,
    /// Distinct model identifiers seen in the trace.
    pub models: Vec<String>,
    /// Tool name -> invocation count. BTreeMap for deterministic serialization.
    pub tool_counts: BTreeMap<String, u64>,
    /// Truncated SHA-256 of the session's working directory. Lets cards count
    /// distinct repositories without ever revealing a path.
    pub project_hash: Option<String>,
}

/// Hash a working-directory path into a 16-hex-char project identifier.
pub(crate) fn project_hash(cwd: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(cwd.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Error returned when a trace cannot be parsed.
#[derive(Debug)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ParseError {}

/// Parse a raw JSONL trace, auto-detecting the harness.
pub fn parse_trace(text: &str) -> Result<SessionStats, ParseError> {
    let lines: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            // Tolerate the odd corrupt line.
            serde_json::from_str::<Value>(trimmed).ok()
        })
        .collect();

    if lines.is_empty() {
        return Err(ParseError("File is not valid JSONL".to_string()));
    }

    let head = &lines[..lines.len().min(10)];
    if claude_code::looks_like(head) {
        claude_code::parse(&lines)
    } else if codex::looks_like(head) {
        codex::parse(&lines)
    } else {
        Err(ParseError(
            "Unrecognized trace format (expected Claude Code or Codex JSONL)".to_string(),
        ))
    }
}
