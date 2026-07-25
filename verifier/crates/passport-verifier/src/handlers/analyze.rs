//! Trace analysis: the coprocessor endpoint.
//!
//! `POST /analyze` receives a quorum-key-encrypted envelope containing a
//! passport ID and a raw JSONL trace. The enclave decrypts it, parses the
//! trace, and returns the normalized session stats signed by the enclave's
//! ephemeral key — an app proof binding `(passport_id, trace hash, stats)`.
//!
//! `GET /quorum_public_key` exposes the public key clients encrypt to.

use crate::{parsers, response::AppError, state::AppState};
use axum::{Json, body::Bytes, extract::State};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::{self, BufRead, BufReader, Read};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

/// gzip magic bytes: envelopes compressed by newer clients start with these.
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Hard cap on decompressed envelope size. A zip bomb (or a corrupt/hostile
/// stream) must fail cleanly with a 422, never exhaust enclave memory.
const GZIP_DECOMPRESSED_CAP: u64 = 192 * 1024 * 1024;

/// Size of each read from the gzip stream while inflating. Keeping this
/// fixed and small (rather than growing a `Vec` via `read_to_end`, which can
/// double past the cap before the length check ever runs) bounds a bomb's
/// peak memory to roughly cap-at-bail instead of up to 2x the cap.
const INFLATE_CHUNK_BYTES: usize = 1024 * 1024;

/// Hard cap on a single JSONL line's byte length in the `/analyze_raw`
/// streaming path. Without this, a newline-free input (a single-line "zip
/// bomb") would defeat the O(buffer) memory guarantee entirely: reading up
/// to a `\n` with no cap accumulates one unbounded `String` that can reach
/// the full 192MB decompressed cap (with realloc doubling along the way) in
/// one `read_line` call, before the line-handling code ever gets to look at
/// it. 32MB is comfortably larger than any legitimate single JSONL record
/// while still bounding worst-case per-line memory tightly.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// The exact message [`HashingCappedReader`] uses for a cap breach, matched
/// on below to give that specific failure its own error message distinct
/// from other IO failures (corrupt gzip, etc.) that flow through the same
/// `io::Error` path.
const CAP_EXCEEDED_IO_MSG: &str = "gzip envelope exceeds decompressed size cap";

/// Decrypted request envelope. Produced client-side, encrypted to the quorum key.
#[derive(Deserialize)]
struct AnalyzeEnvelope {
    /// Passport this trace belongs to; echoed into the signed payload so a
    /// proof cannot be replayed onto another passport.
    passport_id: String,
    /// Raw JSONL trace text.
    trace: String,
}

#[derive(Deserialize)]
pub(crate) struct AnalyzeRequest {
    /// Hex-encoded ciphertext of an [`AnalyzeEnvelope`], encrypted to the
    /// quorum key. Legacy field; exactly one of this or `ciphertext_b64`
    /// must be present.
    ciphertext: Option<String>,
    /// Base64-encoded ciphertext of an [`AnalyzeEnvelope`], encrypted to the
    /// quorum key. Preferred over `ciphertext` (hex): ~33% smaller on the
    /// wire for large traces.
    ciphertext_b64: Option<String>,
}

/// Decode the request's ciphertext field, whichever of the two encodings is present.
fn decode_ciphertext(request: &AnalyzeRequest) -> Result<Vec<u8>, AppError> {
    match (&request.ciphertext, &request.ciphertext_b64) {
        (Some(hex), None) => qos_hex::decode(hex)
            .map_err(|e| AppError::bad_request(format!("invalid ciphertext hex: {e:?}"))),
        (None, Some(b64)) => BASE64
            .decode(b64)
            .map_err(|e| AppError::bad_request(format!("invalid ciphertext base64: {e}"))),
        (Some(_), Some(_)) => Err(AppError::bad_request(
            "exactly one of ciphertext or ciphertext_b64 must be present",
        )),
        (None, None) => Err(AppError::bad_request(
            "one of ciphertext or ciphertext_b64 is required",
        )),
    }
}

/// If `plaintext` is gzip-compressed (client-side envelope compression for
/// large traces), inflate it under a hard size cap; otherwise return it
/// unchanged. A stream that inflates past the cap is rejected outright
/// rather than silently truncated, since a truncated envelope would just
/// fail JSON parsing downstream with a confusing error.
///
/// Reads in fixed 1 MB chunks and checks the running total against the cap
/// *before* appending each chunk, so a bomb is rejected with peak memory
/// approximately equal to the cap rather than up to 2x it (which
/// `.take(CAP+1).read_to_end()` would allow, since `Vec` growth can double
/// past the cap before the post-hoc length check ever runs).
///
/// `GzDecoder` only reads the first gzip member of the stream and ignores
/// any trailing bytes after it. That's safe here: the trace hash committed
/// to in the signed proof is computed over the *inflated* envelope's `trace`
/// field (see `trace_sha256` below), and the sender is only ever encrypting
/// their own envelope — there's no multi-member-stream trick that lets a
/// second member smuggle content past the hash that gets signed.
fn maybe_inflate(plaintext: Vec<u8>) -> Result<Vec<u8>, AppError> {
    if plaintext.len() < 2 || plaintext[..2] != GZIP_MAGIC {
        return Ok(plaintext);
    }
    let mut decoder = GzDecoder::new(plaintext.as_slice());
    let mut inflated: Vec<u8> = Vec::new();
    let mut buf = [0u8; INFLATE_CHUNK_BYTES];
    loop {
        let n = decoder
            .read(&mut buf)
            .map_err(|e| AppError::unprocessable(format!("failed to inflate gzip envelope: {e}")))?;
        if n == 0 {
            break;
        }
        if inflated.len() as u64 + n as u64 > GZIP_DECOMPRESSED_CAP {
            return Err(AppError::unprocessable(
                "gzip envelope exceeds decompressed size cap",
            ));
        }
        // Reserve exactly the space this chunk needs instead of letting
        // `extend_from_slice` fall back to `Vec`'s amortized-doubling growth
        // when capacity runs out. Doubling growth near the cap can reserve
        // up to ~2x the cap's worth of memory before the length check above
        // ever gets a chance to bail on the *next* chunk — `reserve_exact`
        // bounds each growth step to this chunk's size (<= 1 MB), so peak
        // memory stays within one chunk of the cap rather than up to 2x it.
        inflated.reserve_exact(n);
        inflated.extend_from_slice(&buf[..n]);
    }
    Ok(inflated)
}

/// The exact payload that gets canonically serialized and signed.
#[derive(Serialize)]
struct AnalyzePayload {
    passport_id: String,
    /// SHA-256 of the plaintext trace, hex-encoded. Binds the proof to the
    /// exact trace that was analyzed.
    trace_sha256: String,
    stats: parsers::SessionStats,
    /// Unix seconds at analysis time.
    #[serde(with = "qos_json::string_or_numeric")]
    analyzed_at: u64,
}

#[derive(Serialize)]
struct AppProof {
    #[serde(with = "qos_hex::serde")]
    public_key: Vec<u8>,
    /// The exact serialized payload, so clients can verify the signature
    /// without re-deriving canonical serialization.
    payload: String,
    #[serde(with = "qos_hex::serde")]
    signature: Vec<u8>,
}

#[derive(Serialize)]
pub(crate) struct AnalyzeResponse {
    payload: AnalyzePayload,
    proof: AppProof,
}

#[derive(Serialize)]
pub(crate) struct QuorumPublicKeyResponse {
    #[serde(with = "qos_hex::serde")]
    public_key: Vec<u8>,
}

pub(crate) async fn quorum_public_key(
    State(state): State<AppState>,
) -> Json<QuorumPublicKeyResponse> {
    Json(QuorumPublicKeyResponse {
        public_key: state.quorum_key.public_key().to_bytes(),
    })
}

pub(crate) async fn analyze(
    State(state): State<AppState>,
    Json(request): Json<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, AppError> {
    let ciphertext = decode_ciphertext(&request)?;
    let plaintext = state
        .quorum_key
        .decrypt(&ciphertext)
        .map_err(|e| AppError::bad_request(format!("failed to decrypt ciphertext: {e:?}")))?;
    let plaintext = maybe_inflate(plaintext.to_vec())?;
    let envelope: AnalyzeEnvelope = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::bad_request(format!("invalid envelope JSON: {e}")))?;

    if envelope.passport_id.is_empty() {
        return Err(AppError::bad_request("passport_id is required"));
    }

    let stats = parsers::parse_trace(&envelope.trace)
        .map_err(|e| AppError::unprocessable(format!("trace rejected: {e}")))?;

    let trace_sha256 = qos_hex::encode(&Sha256::digest(envelope.trace.as_bytes()));
    let analyzed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::internal(format!("system clock error: {e}")))?
        .as_secs();

    let payload = AnalyzePayload {
        passport_id: envelope.passport_id,
        trace_sha256,
        stats,
        analyzed_at,
    };

    let payload_bytes = qos_json::to_vec(&payload)
        .map_err(|e| AppError::internal(format!("failed to serialize proof payload: {e}")))?;
    let signature = state
        .ephemeral_key
        .sign(&payload_bytes)
        .map_err(|e| AppError::internal(format!("failed to sign proof payload: {e:?}")))?;
    let payload_string = String::from_utf8(payload_bytes)
        .map_err(|e| AppError::internal(format!("failed to encode proof payload: {e}")))?;

    Ok(Json(AnalyzeResponse {
        payload,
        proof: AppProof {
            public_key: state.ephemeral_key.public_key().to_bytes(),
            payload: payload_string,
            signature,
        },
    }))
}

/// A `Read` adapter over the inflating gzip stream that (a) caps total bytes
/// produced at [`GZIP_DECOMPRESSED_CAP`] — the same zip-bomb protection
/// `maybe_inflate` gives the JSON path — and (b) feeds every produced byte
/// into a running SHA-256 hash, so `trace_sha256` never requires buffering
/// the inflated trace anywhere.
struct HashingCappedReader<R> {
    inner: R,
    hasher: Sha256,
    total: u64,
}

impl<R: Read> HashingCappedReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            total: 0,
        }
    }
}

impl<R: Read> Read for HashingCappedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 {
            return Ok(0);
        }
        self.total += n as u64;
        if self.total > GZIP_DECOMPRESSED_CAP {
            return Err(io::Error::other(CAP_EXCEEDED_IO_MSG));
        }
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

/// Parse the raw binary envelope framing (see `web/src/lib/qosCrypto.ts`
/// `buildBinaryEnvelope`): a u16-LE byte-length of the utf8 `passport_id`,
/// the `passport_id` bytes themselves, then the gzip payload. Returns the
/// passport id and a slice of `plaintext` covering just the gzip bytes.
fn parse_raw_framing(plaintext: &[u8]) -> Result<(String, &[u8]), AppError> {
    if plaintext.len() < 2 {
        return Err(AppError::bad_request(
            "envelope too short for passport_id length prefix",
        ));
    }
    let id_len = u16::from_le_bytes([plaintext[0], plaintext[1]]) as usize;
    let rest = &plaintext[2..];
    if id_len > rest.len() {
        return Err(AppError::bad_request(
            "passport_id length exceeds envelope size",
        ));
    }
    let (id_bytes, gz) = rest.split_at(id_len);
    let passport_id = std::str::from_utf8(id_bytes)
        .map_err(|e| AppError::bad_request(format!("passport_id is not valid utf8: {e}")))?
        .to_string();
    if passport_id.is_empty() {
        return Err(AppError::bad_request("passport_id is required"));
    }
    if gz.len() < 2 || gz[..2] != GZIP_MAGIC {
        return Err(AppError::bad_request(
            "expected gzip magic bytes after passport_id",
        ));
    }
    Ok((passport_id, gz))
}

/// `POST /analyze_raw`: the streaming counterpart to `/analyze`. The request
/// body is the raw quorum-key ciphertext (no JSON wrapper, no hex/base64
/// re-encoding); the decrypted plaintext is the binary envelope described in
/// [`parse_raw_framing`], carrying a gzip-compressed raw JSONL trace instead
/// of a JSON `{passport_id, trace}` object.
///
/// Memory discipline is the entire point of this endpoint: unlike `/analyze`,
/// there is no full-trace `String` and no unbounded `Vec` anywhere in this
/// pipeline. The gzip payload is inflated through a chain of `Read` adapters
/// — `GzDecoder` -> [`HashingCappedReader`] (caps size, hashes as it goes) ->
/// `BufReader::lines()` -- and each line is parsed into a `Value` and handed
/// straight to the harness parser, mirroring [`parsers::parsed_lines`]'s
/// line handling (trim, skip blank/unparseable lines) exactly.
///
/// Trailing-data semantics: any bytes after the last newline that fail to
/// parse as JSON are silently skipped, same as every other line — this
/// endpoint does not distinguish "trailing garbage" from "one bad line in
/// the middle" (see the tests below for `analyze_raw_ignores_trailing_garbage_but_still_hashes_it`).
/// Those bytes are still read through the hashing reader and are still
/// included in `trace_sha256`, since the hash commits to every byte of the
/// inflated stream, not just the bytes that happened to parse.
///
/// Per-line memory is bounded too: lines are read manually via
/// `read_until` through a [`MAX_LINE_BYTES`]-limited `Take`, rather than
/// `BufRead::lines()`. `lines()` has no per-line cap of its own -- a
/// newline-free input (a single-line "zip bomb") would otherwise accumulate
/// one unbounded `String` up to the full decompressed cap (with realloc
/// doubling along the way) before any line-handling code ever ran. A line
/// that hits the cap without finding a newline is rejected outright (422)
/// rather than silently truncated.
pub(crate) async fn analyze_raw(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<AnalyzeResponse>, AppError> {
    let plaintext = state
        .quorum_key
        .decrypt(&body)
        .map_err(|e| AppError::bad_request(format!("failed to decrypt ciphertext: {e:?}")))?;
    drop(body);

    let (passport_id, gz) = parse_raw_framing(&plaintext)?;

    let cap_reader = HashingCappedReader::new(GzDecoder::new(gz));
    // 1 MB (vs. the 8KB default): far fewer syscalls/refills across a large
    // trace, which is what actually dominates inflate time for this path.
    let mut buf_reader = BufReader::with_capacity(1024 * 1024, cap_reader);

    // Distinguishes *why* the stream reader stopped early, so callers get a
    // specific error message instead of one generic "failed to inflate"
    // for every failure mode.
    enum StreamFailure {
        Io(io::Error),
        InvalidUtf8,
        LineTooLong,
    }

    // Shared with the `from_fn` iterator below: a manual `read_until` loop
    // (unlike `BufRead::lines()`) stops cleanly on its own once we choose
    // to stop calling it, but the closure still needs a way to hand the
    // failure detail back out to the caller once the iterator is dropped.
    let failure: Rc<RefCell<Option<StreamFailure>>> = Rc::new(RefCell::new(None));
    let failure_writer = Rc::clone(&failure);

    let parse_result = {
        let mut reader = &mut buf_reader;
        // Mirrors `parsers::parsed_lines`: trim each line, silently skip
        // ones that don't parse as JSON (blank lines, trailing garbage,
        // the odd corrupt line) -- except a line that overruns
        // `MAX_LINE_BYTES` without a newline, which is a hard error.
        let values = std::iter::from_fn(move || {
            let mut line_buf: Vec<u8> = Vec::new();
            loop {
                line_buf.clear();
                let read = {
                    let mut limited = (&mut reader).take(MAX_LINE_BYTES as u64);
                    limited.read_until(b'\n', &mut line_buf)
                };
                let read = match read {
                    Ok(n) => n,
                    Err(e) => {
                        *failure_writer.borrow_mut() = Some(StreamFailure::Io(e));
                        return None;
                    }
                };
                if read == 0 {
                    // True EOF: nothing left to read at all.
                    return None;
                }
                let hit_newline = line_buf.last() == Some(&b'\n');
                if !hit_newline && line_buf.len() as u64 >= MAX_LINE_BYTES as u64 {
                    // The `take`-limited read_until exhausted its whole
                    // limit without finding a `\n`: this line is too long.
                    *failure_writer.borrow_mut() = Some(StreamFailure::LineTooLong);
                    return None;
                }
                let trimmed: &[u8] = {
                    let mut end = line_buf.len();
                    while end > 0 && (line_buf[end - 1] == b'\n' || line_buf[end - 1] == b'\r') {
                        end -= 1;
                    }
                    let mut start = 0;
                    while start < end && line_buf[start].is_ascii_whitespace() {
                        start += 1;
                    }
                    while end > start && line_buf[end - 1].is_ascii_whitespace() {
                        end -= 1;
                    }
                    &line_buf[start..end]
                };
                if trimmed.is_empty() {
                    continue;
                }
                let text = match std::str::from_utf8(trimmed) {
                    Ok(s) => s,
                    Err(_) => {
                        *failure_writer.borrow_mut() = Some(StreamFailure::InvalidUtf8);
                        return None;
                    }
                };
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    return Some(value);
                }
                // Unparseable line: skip, same as the JSON path.
            }
        });
        parsers::parse_values(values)
    };

    if let Some(failure) = failure.borrow_mut().take() {
        return Err(AppError::unprocessable(match failure {
            StreamFailure::Io(e) if e.to_string() == CAP_EXCEEDED_IO_MSG => {
                "decompressed size cap exceeded".to_string()
            }
            StreamFailure::Io(e) => format!("failed to inflate gzip envelope: {e}"),
            StreamFailure::InvalidUtf8 => "trace is not valid UTF-8".to_string(),
            StreamFailure::LineTooLong => "line exceeds 32 MB".to_string(),
        }));
    }
    let stats =
        parse_result.map_err(|e| AppError::unprocessable(format!("trace rejected: {e}")))?;

    // The parser may not have consumed every byte of the stream (e.g. it
    // could in principle stop early), so drain to EOF through a small fixed
    // buffer before finalizing the hash -- this guarantees `trace_sha256`
    // commits to every inflated byte, including any trailing data after the
    // parser's last consumed line, not just the bytes the parser happened
    // to read.
    let mut sink = [0u8; 64 * 1024];
    loop {
        match buf_reader.read(&mut sink) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.to_string() == CAP_EXCEEDED_IO_MSG => {
                return Err(AppError::unprocessable("decompressed size cap exceeded"));
            }
            Err(e) => {
                return Err(AppError::unprocessable(format!(
                    "failed to inflate gzip envelope: {e}"
                )));
            }
        }
    }
    let cap_reader = buf_reader.into_inner();
    let trace_sha256 = qos_hex::encode(&cap_reader.hasher.finalize());

    let analyzed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::internal(format!("system clock error: {e}")))?
        .as_secs();

    let payload = AnalyzePayload {
        passport_id,
        trace_sha256,
        stats,
        analyzed_at,
    };

    let payload_bytes = qos_json::to_vec(&payload)
        .map_err(|e| AppError::internal(format!("failed to serialize proof payload: {e}")))?;
    let signature = state
        .ephemeral_key
        .sign(&payload_bytes)
        .map_err(|e| AppError::internal(format!("failed to sign proof payload: {e:?}")))?;
    let payload_string = String::from_utf8(payload_bytes)
        .map_err(|e| AppError::internal(format!("failed to encode proof payload: {e}")))?;

    Ok(Json(AnalyzeResponse {
        payload,
        proof: AppProof {
            public_key: state.ephemeral_key.public_key().to_bytes(),
            payload: payload_string,
            signature,
        },
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn maybe_inflate_passes_plain_json_through_unchanged() {
        let plain = br#"{"passport_id":"p","trace":"line\n"}"#.to_vec();
        assert_eq!(maybe_inflate(plain.clone()).unwrap(), plain);
    }

    #[test]
    fn maybe_inflate_inflates_gzipped_envelope() {
        let plain = br#"{"passport_id":"p","trace":"line\n"}"#.to_vec();
        let gzipped = gzip(&plain);
        assert_eq!(maybe_inflate(gzipped).unwrap(), plain);
    }

    #[test]
    fn maybe_inflate_rejects_stream_past_cap() {
        // Highly compressible input that inflates just past the 192MB cap;
        // keep the compressed (and in-memory decompressed) size small by
        // using a gzip stream that lies about its own length being tiny
        // while actually decompressing to just over the cap. We approximate
        // this deterministically by writing repeated zero chunks a little
        // past the cap through the encoder, which stays cheap to build
        // because all-zero input compresses to almost nothing.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let chunk = vec![0u8; 1024 * 1024];
        let cap_chunks = (GZIP_DECOMPRESSED_CAP / chunk.len() as u64) + 8;
        for _ in 0..cap_chunks {
            encoder.write_all(&chunk).unwrap();
        }
        let gzipped = encoder.finish().unwrap();

        let err = maybe_inflate(gzipped).expect_err("stream past cap must error, not succeed");
        // AppError doesn't expose its status/message publicly outside the
        // crate's response module; converting to a response and checking the
        // status code is the black-box way to assert it's a 422.
        use axum::response::IntoResponse;
        let response = err.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn maybe_inflate_rejects_bomb_far_past_cap() {
        // A genuine zip-bomb shape: the stream would inflate to many times
        // the cap (here, ~10x) if allowed to run to completion. The chunked
        // reader must bail out as soon as the running total crosses the
        // cap rather than continuing to inflate (and allocate) the rest of
        // the stream, so this stays cheap to run despite the huge nominal
        // decompressed size.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let chunk = vec![0u8; 1024 * 1024];
        let bomb_chunks = (GZIP_DECOMPRESSED_CAP / chunk.len() as u64) * 10;
        for _ in 0..bomb_chunks {
            encoder.write_all(&chunk).unwrap();
        }
        let gzipped = encoder.finish().unwrap();

        let err = maybe_inflate(gzipped).expect_err("bomb far past cap must error, not succeed");
        use axum::response::IntoResponse;
        let response = err.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn maybe_inflate_accepts_exactly_at_cap() {
        // A stream that inflates to exactly the cap must be accepted, not
        // rejected — the check is `> CAP`, not `>= CAP`.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let payload = vec![0u8; GZIP_DECOMPRESSED_CAP as usize];
        encoder.write_all(&payload).unwrap();
        let gzipped = encoder.finish().unwrap();

        let inflated = maybe_inflate(gzipped).expect("exactly-at-cap stream must be accepted");
        assert_eq!(inflated.len() as u64, GZIP_DECOMPRESSED_CAP);
    }

    #[test]
    fn maybe_inflate_rejects_corrupt_gzip_stream() {
        // Valid gzip magic bytes followed by garbage: the decoder must
        // surface a read error, which maps to a 422 rather than panicking
        // or silently returning a truncated result.
        let mut corrupt = GZIP_MAGIC.to_vec();
        corrupt.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);

        let err = maybe_inflate(corrupt).expect_err("corrupt gzip stream must error, not succeed");
        use axum::response::IntoResponse;
        let response = err.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn decode_ciphertext_requires_exactly_one_field() {
        let neither = AnalyzeRequest {
            ciphertext: None,
            ciphertext_b64: None,
        };
        assert!(decode_ciphertext(&neither).is_err());

        let both = AnalyzeRequest {
            ciphertext: Some("00".to_string()),
            ciphertext_b64: Some("AA==".to_string()),
        };
        assert!(decode_ciphertext(&both).is_err());
    }

    #[test]
    fn decode_ciphertext_accepts_hex_or_base64() {
        let hex_only = AnalyzeRequest {
            ciphertext: Some("deadbeef".to_string()),
            ciphertext_b64: None,
        };
        assert_eq!(
            decode_ciphertext(&hex_only).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );

        let b64_only = AnalyzeRequest {
            ciphertext: None,
            ciphertext_b64: Some(BASE64.encode([0xde, 0xad, 0xbe, 0xef])),
        };
        assert_eq!(
            decode_ciphertext(&b64_only).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    // --- /analyze_raw ---

    fn raw_test_state() -> AppState {
        let ephemeral_key = qos_p256::P256Pair::generate().unwrap();
        let quorum_key = qos_p256::P256Pair::generate().unwrap();
        AppState::new(ephemeral_key, quorum_key)
    }

    /// Build the binary envelope framing (mirrors `buildBinaryEnvelope` in
    /// `web/src/lib/qosCrypto.ts`): u16-LE passport_id length, passport_id
    /// bytes, then the gzip payload.
    fn frame(passport_id: &str, gz: &[u8]) -> Vec<u8> {
        let id_bytes = passport_id.as_bytes();
        let mut out = Vec::new();
        out.extend_from_slice(&(u16::try_from(id_bytes.len()).unwrap()).to_le_bytes());
        out.extend_from_slice(id_bytes);
        out.extend_from_slice(gz);
        out
    }

    fn encrypt_raw(state: &AppState, plaintext: &[u8]) -> axum::body::Bytes {
        let ciphertext = state.quorum_key.public_key().encrypt(plaintext).unwrap();
        axum::body::Bytes::from(ciphertext)
    }

    fn sample_trace() -> &'static str {
        concat!(
            r#"{"type":"user","sessionId":"raw-test","timestamp":"2026-07-10T15:15:45.972Z","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"raw-test","timestamp":"2026-07-10T15:16:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":250},"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}"#,
        )
    }

    fn status_of(err: AppError) -> axum::http::StatusCode {
        use axum::response::IntoResponse;
        err.into_response().status()
    }

    /// Extract the status code and `error` field of an [`AppError`]'s JSON
    /// response body, so tests can assert on *which* failure occurred, not
    /// just the status code -- several distinct failure modes on
    /// `/analyze_raw` share a 422.
    async fn status_and_message(err: AppError) -> (axum::http::StatusCode, String) {
        use axum::response::IntoResponse;
        use http_body_util::BodyExt;
        let response = err.into_response();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, json["error"].as_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn analyze_raw_matches_json_path_stats_and_hash() {
        let json_state = raw_test_state();
        let json_envelope =
            serde_json::json!({ "passport_id": "raw-parity", "trace": sample_trace() });
        let json_ciphertext = json_state
            .quorum_key
            .public_key()
            .encrypt(json_envelope.to_string().as_bytes())
            .unwrap();
        let json_response = analyze(
            State(json_state.clone()),
            Json(AnalyzeRequest {
                ciphertext: Some(qos_hex::encode(&json_ciphertext)),
                ciphertext_b64: None,
            }),
        )
        .await
        .unwrap();

        let raw_state = raw_test_state();
        let gz = gzip(sample_trace().as_bytes());
        let plaintext = frame("raw-parity", &gz);
        let body = encrypt_raw(&raw_state, &plaintext);
        let raw_response = analyze_raw(State(raw_state), body).await.unwrap();

        // Different enclave keys per state, so compare the meaningful
        // subset rather than the full signed payload.
        assert_eq!(
            raw_response.0.payload.trace_sha256,
            qos_hex::encode(&Sha256::digest(sample_trace().as_bytes()))
        );
        assert_eq!(
            json_response.0.payload.trace_sha256,
            raw_response.0.payload.trace_sha256,
            "raw and JSON paths must hash the same inflated trace bytes identically"
        );
        assert_eq!(
            qos_json::to_vec(&json_response.0.payload.stats).unwrap(),
            qos_json::to_vec(&raw_response.0.payload.stats).unwrap(),
            "raw and JSON paths must produce identical stats for the same trace"
        );
        assert_eq!(raw_response.0.payload.passport_id, "raw-parity");
    }

    #[tokio::test]
    async fn analyze_raw_rejects_truncated_length_prefix() {
        let state = raw_test_state();
        let body = encrypt_raw(&state, &[0x01]); // 1 byte, need >= 2
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert_eq!(status_of(err), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn analyze_raw_rejects_length_out_of_bounds() {
        let state = raw_test_state();
        // Claims a 10-byte passport_id but only 1 byte follows.
        let mut plaintext = 10u16.to_le_bytes().to_vec();
        plaintext.push(b'x');
        let body = encrypt_raw(&state, &plaintext);
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert_eq!(status_of(err), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn analyze_raw_rejects_invalid_utf8_passport_id() {
        let state = raw_test_state();
        let id_bytes: [u8; 2] = [0xff, 0xfe]; // not valid utf8
        let mut plaintext = 2u16.to_le_bytes().to_vec();
        plaintext.extend_from_slice(&id_bytes);
        plaintext.extend_from_slice(&gzip(sample_trace().as_bytes()));
        let body = encrypt_raw(&state, &plaintext);
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert_eq!(status_of(err), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn analyze_raw_rejects_missing_gzip_magic() {
        let state = raw_test_state();
        let plaintext = frame("no-gzip", b"not gzip data");
        let body = encrypt_raw(&state, &plaintext);
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert_eq!(status_of(err), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn analyze_raw_rejects_stream_past_cap_with_distinct_message() {
        let state = raw_test_state();
        // Highly compressible input that inflates well past the 192MB cap;
        // cheap to build and ship since it's all zeroes. Each ~1MB chunk is
        // newline-terminated so this exercises the *decompressed-size-cap*
        // path specifically (HashingCappedReader / CAP_EXCEEDED_IO_MSG),
        // not the per-line cap from `analyze_raw_rejects_newline_free_line_over_cap`
        // -- an unbroken newline-free stream would trip the 32MB line cap
        // long before ever reaching the 192MB decompressed cap. Also
        // asserts the error message text so the two 422 cap-style failures
        // (decompressed-size cap vs. per-line cap) are distinguishable.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut chunk = vec![0u8; 1024 * 1024 - 1];
        chunk.push(b'\n');
        let cap_chunks = (GZIP_DECOMPRESSED_CAP / chunk.len() as u64) + 8;
        for _ in 0..cap_chunks {
            encoder.write_all(&chunk).unwrap();
        }
        let gz = encoder.finish().unwrap();
        let plaintext = frame("bomb", &gz);
        let body = encrypt_raw(&state, &plaintext);
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        let (status, message) = status_and_message(err).await;
        assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(message, "decompressed size cap exceeded");
        assert_ne!(
            message, "line exceeds 32 MB",
            "cap breach must not be reported as a per-line overrun"
        );
    }

    #[tokio::test]
    async fn analyze_raw_rejects_newline_free_line_over_cap() {
        let state = raw_test_state();
        // No newlines at all: a single "line" larger than MAX_LINE_BYTES
        // would otherwise defeat the O(buffer) memory guarantee. All-zero
        // bytes compress to almost nothing, so this stays cheap to build.
        let huge_line = vec![b'0'; MAX_LINE_BYTES + 1024];
        let gz = gzip(&huge_line);
        let plaintext = frame("line-bomb", &gz);
        let body = encrypt_raw(&state, &plaintext);
        let err = match analyze_raw(State(state), body).await {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        let (status, message) = status_and_message(err).await;
        assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(message, "line exceeds 32 MB");
        assert_ne!(
            message, "decompressed size cap exceeded",
            "per-line overrun must not be reported as a decompressed-cap breach"
        );
    }

    #[tokio::test]
    async fn analyze_raw_accepts_legit_multi_mb_single_line() {
        let state = raw_test_state();
        // A single legitimate JSONL line comfortably over 1MB (well under
        // the 32MB per-line cap) must still parse successfully.
        let padding = "x".repeat(1024 * 1024);
        let line = serde_json::json!({
            "type": "user",
            "sessionId": "big-line",
            "timestamp": "2026-07-10T15:15:45.972Z",
            "message": {"role": "user", "content": format!("hello {padding}")}
        })
        .to_string();
        assert!(line.len() as u64 > 1024 * 1024);
        assert!((line.len() as u64) < MAX_LINE_BYTES as u64);

        let gz = gzip(line.as_bytes());
        let plaintext = frame("big-line-passport", &gz);
        let body = encrypt_raw(&state, &plaintext);
        let response = analyze_raw(State(state), body).await.unwrap();
        assert_eq!(response.0.payload.passport_id, "big-line-passport");
    }

    /// Documents and locks in the trailing-garbage semantic described on
    /// [`analyze_raw`]'s doc comment: bytes after the trace's final newline
    /// that don't parse as JSON are silently skipped (same as any other
    /// unparseable line), but are still read through the hashing reader and
    /// still count toward `trace_sha256` -- the hash commits to every
    /// inflated byte, not just the ones the parser consumed.
    #[tokio::test]
    async fn analyze_raw_ignores_trailing_garbage_but_still_hashes_it() {
        let state = raw_test_state();
        let mut inflated = sample_trace().as_bytes().to_vec();
        inflated.extend_from_slice(b"\nnot json, trailing garbage with no newline");
        let gz = gzip(&inflated);
        let plaintext = frame("trailing-garbage", &gz);
        let body = encrypt_raw(&state, &plaintext);
        let response = analyze_raw(State(state), body).await.unwrap();

        assert_eq!(
            response.0.payload.trace_sha256,
            qos_hex::encode(&Sha256::digest(&inflated)),
            "trace_sha256 must cover the trailing garbage bytes too"
        );
    }
}
