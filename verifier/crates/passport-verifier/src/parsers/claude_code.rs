//! Parser for Claude Code session traces
//! (`~/.claude/projects/<project>/<session-id>.jsonl`).
//!
//! Line-for-line port of `worker/src/parsers/claudeCode.ts`; kept in sync via
//! shared test fixtures.

use super::heuristics::{
    EventKind, OutcomeEvent, classify_command, compute_outcome, is_commit, is_generated_path,
    is_ship, is_verify, median, normalize_ext,
};
use super::{ParseError, SessionStats, project_hash};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

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

/// A human prompt: user line, not meta/sidechain, with real text content.
fn is_human_prompt(o: &Value) -> bool {
    if o.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if o.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if o.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let content = o.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::String(s)) => !s.starts_with('<') && !s.starts_with('{'),
        Some(Value::Array(blocks)) => {
            let has_text = blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("text"));
            let has_tool_result = blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"));
            has_text && !has_tool_result
        }
        _ => false,
    }
}

pub(super) fn parse(lines: impl Iterator<Item = Value>) -> Result<SessionStats, ParseError> {
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

    let mut loc_added: u64 = 0;
    let mut loc_removed: u64 = 0;
    let mut languages: BTreeMap<String, u64> = BTreeMap::new();
    let mut command_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut human_turns: u64 = 0;
    let mut delegation_calls: u64 = 0;
    let mut verified_edit_cycles: u64 = 0;
    let mut red_green_cycles: u64 = 0;
    let mut background_tasks: u64 = 0;
    let mut skills: BTreeSet<String> = BTreeSet::new();
    let mut mcp_servers: BTreeSet<String> = BTreeSet::new();
    let mut request_counts: HashMap<String, u64> = HashMap::new();
    let mut bash_commands: HashMap<String, String> = HashMap::new();
    let mut events: Vec<OutcomeEvent> = Vec::new();
    let mut runs: Vec<u64> = Vec::new();
    let mut current_run: u64 = 0;
    let mut dirty = false;
    let mut failed = false;
    let mut edited_since_fail = false;

    for (idx, o) in lines.enumerate() {
        let seq = idx + 1;
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

        if o.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(s) = o.get("attributionSkill").and_then(Value::as_str)
            && !s.is_empty()
        {
            skills.insert(s.to_string());
        }
        if let Some(s) = o.get("attributionMcpServer").and_then(Value::as_str)
            && !s.is_empty()
        {
            mcp_servers.insert(s.to_string());
        }

        let line_type = o.get("type").and_then(Value::as_str);
        if line_type != Some("user") && line_type != Some("assistant") {
            continue;
        }
        message_count += 1;

        if is_human_prompt(&o) {
            human_turns += 1;
            if current_run > 0 {
                runs.push(current_run);
            }
            current_run = 0;
            continue;
        }

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
            let request_id = o.get("requestId").and_then(Value::as_str);
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for block in content {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let Some(name) = block.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    tool_call_count += 1;
                    current_run += 1;
                    *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                    if let Some(rid) = request_id {
                        *request_counts.entry(rid.to_string()).or_insert(0) += 1;
                    }
                    let input = block.get("input");
                    if name == "Agent" || name == "Task" || name == "Workflow" {
                        delegation_calls += 1;
                    }
                    if name == "Skill"
                        && let Some(skill) =
                            input.and_then(|i| i.get("skill")).and_then(Value::as_str)
                    {
                        skills.insert(skill.to_string());
                    }
                    if let Some(rest) = name.strip_prefix("mcp__")
                        && let Some(server) = rest.split("__").next()
                    {
                        mcp_servers.insert(server.to_string());
                    }
                    let run_in_background = input
                        .and_then(|i| i.get("run_in_background"))
                        .and_then(Value::as_bool)
                        == Some(true);
                    if name == "Monitor" || (name == "Bash" && run_in_background) {
                        background_tasks += 1;
                    }
                    if name == "Bash"
                        && let Some(command) =
                            input.and_then(|i| i.get("command")).and_then(Value::as_str)
                    {
                        let cat = classify_command(command);
                        *command_counts.entry(cat.to_string()).or_insert(0) += 1;
                        if let Some(id) = block.get("id").and_then(Value::as_str) {
                            bash_commands.insert(id.to_string(), command.to_string());
                        }
                    }
                }
            }
        }

        if line_type == Some("user") {
            let content = o.get("message").and_then(|m| m.get("content"));
            if let Some(blocks) = content.and_then(Value::as_array) {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let Some(cmd) = bash_commands.remove(tool_use_id) else {
                        continue;
                    };
                    let ok = block.get("is_error").and_then(Value::as_bool) != Some(true);
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

            if let Some(r) = o.get("toolUseResult") {
                let structured_patch = r.get("structuredPatch").and_then(Value::as_array);
                let r_type = r.get("type").and_then(Value::as_str);
                if structured_patch.is_some() || r_type == Some("create") {
                    let mut add: u64 = 0;
                    let mut rem: u64 = 0;
                    if r_type == Some("create")
                        && let Some(content) = r.get("content").and_then(Value::as_str)
                    {
                        let body = content.strip_suffix('\n').unwrap_or(content);
                        add = if body.is_empty() {
                            0
                        } else {
                            body.split('\n').count() as u64
                        };
                    } else if let Some(patch) = structured_patch {
                        for hunk in patch {
                            let Some(hunk_lines) = hunk.get("lines").and_then(Value::as_array)
                            else {
                                continue;
                            };
                            for l in hunk_lines {
                                let Some(l) = l.as_str() else { continue };
                                if l.starts_with('+') {
                                    add += 1;
                                } else if l.starts_with('-') {
                                    rem += 1;
                                }
                            }
                        }
                    }
                    if add > 0 || rem > 0 {
                        events.push(OutcomeEvent {
                            kind: EventKind::Edit,
                            ok: true,
                            seq,
                        });
                        dirty = true;
                        if failed {
                            edited_since_fail = true;
                        }
                        let file_path = r.get("filePath").and_then(Value::as_str);
                        if file_path.is_none_or(|p| !is_generated_path(p)) {
                            loc_added += add;
                            loc_removed += rem;
                            if let Some(p) = file_path {
                                let ext = normalize_ext(p);
                                *languages.entry(ext).or_insert(0) += add + rem;
                            }
                        }
                    }
                }
            }
        }
    }

    if current_run > 0 {
        runs.push(current_run);
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

    let run_values: Vec<f64> = runs.iter().map(|&r| r as f64).collect();
    let agenticity = median(&run_values);
    let longest_run = runs.iter().copied().max().unwrap_or(0);
    let parallel_batches = request_counts.values().filter(|&&n| n > 1).count() as u64;
    let outcome = compute_outcome(&events, tool_call_count);

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
        loc_added,
        loc_removed,
        languages,
        command_counts,
        human_turns,
        agenticity,
        longest_run,
        parallel_batches,
        delegation_calls,
        verified_edit_cycles,
        red_green_cycles,
        outcome,
        skills: skills.into_iter().collect(),
        mcp_servers: mcp_servers.into_iter().collect(),
        background_tasks,
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
        let lines = vec![
            json!({ "type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": "2026-07-01T10:00:00Z",
                "message": { "content": "add a feature" } }),
            // parallel batch: two tool_use sharing a requestId
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r1", "timestamp": "2026-07-01T10:00:05Z",
                "message": { "model": "claude-fable-5", "usage": { "input_tokens": 10, "output_tokens": 5 },
                    "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/repo/src/a.ts" } }] } }),
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r1",
                "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Bash",
                    "input": { "command": "cd worker && npx vitest run" } }] } }),
            // failing test result (red)
            json!({ "type": "user", "sessionId": "s1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t2", "is_error": true }] } }),
            // edit via Write (create): 3 lines
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r2",
                "message": { "content": [{ "type": "tool_use", "id": "t3", "name": "Write",
                    "input": { "file_path": "/repo/src/a.ts", "content": "a\nb\nc" } }] } }),
            json!({ "type": "user", "sessionId": "s1", "toolUseResult": { "type": "create", "filePath": "/repo/src/a.ts",
                "content": "a\nb\nc", "structuredPatch": [] },
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "t3" }] } }),
            // edit on generated path — excluded from LOC/languages
            json!({ "type": "user", "sessionId": "s1", "toolUseResult": { "type": "create",
                "filePath": "/repo/package-lock.json", "content": "x\n".repeat(100), "structuredPatch": [] },
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "t3b" }] } }),
            // Edit with structuredPatch: +2 -1 on a .tsx file (aliases to ts)
            json!({ "type": "user", "sessionId": "s1", "toolUseResult": { "filePath": "/repo/src/B.tsx",
                "structuredPatch": [{ "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3,
                    "lines": [" keep", "+new1", "+new2", "-old"] }] },
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "t3c" }] } }),
            // passing test after edits (green + verified cycle + red→green cycle)
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r3",
                "message": { "content": [{ "type": "tool_use", "id": "t4", "name": "Bash",
                    "input": { "command": "cd worker && npx vitest run", "run_in_background": false } }] } }),
            json!({ "type": "user", "sessionId": "s1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t4", "is_error": false }] } }),
            // commit then push → shipped
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r4",
                "message": { "content": [{ "type": "tool_use", "id": "t5", "name": "Bash",
                    "input": { "command": "git add -A && git commit -m \"feat\"" } }] } }),
            json!({ "type": "user", "sessionId": "s1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t5" }] } }),
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r5",
                "message": { "content": [{ "type": "tool_use", "id": "t6", "name": "Bash",
                    "input": { "command": "git push origin main", "run_in_background": true } }] } }),
            json!({ "type": "user", "sessionId": "s1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t6" }] } }),
            // second human turn, then delegation + skill + mcp
            json!({ "type": "user", "sessionId": "s1", "message": { "content": "now polish it" } }),
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r6",
                "message": { "content": [{ "type": "tool_use", "id": "t7", "name": "Agent",
                    "input": { "prompt": "x", "description": "y" } }] } }),
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r7",
                "message": { "content": [{ "type": "tool_use", "id": "t8", "name": "Skill",
                    "input": { "skill": "dataviz" } }] } }),
            json!({ "type": "assistant", "sessionId": "s1", "requestId": "r8", "attributionMcpServer": "claude-in-chrome",
                "message": { "content": [{ "type": "tool_use", "id": "t9",
                    "name": "mcp__claude-in-chrome__navigate", "input": { "url": "x" } }] } }),
            // meta and sidechain lines must not count as human turns or main-chain calls
            json!({ "type": "user", "sessionId": "s1", "isMeta": true, "message": { "content": "injected" } }),
            json!({ "type": "user", "sessionId": "s1", "message": { "content": "<system-reminder>noise" } }),
            json!({ "type": "assistant", "sessionId": "s1", "isSidechain": true,
                "message": { "content": [{ "type": "tool_use", "id": "t10", "name": "Read", "input": {} }] } }),
        ];

        let s = parse_lines(lines);
        assert_eq!(s.loc_added, 5); // 3 (create) + 2 (patch); lockfile excluded
        assert_eq!(s.loc_removed, 1);
        let mut expected_languages = BTreeMap::new();
        expected_languages.insert("ts".to_string(), 6u64); // 3 + (2+1) on .ts/.tsx
        assert_eq!(s.languages, expected_languages);
        let mut expected_commands = BTreeMap::new();
        expected_commands.insert("test".to_string(), 2u64);
        expected_commands.insert("git".to_string(), 2u64);
        assert_eq!(s.command_counts, expected_commands);
        assert_eq!(s.human_turns, 2);
        assert_eq!(s.longest_run, 6); // t1..t6 before second human turn
        assert_eq!(s.agenticity, 4.5); // runs [6, 3] → median 4.5
        assert_eq!(s.parallel_batches, 1); // r1 has two tool_use
        assert_eq!(s.delegation_calls, 1);
        assert_eq!(s.verified_edit_cycles, 1);
        assert_eq!(s.red_green_cycles, 1); // fail t2 → edits → pass t4
        assert_eq!(s.outcome, "shipped");
        assert_eq!(s.skills, vec!["dataviz".to_string()]);
        assert_eq!(s.mcp_servers, vec!["claude-in-chrome".to_string()]);
        assert_eq!(s.background_tasks, 1); // t6 run_in_background
    }

    #[test]
    fn zeroes_v2_metrics_on_minimal_traces() {
        let lines = vec![
            json!({ "type": "user", "sessionId": "s2", "message": { "content": "hi" } }),
            json!({ "type": "assistant", "sessionId": "s2", "message": { "model": "claude-fable-5", "content": [] } }),
        ];
        let s = parse_lines(lines);
        assert_eq!(s.loc_added, 0);
        assert_eq!(s.outcome, "trivial");
        assert!(s.skills.is_empty());
    }

    #[test]
    fn ignores_sidechain_attribution_and_trims_trailing_newlines() {
        let lines = vec![
            json!({ "type": "user", "sessionId": "s3", "message": { "content": "go" } }),
            json!({ "type": "system", "sessionId": "s3", "isSidechain": true, "attributionSkill": "sneaky",
                "attributionMcpServer": "sneaky-server" }),
            json!({ "type": "assistant", "sessionId": "s3",
                "message": { "content": [{ "type": "tool_use", "id": "w1", "name": "Write",
                    "input": { "file_path": "/repo/x.py", "content": "a\nb\n" } }] } }),
            json!({ "type": "user", "sessionId": "s3", "toolUseResult": { "type": "create", "filePath": "/repo/x.py",
                "content": "a\nb\n", "structuredPatch": [] },
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "w1" }] } }),
        ];
        let s = parse_lines(lines);
        assert!(s.skills.is_empty());
        assert!(s.mcp_servers.is_empty());
        assert_eq!(s.loc_added, 2);
    }
}
