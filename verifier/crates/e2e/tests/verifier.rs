#![allow(missing_docs, clippy::unwrap_used)]

use e2e::TestArgs;
use qos_p256::P256Public;

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
