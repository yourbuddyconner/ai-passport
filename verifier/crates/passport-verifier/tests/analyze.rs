//! Integration tests for the /analyze coprocessor endpoint: encrypt an
//! envelope to the quorum key, analyze it, and verify the returned app proof.
#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used)]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use passport_verifier::router::{AppState, router_with_state};
use qos_p256::{P256Pair, P256Public};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const CLAUDE_TRACE: &str = concat!(
    r#"{"type":"user","sessionId":"abc-123","timestamp":"2026-07-10T15:15:45.972Z","message":{"role":"user","content":"hello"}}"#,
    "\n",
    r#"{"type":"assistant","sessionId":"abc-123","timestamp":"2026-07-10T15:16:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":250},"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#,
);

struct TestApp {
    router: axum::Router,
    quorum_public: P256Public,
}

fn test_app() -> TestApp {
    let ephemeral_key = P256Pair::generate().unwrap();
    let quorum_key = P256Pair::generate().unwrap();
    let quorum_public = quorum_key.public_key();
    TestApp {
        router: router_with_state(AppState::new(ephemeral_key, quorum_key)),
        quorum_public,
    }
}

fn encrypt_envelope(app: &TestApp, passport_id: &str, trace: &str) -> String {
    let envelope = serde_json::json!({ "passport_id": passport_id, "trace": trace });
    let ciphertext = app
        .quorum_public
        .encrypt(envelope.to_string().as_bytes())
        .unwrap();
    qos_hex::encode(&ciphertext)
}

async fn post_analyze(app: &TestApp, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/analyze")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn analyze_round_trip_with_proof_verification() {
    let app = test_app();
    let ciphertext = encrypt_envelope(&app, "passport-42", CLAUDE_TRACE);
    let (status, json) = post_analyze(&app, serde_json::json!({ "ciphertext": ciphertext })).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["payload"]["passport_id"], "passport-42");
    assert_eq!(json["payload"]["stats"]["harness"], "claude-code");
    assert_eq!(json["payload"]["stats"]["external_id"], "abc-123");

    // The trace hash binds the proof to the exact analyzed trace.
    let expected_hash = qos_hex::encode(&Sha256::digest(CLAUDE_TRACE.as_bytes()));
    assert_eq!(json["payload"]["trace_sha256"], expected_hash);

    // Verify the signature over the exact returned payload bytes.
    let payload = json["proof"]["payload"].as_str().unwrap();
    let public_key = P256Public::from_bytes(
        &qos_hex::decode(json["proof"]["public_key"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let signature = qos_hex::decode(json["proof"]["signature"].as_str().unwrap()).unwrap();
    public_key.verify(payload.as_bytes(), &signature).unwrap();

    // The signed payload must match the response payload.
    let signed: serde_json::Value = serde_json::from_str(payload).unwrap();
    assert_eq!(signed["passport_id"], json["payload"]["passport_id"]);
    assert_eq!(signed["trace_sha256"], json["payload"]["trace_sha256"]);
}

#[tokio::test]
async fn analyze_rejects_garbage_trace_with_422() {
    let app = test_app();
    let ciphertext = encrypt_envelope(&app, "passport-42", "not a trace at all");
    let (status, json) = post_analyze(&app, serde_json::json!({ "ciphertext": ciphertext })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(json["error"].as_str().unwrap().contains("trace rejected"));
}

#[tokio::test]
async fn analyze_rejects_ciphertext_from_wrong_key() {
    let app = test_app();
    let wrong_key = P256Pair::generate().unwrap();
    let envelope = serde_json::json!({ "passport_id": "p", "trace": CLAUDE_TRACE });
    let ciphertext = qos_hex::encode(
        &wrong_key
            .public_key()
            .encrypt(envelope.to_string().as_bytes())
            .unwrap(),
    );
    let (status, _) = post_analyze(&app, serde_json::json!({ "ciphertext": ciphertext })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn analyze_rejects_missing_passport_id() {
    let app = test_app();
    let envelope = serde_json::json!({ "passport_id": "", "trace": CLAUDE_TRACE });
    let ciphertext = qos_hex::encode(
        &app.quorum_public
            .encrypt(envelope.to_string().as_bytes())
            .unwrap(),
    );
    let (status, _) = post_analyze(&app, serde_json::json!({ "ciphertext": ciphertext })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn quorum_public_key_endpoint_matches_state_key() {
    let app = test_app();
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/quorum_public_key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let returned = qos_hex::decode(json["public_key"].as_str().unwrap()).unwrap();
    assert_eq!(returned, app.quorum_public.to_bytes());
}
