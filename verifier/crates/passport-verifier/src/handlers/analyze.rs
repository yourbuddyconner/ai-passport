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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// Hex-encoded ciphertext of an [`AnalyzeEnvelope`], encrypted to the quorum key.
    ciphertext: String,
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
    let ciphertext = qos_hex::decode(&request.ciphertext)
        .map_err(|e| AppError::bad_request(format!("invalid ciphertext hex: {e:?}")))?;
    let plaintext = state
        .quorum_key
        .decrypt(&ciphertext)
        .map_err(|e| AppError::bad_request(format!("failed to decrypt ciphertext: {e:?}")))?;
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
