//! Trace analysis: the coprocessor endpoint.
//!
//! `POST /analyze` receives a quorum-key-encrypted envelope containing a
//! passport ID and a raw JSONL trace. The enclave decrypts it, parses the
//! trace, and returns the normalized session stats signed by the enclave's
//! ephemeral key — an app proof binding `(passport_id, trace hash, stats)`.
//!
//! `GET /quorum_public_key` exposes the public key clients encrypt to.

use crate::{parsers, response::AppError, state::AppState};
use axum::{Json, extract::State};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
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
}
