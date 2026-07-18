//! Deep analysis: a small language model, run entirely inside the enclave.
//!
//! The model weights ship inside the enclave image; nothing is fetched and
//! nothing conversational ever leaves. The model reads a distilled excerpt of
//! the session and emits a structured classification, which is then signed
//! like every other fact. CPU-only (Nitro enclaves have no GPU) — model size
//! is chosen for latency.

use candle_core::{Device, Tensor};
use candle_transformers::generation::{LogitsProcessor, Sampling};
use candle_transformers::models::quantized_llama::ModelWeights as LlamaWeights;
use crate::deep_qwen3::ModelWeights as Qwen3Weights;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tokenizers::Tokenizer;

/// Structured verdict from the in-enclave model.
#[derive(Debug, Serialize)]
pub struct DeepAnalysis {
    /// Primary task type: debugging | feature | refactor | research | ops | other
    pub task_type: String,
    /// 1-5: how specific and contextual the user's prompts are.
    pub prompt_specificity: u8,
    /// 1-5: how actively the user steers, corrects, and verifies.
    pub steering: u8,
    /// One-sentence, non-identifying summary of what the session accomplished.
    pub summary: String,
    /// Model that produced this verdict (from the GGUF, not configurable).
    pub model: String,
}

/// Architecture dispatch: both expose the same forward(input, offset) shape.
pub enum Weights {
    Qwen3(Qwen3Weights),
    Llama(LlamaWeights),
}

impl Weights {
    fn forward(&mut self, input: &Tensor, offset: usize) -> Result<Tensor, candle_core::Error> {
        match self {
            Weights::Qwen3(w) => w.forward(input, offset),
            Weights::Llama(w) => w.forward(input, offset),
        }
    }

    /// quantized_llama's causal mask can't handle multi-token chunks at a
    /// nonzero offset; with its small vocab, one-shot prefill is affordable.
    fn prefill_chunk(&self) -> usize {
        match self {
            Weights::Qwen3(_) => 32,
            Weights::Llama(_) => usize::MAX,
        }
    }
}

/// The loaded model. Wrapped in a Mutex: candle's forward pass needs &mut.
pub struct DeepModel {
    weights: Mutex<Weights>,
    tokenizer: Tokenizer,
    model_name: String,
}

pub struct DeepError(pub String);

impl std::fmt::Debug for DeepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn err<E: std::fmt::Display>(context: &'static str) -> impl Fn(E) -> DeepError {
    move |e| DeepError(format!("{context}: {e}"))
}

impl DeepModel {
    /// Load a Qwen3-family GGUF and its tokenizer from disk.
    pub fn load(gguf_path: &str, tokenizer_path: &str) -> Result<Self, DeepError> {
        let mut file = std::fs::File::open(gguf_path)
            .map_err(|e| DeepError(format!("open gguf: {e}")))?;
        let content = candle_core::quantized::gguf_file::Content::read(&mut file)
            .map_err(|e| DeepError(format!("read gguf: {e}")))?;
        let model_name = content
            .metadata
            .get("general.name")
            .and_then(|v| v.to_string().ok().cloned())
            .unwrap_or_else(|| "qwen3".to_string());
        let arch = content
            .metadata
            .get("general.architecture")
            .and_then(|v| v.to_string().ok().cloned())
            .unwrap_or_default();
        let weights = match arch.as_str() {
            "qwen3" => Weights::Qwen3(
                Qwen3Weights::from_gguf(content, &mut file, &Device::Cpu)
                    .map_err(|e| DeepError(format!("load weights: {e}")))?,
            ),
            "llama" => Weights::Llama(
                LlamaWeights::from_gguf(content, &mut file, &Device::Cpu)
                    .map_err(|e| DeepError(format!("load weights: {e}")))?,
            ),
            other => return Err(DeepError(format!("unsupported architecture: {other}"))),
        };
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(err("load tokenizer"))?;
        Ok(Self {
            weights: Mutex::new(weights),
            tokenizer,
            model_name,
        })
    }

    /// Run the classification prompt over a session excerpt.
    pub fn analyze(&self, excerpt: &str) -> Result<DeepAnalysis, DeepError> {
        // Qwen3 wants an empty think block to skip reasoning; other ChatML
        // models would just parrot those tags.
        let assistant_prefix = {
            let weights = self
                .weights
                .lock()
                .map_err(|_| DeepError("model lock poisoned".to_string()))?;
            match *weights {
                Weights::Qwen3(_) => "<think>\n\n</think>\n\n",
                Weights::Llama(_) => "",
            }
        };
        let prompt = format!(
            "<|im_start|>system\nYou grade AI-assisted coding sessions. Reply with ONLY a JSON object: {{\"task_type\": one of debugging|feature|refactor|research|ops|other, \"prompt_specificity\": 1-5 (how specific and contextual the human's prompts are), \"steering\": 1-5 (how actively the human steers, corrects, verifies), \"summary\": one short sentence describing what was accomplished, no names or paths}}<|im_end|>\n<|im_start|>user\n{excerpt}<|im_end|>\n<|im_start|>assistant\n{assistant_prefix}"
        );
        let tokens = self
            .tokenizer
            .encode(prompt.as_str(), true)
            .map_err(err("tokenize"))?;
        let mut all_tokens = tokens.get_ids().to_vec();
        let prompt_len = all_tokens.len();

        let mut weights = self
            .weights
            .lock()
            .map_err(|_| DeepError("model lock poisoned".to_string()))?;
        let mut logits_processor = LogitsProcessor::from_sampling(299792458, Sampling::ArgMax);

        let device = Device::Cpu;
        let eos = self
            .tokenizer
            .token_to_id("<|im_end|>")
            .unwrap_or(151645);

        // Chunked prefill: bounded intermediate activations keep peak memory
        // small enough for a 1 GB enclave.
        let prefill_chunk = weights.prefill_chunk().min(all_tokens.len());
        let mut last_logits = None;
        let mut offset = 0;
        for chunk in all_tokens.chunks(prefill_chunk) {
            let input = Tensor::new(chunk, &device)
                .and_then(|t| t.unsqueeze(0))
                .map_err(|e| DeepError(format!("prefill tensor: {e}")))?;
            let logits = weights
                .forward(&input, offset)
                .map_err(|e| DeepError(format!("prefill: {e}")))?;
            offset += chunk.len();
            last_logits = Some(logits);
        }
        let logits = last_logits
            .ok_or_else(|| DeepError("empty prompt".to_string()))?
            .squeeze(0)
            .map_err(|e| DeepError(format!("squeeze: {e}")))?;
        let mut next = logits_processor
            .sample(&logits)
            .map_err(|e| DeepError(format!("sample: {e}")))?;
        all_tokens.push(next);

        // Decode up to 200 tokens of JSON.
        for index in 0..200 {
            if next == eos {
                break;
            }
            let input = Tensor::new(&[next], &device)
                .and_then(|t| t.unsqueeze(0))
                .map_err(|e| DeepError(format!("step tensor: {e}")))?;
            let logits = weights
                .forward(&input, prompt_len + index)
                .map_err(|e| DeepError(format!("step: {e}")))?;
            let logits = logits
                .squeeze(0)
                .map_err(|e| DeepError(format!("squeeze: {e}")))?;
            next = logits_processor
                .sample(&logits)
                .map_err(|e| DeepError(format!("sample: {e}")))?;
            all_tokens.push(next);
        }

        let output = self
            .tokenizer
            .decode(&all_tokens[prompt_len..], true)
            .map_err(err("decode"))?;
        parse_verdict(&output, &self.model_name)
    }
}

fn clamp_grade(v: Option<&Value>) -> u8 {
    v.and_then(Value::as_u64).unwrap_or(3).clamp(1, 5) as u8
}

fn parse_verdict(output: &str, model_name: &str) -> Result<DeepAnalysis, DeepError> {
    let start = output.find('{');
    let end = output.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        return Err(DeepError(format!("model returned no JSON: {output:.120}")));
    };
    let parsed: Value = serde_json::from_str(&output[start..=end])
        .map_err(|e| DeepError(format!("model JSON invalid: {e} — output: {}", &output[start..=end])))?;

    const TASKS: [&str; 6] = ["debugging", "feature", "refactor", "research", "ops", "other"];
    let task = parsed
        .get("task_type")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .filter(|t| TASKS.contains(&t.as_str()))
        .unwrap_or_else(|| "other".to_string());

    Ok(DeepAnalysis {
        task_type: task,
        prompt_specificity: clamp_grade(parsed.get("prompt_specificity")),
        steering: clamp_grade(parsed.get("steering")),
        summary: parsed
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(200)
            .collect(),
        model: model_name.to_string(),
    })
}

/// Distill a trace into a compact excerpt: the human's prompts plus a sample
/// of assistant text, capped so prefill stays fast on CPU.
pub fn build_excerpt(trace: &str, budget_chars: usize) -> String {
    let mut user_parts: Vec<String> = Vec::new();
    let mut assistant_parts: Vec<String> = Vec::new();

    for line in trace.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let line_type = v.get("type").and_then(Value::as_str);
        let message = v.get("message");
        match line_type {
            Some("user") => {
                if let Some(text) = message.and_then(|m| m.get("content")).and_then(Value::as_str)
                {
                    // Skip tool results and system-injected content.
                    if !text.starts_with('<') && !text.starts_with('{') {
                        user_parts.push(text.chars().take(500).collect());
                    }
                }
            }
            Some("assistant") => {
                if let Some(blocks) = message
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) == Some("text")
                            && let Some(text) = b.get("text").and_then(Value::as_str)
                        {
                            assistant_parts.push(text.chars().take(300).collect());
                        }
                    }
                }
            }
            Some("response_item") => {
                // Codex: payload.type message with content array of text items.
                if let Some(p) = v.get("payload")
                    && p.get("type").and_then(Value::as_str) == Some("message")
                    && let Some(items) = p.get("content").and_then(Value::as_array)
                {
                    for item in items {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            assistant_parts.push(text.chars().take(300).collect());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut excerpt = String::from("HUMAN PROMPTS:\n");
    for p in &user_parts {
        if excerpt.len() > budget_chars * 2 / 3 {
            break;
        }
        excerpt.push_str("- ");
        excerpt.push_str(p);
        excerpt.push('\n');
    }
    excerpt.push_str("\nASSISTANT (sampled):\n");
    for p in assistant_parts.iter().take(10) {
        if excerpt.len() > budget_chars {
            break;
        }
        excerpt.push_str("- ");
        excerpt.push_str(p);
        excerpt.push('\n');
    }
    excerpt.chars().take(budget_chars).collect()
}
