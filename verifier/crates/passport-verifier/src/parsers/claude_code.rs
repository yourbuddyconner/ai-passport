//! Parser for Claude Code session traces
//! (`~/.claude/projects/<project>/<session-id>.jsonl`).

use super::{ParseError, SessionStats, project_hash};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const KNOWN_TYPES: [&str; 5] = [
    "user",
    "assistant",
    "system",
    "summary",
    "file-history-snapshot",
];

pub(super) fn looks_like(first_lines: &[Value]) -> bool {
    first_lines.iter().any(|o| {
        o.get("sessionId").is_some()
            && o.get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| KNOWN_TYPES.contains(&t))
    })
}

pub(super) fn parse(lines: &[Value]) -> Result<SessionStats, ParseError> {
    let mut external_id = String::new();
    let mut cwd: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut tool_call_count: u64 = 0;
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut models: BTreeSet<String> = BTreeSet::new();
    let mut tool_counts: BTreeMap<String, u64> = BTreeMap::new();

    for o in lines {
        if external_id.is_empty()
            && let Some(sid) = o.get("sessionId").and_then(Value::as_str)
        {
            external_id = sid.to_string();
        }
        if cwd.is_none()
            && let Some(dir) = o.get("cwd").and_then(Value::as_str)
        {
            cwd = Some(dir.to_string());
        }
        if let Some(ts) = o.get("timestamp").and_then(Value::as_str) {
            if started_at.as_deref().is_none_or(|s| ts < s) {
                started_at = Some(ts.to_string());
            }
            if ended_at.as_deref().is_none_or(|e| ts > e) {
                ended_at = Some(ts.to_string());
            }
        }
        let line_type = o.get("type").and_then(Value::as_str);
        if line_type != Some("user") && line_type != Some("assistant") {
            continue;
        }
        message_count += 1;
        if line_type == Some("assistant")
            && let Some(message) = o.get("message")
        {
            // Claude Code marks system-generated lines with model "<synthetic>".
            if let Some(model) = message.get("model").and_then(Value::as_str)
                && !model.starts_with('<')
            {
                models.insert(model.to_string());
            }
            if let Some(usage) = message.get("usage") {
                input_tokens += usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                output_tokens += usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
            }
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for block in content {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use")
                        && let Some(name) = block.get("name").and_then(Value::as_str)
                    {
                        tool_call_count += 1;
                        *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    if external_id.is_empty() {
        return Err(ParseError(
            "No sessionId found in Claude Code trace".to_string(),
        ));
    }
    if message_count == 0 {
        return Err(ParseError(
            "No messages found in Claude Code trace".to_string(),
        ));
    }

    Ok(SessionStats {
        harness: "claude-code".to_string(),
        external_id,
        started_at,
        ended_at,
        message_count,
        tool_call_count,
        input_tokens,
        output_tokens,
        models: models.into_iter().collect(),
        tool_counts,
        project_hash: cwd.as_deref().map(project_hash),
    })
}
