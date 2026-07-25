#![allow(missing_docs, clippy::unwrap_used)]

use base64::Engine as _;
use e2e::TestArgs;
use flate2::Compression;
use flate2::write::GzEncoder;
use qos_p256::P256Public;
use std::io::Write;

/// A minimal Claude Code JSONL trace with one human turn and one Bash tool
/// call, so command_counts and outcome are non-trivially derived.
fn sample_trace() -> String {
    concat!(
        r#"{"type":"user","sessionId":"e2e-session","timestamp":"2026-07-10T15:15:45.972Z","message":{"role":"user","content":"hello"}}"#,
        "\n",
        r#"{"type":"assistant","sessionId":"e2e-session","timestamp":"2026-07-10T15:16:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":250},"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}"#,
    )
    .to_string()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

/// A gzip stream that inflates to well over the enclave's 192MB decompressed
/// cap. All-zero input compresses to a tiny stream, so this is cheap to
/// build and cheap to ship over the wire, but expensive (deliberately, over
/// cap) to inflate.
fn oversized_gzip_payload() -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let chunk = vec![0u8; 1024 * 1024];
    for _ in 0..600 {
        encoder.write_all(&chunk).unwrap();
    }
    encoder.finish().unwrap()
}

/// Which ciphertext encoding to send in the `/analyze` request body.
enum CiphertextField {
    Hex,
    Base64,
}

/// Post `plaintext` (an `AnalyzeEnvelope` JSON body, optionally gzipped) to
/// `/analyze`, encrypted to the enclave's quorum key and encoded via
/// whichever request field `field` names.
async fn post_analyze(
    client: &reqwest::Client,
    base_url: &str,
    quorum_public: &P256Public,
    plaintext: &[u8],
    field: CiphertextField,
) -> reqwest::Response {
    let ciphertext = quorum_public.encrypt(plaintext).unwrap();
    let body = match field {
        CiphertextField::Hex => serde_json::json!({ "ciphertext": qos_hex::encode(&ciphertext) }),
        CiphertextField::Base64 => serde_json::json!({
            "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ciphertext)
        }),
    };
    client
        .post(format!("{base_url}/analyze"))
        .json(&body)
        .send()
        .await
        .unwrap()
}

/// Binary framing for `/analyze_raw` (mirrors `buildBinaryEnvelope` in
/// `web/src/lib/qosCrypto.ts`): u16-LE byte-length of the utf8 passport id,
/// the passport id bytes, then the gzip payload.
fn frame_raw_envelope(passport_id: &str, gz: &[u8]) -> Vec<u8> {
    let id_bytes = passport_id.as_bytes();
    let mut out = Vec::new();
    out.extend_from_slice(&u16::try_from(id_bytes.len()).unwrap().to_le_bytes());
    out.extend_from_slice(id_bytes);
    out.extend_from_slice(gz);
    out
}

/// Post a raw binary-framed envelope (already gzip-compressed trace, framed
/// with `frame_raw_envelope`), encrypted to the enclave's quorum key, to
/// `/analyze_raw` as `application/octet-stream` -- no JSON wrapper.
async fn post_analyze_raw(
    client: &reqwest::Client,
    base_url: &str,
    quorum_public: &P256Public,
    plaintext: &[u8],
) -> reqwest::Response {
    let ciphertext = quorum_public.encrypt(plaintext).unwrap();
    client
        .post(format!("{base_url}/analyze_raw"))
        .header("content-type", "application/octet-stream")
        .body(ciphertext)
        .send()
        .await
        .unwrap()
}

async fn fetch_quorum_public_key(client: &reqwest::Client, base_url: &str) -> P256Public {
    let resp = client
        .get(format!("{base_url}/quorum_public_key"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let json: serde_json::Value = resp.json().await.unwrap();
    P256Public::from_bytes(&qos_hex::decode(json["public_key"].as_str().unwrap()).unwrap())
        .unwrap()
}

#[tokio::test]
async fn test_health() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{}/health", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(json["status"], "healthy");
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_hello_world() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{}/hello_world", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(json["message"], "hello world");
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_time() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{}/time", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert!(
            json["time"].is_u64(),
            "time field should be a unix timestamp"
        );
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_random_app_proof() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{}/random_app_proof", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();

        let random_number = json["payload"]["random_number"].as_u64().unwrap();
        let payload = json["proof"]["payload"].as_str().unwrap();
        let payload_json: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(
            payload_json,
            serde_json::json!({"random_number": random_number.to_string()})
        );

        let public_key_bytes =
            qos_hex::decode(json["proof"]["public_key"].as_str().unwrap()).unwrap();
        let public_key = P256Public::from_bytes(&public_key_bytes).unwrap();
        let signature = qos_hex::decode(json["proof"]["signature"].as_str().unwrap()).unwrap();
        public_key.verify(payload.as_bytes(), &signature).unwrap();
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_quorum_key_encrypt_decrypt() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let plaintext = "hello TVC world";
        let resp = client
            .post(format!("{}/quorum_key/encrypt", test_args.base_url))
            .json(&serde_json::json!({ "plaintext": plaintext }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        let ciphertext = json["ciphertext"].as_str().unwrap();
        qos_hex::decode(ciphertext).unwrap();

        let resp = client
            .post(format!("{}/quorum_key/decrypt", test_args.base_url))
            .json(&serde_json::json!({ "ciphertext": ciphertext }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(json["plaintext"], plaintext);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_echo() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/echo", test_args.base_url))
            .body("hello echo")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = resp.text().await.unwrap();
        assert_eq!(body, "hello echo");
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_echo_json() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let sent = serde_json::json!({"foo": "bar", "count": 42});
        let resp = client
            .post(format!("{}/echo", test_args.base_url))
            .json(&sent)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let received: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(received, sent);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("{}/quorum_public_key", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        let quorum_public = P256Public::from_bytes(
            &qos_hex::decode(json["public_key"].as_str().unwrap()).unwrap(),
        )
        .unwrap();

        // A minimal Claude Code JSONL trace with one human turn and one Bash
        // tool call, so command_counts and outcome are non-trivially derived.
        let trace = concat!(
            r#"{"type":"user","sessionId":"e2e-session","timestamp":"2026-07-10T15:15:45.972Z","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"e2e-session","timestamp":"2026-07-10T15:16:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":250},"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}"#,
        );
        let envelope = serde_json::json!({ "passport_id": "e2e-passport", "trace": trace });
        let ciphertext = qos_hex::encode(
            &quorum_public
                .encrypt(envelope.to_string().as_bytes())
                .unwrap(),
        );

        let resp = client
            .post(format!("{}/analyze", test_args.base_url))
            .json(&serde_json::json!({ "ciphertext": ciphertext }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();

        // Verify the signature over the exact returned payload bytes, then
        // assert the v2 fields are present in the signed payload itself
        // (not just the outer response envelope).
        let payload = json["proof"]["payload"].as_str().unwrap();
        let public_key = P256Public::from_bytes(
            &qos_hex::decode(json["proof"]["public_key"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let signature = qos_hex::decode(json["proof"]["signature"].as_str().unwrap()).unwrap();
        public_key.verify(payload.as_bytes(), &signature).unwrap();

        let signed: serde_json::Value = serde_json::from_str(payload).unwrap();
        let stats = &signed["stats"];
        assert!(
            stats.get("loc_added").is_some(),
            "loc_added should be present in the signed payload: {stats}"
        );
        assert!(
            stats.get("command_counts").is_some(),
            "command_counts should be present in the signed payload: {stats}"
        );
        assert!(
            stats.get("outcome").is_some(),
            "outcome should be present in the signed payload: {stats}"
        );
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_gzip_envelope_matches_plain() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        let envelope = serde_json::json!({ "passport_id": "e2e-gzip-passport", "trace": sample_trace() })
            .to_string();

        let plain_resp = post_analyze(
            &client,
            &test_args.base_url,
            &quorum_public,
            envelope.as_bytes(),
            CiphertextField::Hex,
        )
        .await;
        assert_eq!(plain_resp.status(), 200);
        let plain_json: serde_json::Value = plain_resp.json().await.unwrap();

        let gz_resp = post_analyze(
            &client,
            &test_args.base_url,
            &quorum_public,
            &gzip(envelope.as_bytes()),
            CiphertextField::Hex,
        )
        .await;
        assert_eq!(gz_resp.status(), 200);
        let gz_json: serde_json::Value = gz_resp.json().await.unwrap();

        // Same trace in, same signed stats/proof shape out — analyzed_at and
        // the signature itself will differ run to run, so compare the
        // meaningful subset.
        let plain_payload: serde_json::Value =
            serde_json::from_str(plain_json["proof"]["payload"].as_str().unwrap()).unwrap();
        let gz_payload: serde_json::Value =
            serde_json::from_str(gz_json["proof"]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(plain_payload["passport_id"], gz_payload["passport_id"]);
        assert_eq!(plain_payload["trace_sha256"], gz_payload["trace_sha256"]);
        assert_eq!(plain_payload["stats"], gz_payload["stats"]);
        assert_eq!(
            plain_json["payload"]["stats"], gz_json["payload"]["stats"],
            "gzipped envelope should produce identical stats to the plain envelope"
        );
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_ciphertext_b64_field() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        let envelope = serde_json::json!({ "passport_id": "e2e-b64-passport", "trace": sample_trace() })
            .to_string();

        let resp = post_analyze(
            &client,
            &test_args.base_url,
            &quorum_public,
            envelope.as_bytes(),
            CiphertextField::Base64,
        )
        .await;
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert!(json["payload"]["stats"].get("outcome").is_some());
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_gzip_bomb_rejected() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        let resp = post_analyze(
            &client,
            &test_args.base_url,
            &quorum_public,
            &oversized_gzip_payload(),
            CiphertextField::Hex,
        )
        .await;
        assert_eq!(resp.status(), 422);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_raw_matches_json_path_and_verifies_signature() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        let envelope =
            serde_json::json!({ "passport_id": "e2e-raw-passport", "trace": sample_trace() })
                .to_string();
        let json_resp = post_analyze(
            &client,
            &test_args.base_url,
            &quorum_public,
            envelope.as_bytes(),
            CiphertextField::Hex,
        )
        .await;
        assert_eq!(json_resp.status(), 200);
        let json_json: serde_json::Value = json_resp.json().await.unwrap();

        let framed = frame_raw_envelope("e2e-raw-passport", &gzip(sample_trace().as_bytes()));
        let raw_resp =
            post_analyze_raw(&client, &test_args.base_url, &quorum_public, &framed).await;
        assert_eq!(raw_resp.status(), 200);
        let raw_json: serde_json::Value = raw_resp.json().await.unwrap();

        // Verify the ECDSA signature over the exact returned payload bytes.
        let payload = raw_json["proof"]["payload"].as_str().unwrap();
        let public_key = P256Public::from_bytes(
            &qos_hex::decode(raw_json["proof"]["public_key"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let signature = qos_hex::decode(raw_json["proof"]["signature"].as_str().unwrap()).unwrap();
        public_key.verify(payload.as_bytes(), &signature).unwrap();

        let signed: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(signed["passport_id"], "e2e-raw-passport");

        // Same trace via /analyze (JSON) and /analyze_raw (binary streaming)
        // must produce identical stats and trace hash.
        let json_payload: serde_json::Value =
            serde_json::from_str(json_json["proof"]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(json_payload["trace_sha256"], signed["trace_sha256"]);
        assert_eq!(json_payload["stats"], signed["stats"]);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_raw_rejects_framing_corruption() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        // Truncated length prefix (only 1 byte, need >= 2).
        let resp =
            post_analyze_raw(&client, &test_args.base_url, &quorum_public, &[0x01]).await;
        assert_eq!(resp.status(), 400);

        // Length prefix claims more bytes than are present.
        let mut oob = 10u16.to_le_bytes().to_vec();
        oob.push(b'x');
        let resp = post_analyze_raw(&client, &test_args.base_url, &quorum_public, &oob).await;
        assert_eq!(resp.status(), 400);

        // Invalid utf8 passport id.
        let mut bad_utf8 = 2u16.to_le_bytes().to_vec();
        bad_utf8.extend_from_slice(&[0xff, 0xfe]);
        bad_utf8.extend_from_slice(&gzip(sample_trace().as_bytes()));
        let resp = post_analyze_raw(&client, &test_args.base_url, &quorum_public, &bad_utf8).await;
        assert_eq!(resp.status(), 400);

        // Missing gzip magic after the passport id.
        let no_magic = frame_raw_envelope("e2e-raw-bad", b"not gzip data");
        let resp =
            post_analyze_raw(&client, &test_args.base_url, &quorum_public, &no_magic).await;
        assert_eq!(resp.status(), 400);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_analyze_raw_gzip_bomb_rejected() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();
        let quorum_public = fetch_quorum_public_key(&client, &test_args.base_url).await;

        let framed = frame_raw_envelope("e2e-raw-bomb", &oversized_gzip_payload());
        let resp = post_analyze_raw(&client, &test_args.base_url, &quorum_public, &framed).await;
        assert_eq!(resp.status(), 422);
    }
    e2e::Builder::new().execute(test).await;
}

#[tokio::test]
async fn test_metrics() {
    async fn test(test_args: TestArgs) {
        let client = reqwest::Client::new();

        // Hit an endpoint first so the histogram has data
        client
            .get(format!("{}/health", test_args.base_url))
            .send()
            .await
            .unwrap();

        let resp = client
            .get(format!("{}/metrics", test_args.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let content_type = resp
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            content_type.starts_with("text/plain"),
            "expected prometheus text format content type, got: {content_type}"
        );

        let body = resp.text().await.unwrap();
        assert!(
            body.contains("tvc_http_request_duration_ms"),
            "should contain the namespaced histogram metric"
        );
        assert!(
            body.contains("method=\"GET\""),
            "should contain method label"
        );
    }
    e2e::Builder::new().execute(test).await;
}
