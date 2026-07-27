//! Parser for Codex CLI rollout traces
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
//!
//! Line-for-line port of `worker/src/parsers/codex.ts`; kept in sync via
//! shared test fixtures.

use super::heuristics::{
    EventKind, OutcomeEvent, classify_command, compute_outcome, is_commit, is_generated_path,
    is_ship, is_verify, median, normalize_ext,
};
use super::{ParseError, SessionStats, project_hash};
use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

const KNOWN_TYPES: [&str; 4] = ["session_meta", "response_item", "turn_context", "event_msg"];

#[allow(clippy::unwrap_used)]
fn regex(pattern: &'static str) -> Regex {
    Regex::new(pattern).unwrap()
}

static EXIT_CODE_RX: LazyLock<Regex> = LazyLock::new(|| regex(r"exited with code (\d+)"));
static PATCH_MARKER_RX: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^\*\*\* (Update|Add|Delete) File: (.+)$"));

pub(super) fn looks_like(first_lines: &[Value]) -> bool {
    first_lines.iter().any(|o| {
        o.get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| KNOWN_TYPES.contains(&t))
    })
}

/// Codex exec outputs embed exit codes as text or JSON metadata.
fn codex_success(output: &str) -> bool {
    if let Some(caps) = EXIT_CODE_RX.captures(output) {
        return caps.get(1).is_some_and(|m| m.as_str() == "0");
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(output)
        && let Some(exit_code) = parsed.get("metadata").and_then(|m| m.get("exit_code"))
        && let Some(n) = exit_code.as_i64()
    {
        return n == 0;
    }
    true
}

struct PatchFile {
    path: String,
    added: u64,
    removed: u64,
}

/// Parse an apply_patch body: returns per-file added/removed line counts.
fn parse_apply_patch(body: &str) -> Vec<PatchFile> {
    let mut files: Vec<PatchFile> = Vec::new();
    let mut has_current = false;
    for line in body.split('\n') {
        if let Some(caps) = PATCH_MARKER_RX.captures(line) {
            let path = caps
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            files.push(PatchFile {
                path,
                added: 0,
                removed: 0,
            });
            has_current = true;
            continue;
        }
        if line.starts_with("***") || !has_current {
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if line.starts_with('+') {
            f.added += 1;
        } else if line.starts_with('-') {
            f.removed += 1;
        }
    }
    files
}

pub(super) fn parse(lines: impl Iterator<Item = Value>) -> Result<SessionStats, ParseError> {
    let mut external_id = String::new();
    let mut cwd: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut tool_call_count: u64 = 0;
    let mut models: BTreeSet<String> = BTreeSet::new();
    let mut tool_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut last_usage: Option<(u64, u64, u64, u64)> = None;

    let mut loc_added: u64 = 0;
    let mut loc_removed: u64 = 0;
    let mut languages: BTreeMap<String, u64> = BTreeMap::new();
    let mut command_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut human_turns: u64 = 0;
    let mut verified_edit_cycles: u64 = 0;
    let mut red_green_cycles: u64 = 0;
    let mut call_commands: HashMap<String, String> = HashMap::new();
    let mut events: Vec<OutcomeEvent> = Vec::new();
    let mut runs: Vec<u64> = Vec::new();
    let mut current_run: u64 = 0;
    let mut dirty = false;
    let mut failed = false;
    let mut edited_since_fail = false;

    for (idx, o) in lines.enumerate() {
        let seq = idx + 1;
        let line_type = o.get("type").and_then(Value::as_str);
        let payload = o.get("payload");

        if let Some(ts) = o.get("timestamp").and_then(Value::as_str) {
            if started_at.as_deref().is_none_or(|s| ts < s) {
                started_at = Some(ts.to_string());
            }
            if ended_at.as_deref().is_none_or(|e| ts > e) {
                ended_at = Some(ts.to_string());
            }
        }

        if line_type == Some("session_meta")
            && let Some(id) = payload.and_then(|p| p.get("id")).and_then(Value::as_str)
        {
            external_id = id.to_string();
            if let Some(dir) = payload.and_then(|p| p.get("cwd")).and_then(Value::as_str) {
                cwd = Some(dir.to_string());
            }
        }

        if line_type == Some("turn_context")
            && let Some(model) = payload.and_then(|p| p.get("model")).and_then(Value::as_str)
        {
            models.insert(model.to_string());
        }

        if line_type == Some("event_msg") {
            let p_type = payload.and_then(|p| p.get("type")).and_then(Value::as_str);
            if p_type == Some("user_message") {
                human_turns += 1;
                if current_run > 0 {
                    runs.push(current_run);
                }
                current_run = 0;
            }
            if p_type == Some("token_count")
                && let Some(usage) = payload
                    .and_then(|p| p.get("info"))
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
                    usage
                        .get("cached_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    usage
                        .get("reasoning_output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                ));
            }
        }

        if line_type == Some("response_item")
            && let Some(p) = payload
        {
            let p_type = p.get("type").and_then(Value::as_str);
            if p_type == Some("message") {
                message_count += 1;
            }
            if p_type == Some("function_call")
                && let Some(name) = p.get("name").and_then(Value::as_str)
            {
                tool_call_count += 1;
                current_run += 1;
                *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                if name == "exec_command"
                    && let Some(arguments) = p.get("arguments").and_then(Value::as_str)
                    && let Some(call_id) = p.get("call_id").and_then(Value::as_str)
                    && let Ok(args) = serde_json::from_str::<Value>(arguments)
                    && let Some(cmd) = args.get("cmd").and_then(Value::as_str)
                {
                    let cat = classify_command(cmd);
                    *command_counts.entry(cat.to_string()).or_insert(0) += 1;
                    call_commands.insert(call_id.to_string(), cmd.to_string());
                }
            }
            if p_type == Some("custom_tool_call")
                && p.get("name").and_then(Value::as_str) == Some("apply_patch")
                && let Some(input) = p.get("input").and_then(Value::as_str)
            {
                current_run += 1;
                let mut touched = false;
                for f in parse_apply_patch(input) {
                    if f.added == 0 && f.removed == 0 {
                        continue;
                    }
                    touched = true;
                    if !is_generated_path(&f.path) {
                        loc_added += f.added;
                        loc_removed += f.removed;
                        let ext = normalize_ext(&f.path);
                        *languages.entry(ext).or_insert(0) += f.added + f.removed;
                    }
                }
                if touched {
                    events.push(OutcomeEvent {
                        kind: EventKind::Edit,
                        ok: true,
                        seq,
                    });
                    dirty = true;
                    if failed {
                        edited_since_fail = true;
                    }
                }
            }
            if (p_type == Some("function_call_output") || p_type == Some("custom_tool_call_output"))
                && let Some(call_id) = p.get("call_id").and_then(Value::as_str)
                && let Some(cmd) = call_commands.remove(call_id)
            {
                let ok = match p.get("output").and_then(Value::as_str) {
                    Some(out) => codex_success(out),
                    None => true,
                };
                if is_verify(&cmd) {
                    events.push(OutcomeEvent {
                        kind: EventKind::Verify,
                        ok,
                        seq,
                    });
                    if ok {
                        if dirty {
                            verified_edit_cycles += 1;
                            dirty = false;
                        }
                        if failed && edited_since_fail {
                            red_green_cycles += 1;
                            failed = false;
                        }
                    } else {
                        failed = true;
                        edited_since_fail = false;
                    }
                }
                if ok && is_commit(&cmd) {
                    events.push(OutcomeEvent {
                        kind: EventKind::Commit,
                        ok: true,
                        seq,
                    });
                }
                if is_ship(&cmd) {
                    events.push(OutcomeEvent {
                        kind: EventKind::Ship,
                        ok,
                        seq,
                    });
                }
            }
        }
    }

    if current_run > 0 {
        runs.push(current_run);
    }

    if external_id.is_empty() {
        return Err(ParseError(
            "No session_meta found in Codex trace".to_string(),
        ));
    }
    if message_count == 0 && tool_call_count == 0 {
        return Err(ParseError("No activity found in Codex trace".to_string()));
    }

    let (input_tokens, output_tokens, cache_read_tokens, reasoning_output_tokens) =
        last_usage.unwrap_or((0, 0, 0, 0));
    let run_values: Vec<f64> = runs.iter().map(|&r| r as f64).collect();
    let agenticity = median(&run_values);
    let longest_run = runs.iter().copied().max().unwrap_or(0);
    let outcome = compute_outcome(&events, tool_call_count);

    Ok(SessionStats {
        harness: "codex".to_string(),
        external_id,
        started_at,
        ended_at,
        message_count,
        tool_call_count,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        reasoning_output_tokens,
        web_search_requests: 0,
        web_fetch_requests: 0,
        subagent_input_tokens: 0,
        subagent_output_tokens: 0,
        subagent_cache_read_tokens: 0,
        subagent_cache_creation_tokens: 0,
        models: models.into_iter().collect(),
        tool_counts,
        project_hash: cwd.as_deref().map(project_hash),
        loc_added,
        loc_removed,
        languages,
        command_counts,
        human_turns,
        agenticity,
        longest_run,
        parallel_batches: 0,
        delegation_calls: 0,
        verified_edit_cycles,
        red_green_cycles,
        outcome,
        skills: Vec::new(),
        mcp_servers: Vec::new(),
        background_tasks: 0,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_lines(lines: Vec<Value>) -> SessionStats {
        parse(lines.into_iter()).expect("parse should succeed")
    }

    #[test]
    fn extracts_v2_metrics() {
        let patch = [
            "*** Begin Patch",
            "*** Update File: /repo/src/main.py",
            "@@",
            " context",
            "+added line one",
            "+added line two",
            "-removed line",
            "*** End Patch",
        ]
        .join("\n");

        let lines = vec![
            json!({ "type": "session_meta", "timestamp": "2026-07-01T09:00:00Z",
                "payload": { "id": "c1", "cwd": "/repo" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "fix the bug" } }),
            json!({ "type": "response_item", "payload": { "type": "function_call", "name": "exec_command", "call_id": "x1",
                "arguments": json!({ "cmd": "pytest -x" }).to_string() } }),
            json!({ "type": "response_item", "payload": { "type": "function_call_output", "call_id": "x1",
                "output": "Process exited with code 1\nFAILED" } }),
            json!({ "type": "response_item", "payload": { "type": "custom_tool_call", "name": "apply_patch", "call_id": "x2",
                "input": patch } }),
            json!({ "type": "response_item", "payload": { "type": "custom_tool_call_output", "call_id": "x2",
                "output": "{\"output\":\"Success\",\"metadata\":{\"exit_code\":0}}" } }),
            json!({ "type": "response_item", "payload": { "type": "function_call", "name": "exec_command", "call_id": "x3",
                "arguments": json!({ "cmd": "pytest -x" }).to_string() } }),
            json!({ "type": "response_item", "payload": { "type": "function_call_output", "call_id": "x3",
                "output": "Process exited with code 0\n2 passed" } }),
            json!({ "type": "response_item", "payload": { "type": "function_call", "name": "exec_command", "call_id": "x4",
                "arguments": json!({ "cmd": "git add -A && git commit -m fix" }).to_string() } }),
            json!({ "type": "response_item", "payload": { "type": "function_call_output", "call_id": "x4",
                "output": "Process exited with code 0" } }),
            json!({ "type": "response_item", "payload": { "type": "message",
                "content": [{ "type": "output_text", "text": "done" }] } }),
        ];

        let s = parse_lines(lines);
        assert_eq!(s.loc_added, 2);
        assert_eq!(s.loc_removed, 1);
        let mut expected_languages = BTreeMap::new();
        expected_languages.insert("py".to_string(), 3u64);
        assert_eq!(s.languages, expected_languages);
        let mut expected_commands = BTreeMap::new();
        expected_commands.insert("test".to_string(), 2u64);
        expected_commands.insert("git".to_string(), 1u64);
        assert_eq!(s.command_counts, expected_commands);
        assert_eq!(s.human_turns, 1);
        assert_eq!(s.verified_edit_cycles, 1);
        assert_eq!(s.red_green_cycles, 1);
        assert_eq!(s.outcome, "landed"); // commit after last edit, green after first edit
        assert_eq!(s.agenticity, 4.0); // one run of 4 calls
        assert_eq!(s.longest_run, 4);
        assert_eq!(s.delegation_calls, 0);
        assert!(s.skills.is_empty());
    }

    #[test]
    fn zeroes_v2_metrics_on_minimal_traces() {
        let lines = vec![
            json!({ "type": "session_meta", "payload": { "id": "c2" } }),
            json!({ "type": "response_item", "payload": { "type": "message",
                "content": [{ "type": "output_text", "text": "hi" }] } }),
        ];
        let s = parse_lines(lines);
        assert_eq!(s.loc_added, 0);
        assert_eq!(s.outcome, "trivial");
        assert!(s.skills.is_empty());
        assert_eq!(s.parallel_batches, 0);
        assert_eq!(s.delegation_calls, 0);
        assert!(s.mcp_servers.is_empty());
        assert_eq!(s.background_tasks, 0);
    }

    #[test]
    fn codex_success_json_parse_failure_assumes_success() {
        // A non-JSON, no-exit-code-text output should not count as a failed verify.
        assert!(codex_success("not json at all"));
        assert!(codex_success("exited with code 0"));
        assert!(!codex_success("exited with code 1"));
        assert!(codex_success("{\"metadata\":{\"exit_code\":0}}"));
        assert!(!codex_success("{\"metadata\":{\"exit_code\":1}}"));
    }
}
