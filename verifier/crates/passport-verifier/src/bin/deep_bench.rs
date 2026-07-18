//! Offline benchmark for in-enclave deep analysis.
#![allow(clippy::unwrap_used, clippy::expect_used, missing_docs)]

use passport_verifier::deep::{DeepModel, build_excerpt};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (gguf, tokenizer, trace_path) = (&args[1], &args[2], &args[3]);

    let t0 = Instant::now();
    let model = DeepModel::load(gguf, tokenizer).expect("load model");
    println!("model loaded in {:.1}s", t0.elapsed().as_secs_f32());

    let trace = std::fs::read_to_string(trace_path).expect("read trace");
    let excerpt = build_excerpt(&trace, 2200);
    println!("excerpt: {} chars", excerpt.len());

    let t1 = Instant::now();
    let verdict = model.analyze(&excerpt).expect("analyze");
    println!("analysis in {:.1}s", t1.elapsed().as_secs_f32());
    println!("{}", serde_json::to_string_pretty(&verdict).expect("json"));
}
