//! Parser tests. Fixtures mirror `worker/test/parsers.test.ts` so the Rust and
//! TypeScript parsers stay in lockstep.
#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used)]

use passport_verifier::parsers::parse_trace;

fn claude_trace() -> String {
    [
        r#"{"type":"user","sessionId":"abc-123","cwd":"/home/dev/proj","timestamp":"2026-07-10T15:15:45.972Z","message":{"role":"user","content":"hello"}}"#,
        r#"{"type":"assistant","sessionId":"abc-123","timestamp":"2026-07-10T15:16:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":250},"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Bash","input":{}}]}}"#,
        r#"{"type":"assistant","sessionId":"abc-123","timestamp":"2026-07-10T16:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":50,"output_tokens":75},"content":[{"type":"tool_use","name":"Read","input":{}}]}}"#,
        r#"{"type":"file-history-snapshot","sessionId":"abc-123"}"#,
    ]
    .join("\n")
}

fn codex_trace() -> String {
    [
        r#"{"timestamp":"2026-05-28T04:51:39.284Z","type":"session_meta","payload":{"id":"codex-session-1","cwd":"/x","originator":"codex_exec"}}"#,
        r#"{"timestamp":"2026-05-28T04:51:40.000Z","type":"turn_context","payload":{"model":"gpt-5.4"}}"#,
        r#"{"timestamp":"2026-05-28T04:52:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}"}}"#,
        r#"{"timestamp":"2026-05-28T04:53:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}"#,
        r#"{"timestamp":"2026-05-28T04:55:57.216Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":780470,"cached_input_tokens":700000,"output_tokens":13366,"reasoning_output_tokens":4200}}}}"#,
    ]
    .join("\n")
}

#[test]
fn parses_claude_code_trace() {
    let s = parse_trace(&claude_trace()).unwrap();
    assert_eq!(s.harness, "claude-code");
    assert_eq!(s.external_id, "abc-123");
    assert_eq!(s.message_count, 3);
    assert_eq!(s.tool_call_count, 2);
    assert_eq!(s.input_tokens, 150);
    assert_eq!(s.output_tokens, 325);
    assert_eq!(s.models, vec!["claude-opus-4-8"]);
    assert_eq!(s.tool_counts.get("Bash"), Some(&1));
    assert_eq!(s.tool_counts.get("Read"), Some(&1));
    assert_eq!(s.started_at.as_deref(), Some("2026-07-10T15:15:45.972Z"));
    assert_eq!(s.ended_at.as_deref(), Some("2026-07-10T16:00:00.000Z"));
    assert_eq!(s.project_hash.as_deref().map(str::len), Some(16));
}

#[test]
fn parses_codex_trace() {
    let s = parse_trace(&codex_trace()).unwrap();
    assert_eq!(s.harness, "codex");
    assert_eq!(s.external_id, "codex-session-1");
    assert_eq!(s.message_count, 1);
    assert_eq!(s.tool_call_count, 1);
    assert_eq!(s.input_tokens, 780470);
    assert_eq!(s.output_tokens, 13366);
    assert_eq!(s.cache_read_tokens, 700000);
    assert_eq!(s.reasoning_output_tokens, 4200);
    assert_eq!(s.models, vec!["gpt-5.4"]);
    assert_eq!(s.tool_counts.get("exec_command"), Some(&1));
    assert!(s.project_hash.is_some());
}

#[test]
fn rejects_empty_input() {
    assert!(parse_trace("").is_err());
}

#[test]
fn rejects_non_jsonl() {
    assert!(parse_trace("hello world\nnot json").is_err());
}

#[test]
fn rejects_unrecognized_jsonl() {
    let err = parse_trace("{\"foo\": 1}\n{\"bar\": 2}").unwrap_err();
    assert!(err.to_string().contains("Unrecognized"));
}

#[test]
fn tolerates_corrupt_lines_inside_valid_trace() {
    let text = claude_trace() + "\n{broken json";
    let s = parse_trace(&text).unwrap();
    assert_eq!(s.external_id, "abc-123");
}
