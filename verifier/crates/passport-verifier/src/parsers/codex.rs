//! Parser for Codex CLI rollout traces
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).

use super::{ParseError, SessionStats};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const KNOWN_TYPES: [&str; 4] = ["session_meta", "response_item", "turn_context", "event_msg"];

pub(super) fn looks_like(first_lines: &[Value]) -> bool {
    first_lines.iter().any(|o| {
        o.get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| KNOWN_TYPES.contains(&t))
    })
}

pub(super) fn parse(lines: &[Value]) -> Result<SessionStats, ParseError> {
    let mut external_id = String::new();
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut tool_call_count: u64 = 0;
    let mut models: BTreeSet<String> = BTreeSet::new();
    let mut tool_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut last_usage: Option<(u64, u64)> = None;

    for o in lines {
        if let Some(ts) = o.get("timestamp").and_then(Value::as_str) {
            if started_at.as_deref().is_none_or(|s| ts < s) {
                started_at = Some(ts.to_string());
            }
            if ended_at.as_deref().is_none_or(|e| ts > e) {
                ended_at = Some(ts.to_string());
            }
        }
        let line_type = o.get("type").and_then(Value::as_str);
        let Some(payload) = o.get("payload") else {
            continue;
        };
        match line_type {
            Some("session_meta") => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    external_id = id.to_string();
                }
            }
            Some("turn_context") => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    models.insert(model.to_string());
                }
            }
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("message") => message_count += 1,
                Some("function_call") => {
                    if let Some(name) = payload.get("name").and_then(Value::as_str) {
                        tool_call_count += 1;
                        *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                    }
                }
                _ => {}
            },
            Some("event_msg") => {
                if payload.get("type").and_then(Value::as_str) == Some("token_count")
                    && let Some(usage) = payload
                        .get("info")
                        .and_then(|info| info.get("total_token_usage"))
                {
                    last_usage = Some((
                        usage
                            .get("input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        usage
                            .get("output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    ));
                }
            }
            _ => {}
        }
    }

    if external_id.is_empty() {
        return Err(ParseError(
            "No session_meta found in Codex trace".to_string(),
        ));
    }
    if message_count == 0 && tool_call_count == 0 {
        return Err(ParseError("No activity found in Codex trace".to_string()));
    }

    let (input_tokens, output_tokens) = last_usage.unwrap_or((0, 0));

    Ok(SessionStats {
        harness: "codex".to_string(),
        external_id,
        started_at,
        ended_at,
        message_count,
        tool_call_count,
        input_tokens,
        output_tokens,
        models: models.into_iter().collect(),
        tool_counts,
    })
}
