//! Shared trace heuristics — line-for-line port of worker/src/parsers/heuristics.ts.
//! Any change here MUST be mirrored there; shared test fixtures enforce parity.

use regex::Regex;
use std::sync::LazyLock;

static PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(cd\s|export\s|source\s|nvm\s|conda\s|\w+=\S*\s*$)").unwrap());

static RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("test", Regex::new(r"\b(vitest|jest|pytest|playwright|nextest|(cargo|go|npm|pnpm|yarn|bun|make) test)\b").unwrap()),
        ("build", Regex::new(r"\b((npm|pnpm|yarn|bun) run build|cargo build|tsc\b|vite build|make(\s|$)|docker build)\b").unwrap()),
        ("package", Regex::new(r"\b((npm|pnpm|yarn|bun) (install|add|i)\b|pip3? install|cargo add|brew install)").unwrap()),
        ("git", Regex::new(r"(^|\s)git\s").unwrap()),
        ("search", Regex::new(r"^\s*(grep|rg|find|fd|ag)\b").unwrap()),
        ("network", Regex::new(r"^\s*(curl|wget|gh|ssh)\b").unwrap()),
        ("ops", Regex::new(r"^\s*(kubectl|docker|terraform|wrangler|aws|gcloud|flyctl|npx wrangler)\b").unwrap()),
        ("run", Regex::new(r"^\s*(node|python3?|npx|bash|sh|cargo run|(npm|pnpm|yarn|bun) run|\./)").unwrap()),
        ("file", Regex::new(r"^\s*(ls|cat|mkdir|cp|mv|rm|touch|head|tail|wc|sed|awk|echo|printf|chmod|sqlite3|jq|diff|tar|unzip)\b").unwrap()),
    ]
});

static COMMIT_RX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bgit\b[^|;&]*\bcommit\b").unwrap());
static SHIP_RX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgit push\b|\bgh pr create\b|\bwrangler (deploy|publish)\b|\bflyctl deploy\b").unwrap()
});
static GENERATED_RX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"package-lock\.json|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)$|/node_modules/|/dist/|/target/|/build/").unwrap()
});

pub(crate) fn deprefix(cmd: &str) -> String {
    let mut segs: Vec<&str> = cmd.split(|c| c == ';').flat_map(|s| s.split("&&")).collect();
    while let Some(first) = segs.first() {
        let probe = format!("{} ", first.trim());
        if PREFIX.is_match(&probe) {
            segs.remove(0);
        } else {
            break;
        }
    }
    let joined = segs.join("&&").trim().to_string();
    if joined.is_empty() { cmd.to_string() } else { joined }
}

pub(crate) fn classify_command(cmd: &str) -> &'static str {
    let c = deprefix(cmd);
    for (name, rx) in RULES.iter() {
        if rx.is_match(&c) {
            return name;
        }
    }
    "other"
}

pub(crate) fn is_verify(cmd: &str) -> bool {
    matches!(classify_command(cmd), "test" | "build")
}

pub(crate) fn is_commit(cmd: &str) -> bool {
    COMMIT_RX.is_match(cmd)
}

pub(crate) fn is_ship(cmd: &str) -> bool {
    SHIP_RX.is_match(cmd)
}

pub(crate) fn is_generated_path(path: &str) -> bool {
    GENERATED_RX.is_match(path)
}

pub(crate) fn normalize_ext(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(dot) if dot > 0 => {
            let ext = base[dot + 1..].to_lowercase();
            match ext.as_str() {
                "tsx" => "ts".into(),
                "jsx" | "mjs" | "cjs" => "js".into(),
                "pyi" => "py".into(),
                _ => ext,
            }
        }
        _ => "other".into(),
    }
}

pub(crate) fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = s.len() / 2;
    if s.len() % 2 == 1 { s[mid] } else { (s[mid - 1] + s[mid]) / 2.0 }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum EventKind {
    Edit,
    Verify,
    Commit,
    Ship,
}

pub(crate) struct OutcomeEvent {
    pub kind: EventKind,
    pub ok: bool,
    pub seq: usize,
}

pub(crate) fn compute_outcome(events: &[OutcomeEvent], tool_call_count: u64) -> String {
    let edits: Vec<usize> = events
        .iter()
        .filter(|e| e.kind == EventKind::Edit)
        .map(|e| e.seq)
        .collect();
    if edits.is_empty() {
        return if tool_call_count >= 10 { "research" } else { "trivial" }.to_string();
    }
    let first_edit = *edits.iter().min().unwrap();
    let last_edit = *edits.iter().max().unwrap();
    if events.iter().any(|e| e.kind == EventKind::Ship && e.ok && e.seq > last_edit) {
        return "shipped".to_string();
    }
    let verifies: Vec<&OutcomeEvent> = events.iter().filter(|e| e.kind == EventKind::Verify).collect();
    let green_after_first = verifies.iter().any(|e| e.ok && e.seq > first_edit);
    let commit_after_last = events
        .iter()
        .any(|e| e.kind == EventKind::Commit && e.ok && e.seq > last_edit);
    if commit_after_last && green_after_first {
        return "landed".to_string();
    }
    if commit_after_last && verifies.is_empty() {
        return "committed".to_string();
    }
    let post: Vec<&&OutcomeEvent> = verifies.iter().filter(|e| e.seq > first_edit).collect();
    if let Some(last) = post.last() {
        return if last.ok { "green" } else { "red" }.to_string();
    }
    "unverified".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deprefix_strips_cd_env_source_prefixes() {
        assert_eq!(deprefix("cd worker && npx vitest run"), "npx vitest run");
        assert_eq!(deprefix("ENVIRONMENT=dev && make deploy"), "make deploy");
        assert_eq!(deprefix("export FOO=1; nvm use 22; pnpm test"), "pnpm test");
        assert_eq!(deprefix("git status"), "git status");
    }

    #[test]
    fn classify_command_cases() {
        let cases: Vec<(&str, &str)> = vec![
            ("cd worker && npx vitest run", "test"),
            ("pnpm test", "test"),
            ("cargo test -p passport-verifier", "test"),
            ("pnpm install", "package"),
            ("npm run build", "build"),
            ("VAR=1 tsc --noEmit", "build"),
            ("git commit -m \"x\"", "git"),
            ("rg -n \"foo\" src/", "search"),
            ("gh pr view 12", "network"),
            ("npx wrangler deploy", "ops"),
            ("kubectl get pods", "ops"),
            ("python3 scripts/x.py", "run"),
            ("cat file.txt", "file"),
            ("sed -i \"\" \"s/a/b/\" f", "file"),
            ("some-custom-binary --flag", "other"),
        ];
        for (cmd, want) in cases {
            assert_eq!(classify_command(cmd), want, "cmd={cmd}");
        }
    }

    #[test]
    fn is_verify_matches_test_and_build() {
        assert!(is_verify("cd worker && npx vitest run"));
        assert!(is_verify("cargo build --release"));
        assert!(!is_verify("git status"));
    }

    #[test]
    fn is_commit_detection() {
        assert!(is_commit("git add -A && git commit -m \"x\""));
        assert!(!is_commit("git status"));
    }

    #[test]
    fn is_ship_detection() {
        assert!(is_ship("git push origin main"));
        assert!(is_ship("gh pr create --fill"));
        assert!(is_ship("npx wrangler deploy"));
        assert!(!is_ship("git commit -m x"));
    }

    #[test]
    fn is_generated_path_cases() {
        assert!(is_generated_path("/a/package-lock.json"));
        assert!(is_generated_path("/a/node_modules/x/y.js"));
        assert!(is_generated_path("/a/src/app.min.js"));
        assert!(!is_generated_path("/a/src/app.ts"));
    }

    #[test]
    fn normalize_ext_cases() {
        assert_eq!(normalize_ext("/a/b/App.TSX"), "ts");
        assert_eq!(normalize_ext("/a/b/mod.rs"), "rs");
        assert_eq!(normalize_ext("/a/b/Makefile"), "other");
    }

    #[test]
    fn median_odd_even_empty() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
        assert_eq!(median(&[]), 0.0);
    }

    fn ev(kind: EventKind, ok: bool, seq: usize) -> OutcomeEvent {
        OutcomeEvent { kind, ok, seq }
    }

    #[test]
    fn compute_outcome_no_edits_research_vs_trivial() {
        assert_eq!(compute_outcome(&[], 10), "research");
        assert_eq!(compute_outcome(&[], 9), "trivial");
    }

    #[test]
    fn compute_outcome_shipped() {
        let events = [ev(EventKind::Edit, true, 1), ev(EventKind::Ship, true, 2)];
        assert_eq!(compute_outcome(&events, 5), "shipped");
    }

    #[test]
    fn compute_outcome_landed() {
        let events = [
            ev(EventKind::Edit, true, 1),
            ev(EventKind::Verify, true, 2),
            ev(EventKind::Commit, true, 3),
        ];
        assert_eq!(compute_outcome(&events, 5), "landed");
    }

    #[test]
    fn compute_outcome_committed() {
        let events = [ev(EventKind::Edit, true, 1), ev(EventKind::Commit, true, 2)];
        assert_eq!(compute_outcome(&events, 5), "committed");
    }

    #[test]
    fn compute_outcome_green() {
        let events = [ev(EventKind::Edit, true, 1), ev(EventKind::Verify, true, 2)];
        assert_eq!(compute_outcome(&events, 5), "green");
    }

    #[test]
    fn compute_outcome_red() {
        let events = [
            ev(EventKind::Edit, true, 1),
            ev(EventKind::Verify, true, 2),
            ev(EventKind::Edit, true, 3),
            ev(EventKind::Verify, false, 4),
        ];
        assert_eq!(compute_outcome(&events, 5), "red");
    }

    #[test]
    fn compute_outcome_unverified() {
        let events = [ev(EventKind::Edit, true, 1)];
        assert_eq!(compute_outcome(&events, 5), "unverified");
    }

    #[test]
    fn compute_outcome_green_before_edit_does_not_count() {
        let events = [ev(EventKind::Verify, true, 1), ev(EventKind::Edit, true, 2)];
        assert_eq!(compute_outcome(&events, 5), "unverified");
    }

    #[test]
    fn compute_outcome_failed_ship_does_not_count() {
        let events = [ev(EventKind::Edit, true, 1), ev(EventKind::Ship, false, 2)];
        assert_eq!(compute_outcome(&events, 5), "unverified");
    }
}
