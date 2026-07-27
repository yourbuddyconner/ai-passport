//! Trace parsers for supported AI coding harnesses.
//!
//! Each parser turns a raw JSONL session trace into normalized [`SessionStats`].
//! These are a line-for-line port of the TypeScript parsers in `worker/src/parsers/`,
//! kept in sync via shared test fixtures.

mod claude_code;
mod codex;
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
    /// Input tokens served from prompt cache. For Claude Code this is
    /// `cache_read_input_tokens` (disjoint from `input_tokens`); for Codex,
    /// `cached_input_tokens` (a subset of its `input_tokens`). `default` so
    /// payloads from builds that predate the field still decode.
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub cache_read_tokens: u64,
    /// Input tokens written into the prompt cache (Claude Code
    /// `cache_creation_input_tokens`; Codex does not report this).
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub cache_creation_tokens: u64,
    /// Reasoning/thinking output tokens (Codex `reasoning_output_tokens`;
    /// Claude Code folds thinking into `output_tokens`, so this stays 0).
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub reasoning_output_tokens: u64,
    /// Server-side web search invocations, summed once per API request.
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub web_search_requests: u64,
    /// Server-side web fetch invocations, summed once per API request.
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub web_fetch_requests: u64,
    /// Subagent (Task tool) spend, summed from completed results'
    /// `toolUseResult.usage` — the only record of subagent tokens in the
    /// uploaded trace. Deduped by agentId.
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub subagent_input_tokens: u64,
    /// Subagent output tokens (see `subagent_input_tokens`).
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub subagent_output_tokens: u64,
    /// Subagent prompt-cache reads (see `subagent_input_tokens`).
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub subagent_cache_read_tokens: u64,
    /// Subagent prompt-cache writes (see `subagent_input_tokens`).
    #[serde(default, with = "qos_json::string_or_numeric")]
    pub subagent_cache_creation_tokens: u64,
    /// Distinct model identifiers seen in the trace.
    pub models: Vec<String>,
    /// Tool name -> invocation count. BTreeMap for deterministic serialization.
    pub tool_counts: BTreeMap<String, u64>,
    /// Truncated SHA-256 of the session's working directory. Lets cards count
    /// distinct repositories without ever revealing a path.
    pub project_hash: Option<String>,
    /// Lines added, excluding generated/vendored paths.
    #[serde(with = "qos_json::string_or_numeric")]
    pub loc_added: u64,
    /// Lines removed, excluding generated/vendored paths.
    #[serde(with = "qos_json::string_or_numeric")]
    pub loc_removed: u64,
    /// Normalized file extension -> lines changed (added + removed).
    pub languages: BTreeMap<String, u64>,
    /// Bash command category -> invocation count.
    pub command_counts: BTreeMap<String, u64>,
    /// Number of human prompts (user turns with real text content).
    #[serde(with = "qos_json::string_or_numeric")]
    pub human_turns: u64,
    /// Median tool-call run length between human turns.
    ///
    /// `qos_json::string_or_numeric` only supports integer types, and plain
    /// `f64` serialization does not work here: the proof payload goes
    /// through `qos_json::to_vec`, whose canonical JSON encoder rejects
    /// *any* non-integer `serde_json::Number` (even whole values like
    /// `0.0`), by design (`SPEC.md`: "QOS canonical JSON forbids
    /// non-integer JSON numbers"). So this field is serialized as a decimal
    /// string (e.g. `"4.5"`); the worker must `Number()`-parse it like the
    /// other numeric-as-string fields above.
    #[serde(serialize_with = "serialize_f64_as_string")]
    pub agenticity: f64,
    /// Longest tool-call run between human turns.
    #[serde(with = "qos_json::string_or_numeric")]
    pub longest_run: u64,
    /// Number of requestIds that batched more than one tool call.
    #[serde(with = "qos_json::string_or_numeric")]
    pub parallel_batches: u64,
    /// Number of Agent/Task/Workflow delegation tool calls.
    #[serde(with = "qos_json::string_or_numeric")]
    pub delegation_calls: u64,
    /// Number of dirty-edit -> green-verify cycles.
    #[serde(with = "qos_json::string_or_numeric")]
    pub verified_edit_cycles: u64,
    /// Number of failed-verify -> edit -> ... cycles.
    #[serde(with = "qos_json::string_or_numeric")]
    pub red_green_cycles: u64,
    /// Overall session outcome classification.
    pub outcome: String,
    /// Distinct Skill names invoked, sorted.
    pub skills: Vec<String>,
    /// Distinct MCP server names invoked, sorted.
    pub mcp_servers: Vec<String>,
    /// Number of background-mode tool invocations.
    #[serde(with = "qos_json::string_or_numeric")]
    pub background_tasks: u64,
}

/// Serialize an `f64` as its decimal string form.
///
/// See the doc comment on [`SessionStats::agenticity`]: this is required
/// because `qos_json`'s canonical JSON encoder rejects non-integer JSON
/// numbers outright, so `agenticity` cannot travel as a bare JSON number.
fn serialize_f64_as_string<S: serde::Serializer>(
    value: &f64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
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

/// Parse each line of `text` as a JSON value, tolerating the odd corrupt or
/// blank line (they're simply skipped rather than aborting the whole trace).
fn parsed_lines(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

/// Parse a raw JSONL trace, auto-detecting the harness.
///
/// Streams the trace at most twice: once (truncated to 10 lines) to sniff
/// which harness produced it, and once more, in full, through that harness's
/// parser. Neither pass collects the whole trace into memory — traces can be
/// tens of megabytes of JSONL, and a `Vec<Value>` of every line multiplies
/// that several times over.
pub fn parse_trace(text: &str) -> Result<SessionStats, ParseError> {
    parse_values(parsed_lines(text))
}

/// Parse a raw JSONL trace supplied as an iterator of already-decoded JSON
/// values, auto-detecting the harness. This is what [`parse_trace`] delegates
/// to, and it's also the entry point the streaming `/analyze_raw` path uses
/// directly: its values come from a line-by-line `Read` adapter over an
/// inflating gzip stream rather than from a `&str`, so there is never a
/// point where the full trace text exists as one `String` or `Vec<Value>`.
///
/// Same two-pass shape as [`parse_trace`]: sniff the harness from the first
/// 10 values (buffered into a small `Vec`), then feed the *full* stream
/// (those 10 values chained with the rest of the iterator) through that
/// harness's parser.
pub fn parse_values(mut lines: impl Iterator<Item = Value>) -> Result<SessionStats, ParseError> {
    let head: Vec<Value> = (&mut lines).take(10).collect();

    if head.is_empty() {
        return Err(ParseError("File is not valid JSONL".to_string()));
    }

    if claude_code::looks_like(&head) {
        claude_code::parse(head.into_iter().chain(lines))
    } else if codex::looks_like(&head) {
        codex::parse(head.into_iter().chain(lines))
    } else {
        Err(ParseError(
            "Unrecognized trace format (expected Claude Code or Codex JSONL)".to_string(),
        ))
    }
}
