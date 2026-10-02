pub mod encrypt;
pub mod vapid;

use sha2::{Digest, Sha256};
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{validate_push_endpoint, Message, PushSubscriptionRecord};

enum PushError {
    Gone,
    NotFound,
    /// The push service rejected the payload as too large (413, or a 400 whose
    /// body says so). Retried once with a guaranteed-to-fit generic payload.
    PayloadTooLarge,
    HttpStatus(u16),
    Worker(worker::Error),
}

/// Maximum plaintext bytes (after RFC 8291 decrypt) we will send to a push
/// service. FCM and APNs reject POST bodies over 4096 bytes; subtracting the
/// 16-byte encryption-info header and >=2 bytes of padding leaves 4078 bytes of
/// plaintext. We target 3500 so #40's Declarative Web Push wrap cannot push us
/// over the edge the day it merges.
pub const PUSH_PAYLOAD_MAX_BYTES: usize = 3500;
const MESSAGE_TRUNCATE_BYTES: usize = 240;
const TITLE_TRUNCATE_BYTES: usize = 120;

/// Load the subscriptions a publish will attempt, pruning rows whose endpoint
/// is no longer on the push-service allowlist (defence in depth: rows inserted
/// before the subscribe-time allowlist landed). The returned count is what the
/// publish response reports as `X-Push-Attempted`, so it must be computed
/// before any push-service round trip begins.
pub async fn prepare_subscriptions(
    env: &Env,
    topic: &str,
) -> Result<Vec<PushSubscriptionRecord>> {
    let db = env.d1("DB")?;
    let subscriptions = db::get_push_subscriptions(&db, topic).await?;

    let mut valid = Vec::with_capacity(subscriptions.len());
    for sub in subscriptions {
        if validate_push_endpoint(&sub.endpoint).is_err() {
            console_log!("Skipping push to non-allowlisted endpoint {}", &sub.endpoint);
            if let Err(e) = db::delete_push_subscription(&db, topic, &sub.endpoint).await {
                console_log!("Failed to delete bad subscription: {:?}", e);
            }
            continue;
        }
        valid.push(sub);
    }
    Ok(valid)
}

/// Fan out one message to the prepared subscriptions. Each attempted endpoint
/// produces exactly one receipt row reflecting its final outcome; the publish
/// response does not wait on this.
pub async fn send_push_to_topic(
    env: &Env,
    msg: &Message,
    subscriptions: &[PushSubscriptionRecord],
) -> Result<()> {
    let db = env.d1("DB")?;
    if subscriptions.is_empty() {
        return Ok(());
    }

    let vapid_private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
    let vapid_public_key = env.var("VAPID_PUBLIC_KEY")?.to_string();
    let vapid_subject = env.var("VAPID_SUBJECT")?.to_string();

    // Thin push: the D1 row and WebSocket carry the full message; the push
    // service gets a size-bounded envelope instead of `serde_json::to_vec(msg)`.
    let payload = push_payload(msg, None);

    for sub in subscriptions {
        match send_single_push(
            &sub.endpoint,
            &sub.p256dh,
            &sub.auth,
            &payload,
            &vapid_private_key,
            &vapid_public_key,
            &vapid_subject,
        )
        .await
        {
            Ok(status) => write_receipt(&db, msg, sub, "accepted", Some(status as i64)).await,
            Err(PushError::PayloadTooLarge) => {
                // One retry with a tiny payload that cannot exceed the budget.
                // 410 is the only status that prunes; a 413/400 size rejection
                // keeps the subscription and the D1 row. The receipt records the
                // retry's outcome — one attempt, one row, until #55 upserts.
                console_log!(
                    "Push payload too large for {}; retrying with generic payload",
                    &sub.endpoint
                );
                let generic = generic_retry_payload(msg);
                match send_single_push(
                    &sub.endpoint,
                    &sub.p256dh,
                    &sub.auth,
                    &generic,
                    &vapid_private_key,
                    &vapid_public_key,
                    &vapid_subject,
                )
                .await
                {
                    Ok(status) => {
                        write_receipt(&db, msg, sub, "accepted", Some(status as i64)).await
                    }
                    Err(e) => handle_push_error(&db, msg, sub, e).await,
                }
            }
            Err(e) => handle_push_error(&db, msg, sub, e).await,
        }
    }

    Ok(())
}

/// Map a push-service outcome to one of the five receipt status words. This is
/// the contract; no other word may be stored.
fn receipt_status(err: &PushError) -> &'static str {
    match err {
        PushError::Gone | PushError::NotFound => "gone",
        PushError::PayloadTooLarge => "too-large",
        PushError::HttpStatus(429) | PushError::HttpStatus(503) => "throttled",
        PushError::HttpStatus(_) => "rejected",
        PushError::Worker(_) => "rejected",
    }
}

/// The push-service status to record, or None when the failure happened before
/// the service answered (a `Fetch` error).
fn error_http_status(err: &PushError) -> Option<i64> {
    match err {
        PushError::Gone => Some(410),
        PushError::NotFound => Some(404),
        PushError::PayloadTooLarge => Some(413),
        PushError::HttpStatus(s) => Some(*s as i64),
        PushError::Worker(_) => None,
    }
}

/// sha256 of the endpoint, hex-encoded. The endpoint is a capability
/// credential, so the receipt table stores the hash and never the URL.
fn endpoint_hash(endpoint: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

async fn write_receipt(
    db: &worker::D1Database,
    msg: &Message,
    sub: &PushSubscriptionRecord,
    status: &str,
    http_status: Option<i64>,
) {
    let now = (Date::now().as_millis() / 1000) as i64;
    if let Err(e) = db::insert_push_receipt(
        db,
        &msg.id,
        &msg.topic,
        &endpoint_hash(&sub.endpoint),
        status,
        http_status,
        now,
    )
    .await
    {
        console_log!("Failed to write push receipt: {:?}", e);
    }
}

async fn handle_push_error(
    db: &worker::D1Database,
    msg: &Message,
    sub: &PushSubscriptionRecord,
    err: PushError,
) {
    match &err {
        PushError::Gone | PushError::NotFound => {
            console_log!("Removing expired push subscription for {}", sub.endpoint);
            if let Err(e) = db::delete_push_subscription(db, &msg.topic, &sub.endpoint).await {
                console_log!("Failed to delete expired subscription: {:?}", e);
            }
        }
        PushError::PayloadTooLarge => {
            // Shouldn't happen (the generic payload fits), but never prune on size.
            console_log!("Web Push payload still too large for {}", sub.endpoint);
        }
        PushError::HttpStatus(s) => {
            if *s == 401 || *s == 403 {
                // A signature rejection means OUR VAPID key changed, not that the
                // endpoint is dead — never prune. Until #55 grows a `stale-key`
                // status this stays `rejected`; log the word so rotation failures
                // are visible.
                console_log!("stale-key: Web Push rejected {} with status {}", sub.endpoint, s);
            } else {
                console_log!("Web Push failed for {} with status {}", sub.endpoint, s);
            }
        }
        PushError::Worker(e) => {
            console_log!("Web Push error for {}: {:?}", sub.endpoint, e);
        }
    }

    write_receipt(db, msg, sub, receipt_status(&err), error_http_status(&err)).await;
}

/// Build the thin push payload for one message.
///
/// `public_origin` is reserved for #40's Declarative Web Push wrap, which needs
/// the origin to construct `notification.navigate`. The flat object shipped here
/// lets the service worker resolve relative links against its own origin, so the
/// server never needs to know its public hostname.
pub fn push_payload(msg: &Message, public_origin: Option<&str>) -> Vec<u8> {
    let _ = public_origin;
    if msg.encrypted {
        build_e2ee_payload(msg)
    } else {
        build_plaintext_payload(msg)
    }
}

/// Truncate a UTF-8 string to at most `max` bytes, never splitting a code point.
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn build_plaintext_payload(msg: &Message) -> Vec<u8> {
    // Rule 1: never ship the hero image — the UA fetches it from https: and it
    // is the first thing to blow the 4 KB budget. D1/WS still carry X-Image.
    // Rule 2: body truncated to 240 bytes (full body stays in D1/WS/poll).
    let mut message = truncate_utf8(&msg.message, MESSAGE_TRUNCATE_BYTES).to_string();
    if message.len() < msg.message.len() {
        message.push('…');
    }
    // Rule 3: title truncated to 120 bytes (visible target is ~50).
    let title = msg
        .title
        .as_deref()
        .map(|t| truncate_utf8(t, TITLE_TRUNCATE_BYTES).to_string());

    let mut obj = serde_json::json!({
        "id": msg.id,
        "topic": msg.topic,
        "message": message,
        "priority": msg.priority,
        "markdown": msg.markdown,
        "created_at": msg.created_at,
    });
    {
        let map = obj.as_object_mut().expect("payload is an object");
        if let Some(t) = &title {
            map.insert("title".into(), serde_json::json!(t));
        }
        if let Some(tags) = &msg.tags {
            map.insert("tags".into(), serde_json::json!(tags));
        }
        if let Some(click) = &msg.click {
            map.insert("click".into(), serde_json::json!(click));
        }
        if let Some(lang) = &msg.language {
            map.insert("language".into(), serde_json::json!(lang));
        }
    }

    let mut bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    // Rule 4: drop tags — filter UI, not shade copy.
    obj.as_object_mut().map(|m| m.remove("tags"));
    bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    // Rule 5: drop click — the service worker falls back to /?topic=<topic>.
    obj.as_object_mut().map(|m| m.remove("click"));
    bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    // Pathological (title+id+topic alone exceed the cap): last resort, still a
    // valid toast.
    console_log!("push_payload: last-resort generic payload for topic {}", msg.topic);
    generic_plaintext_payload(msg)
}

fn generic_plaintext_payload(msg: &Message) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": msg.id,
        "topic": msg.topic,
        "message": "New message",
        "priority": msg.priority,
    }))
    .unwrap_or_default()
}

fn build_e2ee_payload(msg: &Message) -> Vec<u8> {
    // The server cannot truncate `ct` (that breaks decrypt) and cannot put
    // plaintext in `notification.*`. Include `ct` only if the full envelope
    // still fits; otherwise omit it and let the service worker upgrade by
    // fetching GET /:topic/messages/:id. `language` is NOT carried here — for
    // E2EE it lives inside the ciphertext and the server never sees it.
    let with_ct = serde_json::json!({
        "id": msg.id,
        "topic": msg.topic,
        "priority": msg.priority,
        "encrypted": true,
        "ct": msg.message,
        "created_at": msg.created_at,
    });
    let bytes = serde_json::to_vec(&with_ct).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    serde_json::to_vec(&serde_json::json!({
        "id": msg.id,
        "topic": msg.topic,
        "priority": msg.priority,
        "encrypted": true,
        "created_at": msg.created_at,
    }))
    .unwrap_or_default()
}

/// Tiny fallback payload for a push-service 413/400 size rejection.
fn generic_retry_payload(msg: &Message) -> Vec<u8> {
    if msg.encrypted {
        serde_json::to_vec(&serde_json::json!({
            "id": msg.id,
            "topic": msg.topic,
            "priority": msg.priority,
            "encrypted": true,
        }))
        .unwrap_or_default()
    } else {
        serde_json::to_vec(&serde_json::json!({
            "id": msg.id,
            "topic": msg.topic,
            "priority": msg.priority,
            "title": "New message",
        }))
        .unwrap_or_default()
    }
}

async fn send_single_push(
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &[u8],
    vapid_private_key: &str,
    vapid_public_key: &str,
    vapid_subject: &str,
) -> std::result::Result<u16, PushError> {
    let encrypted = encrypt::encrypt_payload(payload, p256dh, auth).map_err(PushError::Worker)?;
    let auth_header =
        vapid::build_vapid_header(endpoint, vapid_private_key, vapid_public_key, vapid_subject)
            .map_err(PushError::Worker)?;

    let headers = Headers::new();
    headers.set("Authorization", &auth_header).map_err(PushError::Worker)?;
    headers.set("Content-Encoding", "aes128gcm").map_err(PushError::Worker)?;
    headers.set("Content-Type", "application/octet-stream").map_err(PushError::Worker)?;
    headers.set("TTL", "86400").map_err(PushError::Worker)?;
    headers.set("Urgency", "high").map_err(PushError::Worker)?;

    let body = js_sys::Uint8Array::from(encrypted.as_slice());
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from(body)));

    let req = Request::new_with_init(endpoint, &init).map_err(PushError::Worker)?;
    let mut resp = Fetch::Request(req).send().await.map_err(PushError::Worker)?;
    let status = resp.status_code();
    if status == 410 {
        return Err(PushError::Gone);
    }
    if status == 404 {
        return Err(PushError::NotFound);
    }
    if status >= 400 {
        let body = resp.text().await.unwrap_or_default();
        console_log!("Push endpoint returned {}: {}", status, body);
        if status == 413 || (status == 400 && looks_like_payload_too_large(&body)) {
            return Err(PushError::PayloadTooLarge);
        }
        return Err(PushError::HttpStatus(status));
    }
    console_log!("Push sent successfully (status {})", status);
    Ok(status)
}

fn looks_like_payload_too_large(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    b.contains("too large")
        || b.contains("too big")
        || b.contains("payload too")
        || (b.contains("payload") && b.contains("size"))
        || b.contains("maximum")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(message: &str) -> Message {
        Message {
            id: "test-id".to_string(),
            topic: "homelab".to_string(),
            title: None,
            message: message.to_string(),
            priority: 3,
            tags: None,
            click: None,
            image: None,
            markdown: false,
            encrypted: false,
            language: None,
            created_at: 1710000000,
        }
    }

    #[test]
    fn truncate_utf8_never_splits_a_code_point() {
        // 'é' is two bytes. A cut that would split it steps back to the
        // previous boundary instead.
        assert_eq!(truncate_utf8("aéé", 3), "aé");
        assert_eq!(truncate_utf8("aéé", 2), "a");
        assert_eq!(truncate_utf8("aéé", 1), "a");
        assert_eq!(truncate_utf8("abc", 3), "abc");
    }

    #[test]
    fn plaintext_push_truncates_body_and_omits_image() {
        let m = Message {
            title: Some("Backup failed".to_string()),
            message: "x".repeat(8000),
            image: Some("https://example.com/hero.jpg".to_string()),
            ..base("")
        };
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();

        assert!(payload.len() <= PUSH_PAYLOAD_MAX_BYTES);
        assert!(v.get("image").is_none(), "hero images must not ship in push");
        let body = v["message"].as_str().unwrap();
        assert!(body.ends_with('…'), "truncated body must end with ellipsis");
        assert!(body.len() <= MESSAGE_TRUNCATE_BYTES + 3);
        assert_eq!(v["title"].as_str().unwrap(), "Backup failed");
        assert_eq!(v["markdown"], serde_json::json!(false));
    }

    #[test]
    fn e2ee_push_omits_ct_when_envelope_is_too_large() {
        let m = Message {
            encrypted: true,
            message: "x".repeat(4000),
            ..base("")
        };
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(payload.len() <= PUSH_PAYLOAD_MAX_BYTES);
        assert_eq!(v["encrypted"], serde_json::json!(true));
        assert!(v.get("ct").is_none(), "oversized ct must be dropped, not truncated");
    }

    #[test]
    fn e2ee_push_keeps_ct_when_it_fits() {
        let m = Message {
            encrypted: true,
            message: "short".to_string(),
            ..base("")
        };
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(v["ct"].as_str().unwrap(), "short");
    }

    #[test]
    fn plaintext_push_carries_language() {
        let m = Message {
            language: Some("en-GB".to_string()),
            ..base("hi")
        };
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(v["language"], serde_json::json!("en-GB"));
    }

    #[test]
    fn e2ee_push_omits_language() {
        let m = Message {
            encrypted: true,
            language: Some("en-GB".to_string()),
            message: "short".to_string(),
            ..base("")
        };
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(v.get("language").is_none(), "E2EE language lives in the ciphertext");
    }

    #[test]
    fn receipt_status_maps_410_to_gone_and_429_to_throttled() {
        assert_eq!(receipt_status(&PushError::Gone), "gone");
        assert_eq!(receipt_status(&PushError::NotFound), "gone");
        assert_eq!(receipt_status(&PushError::PayloadTooLarge), "too-large");
        assert_eq!(receipt_status(&PushError::HttpStatus(429)), "throttled");
        assert_eq!(receipt_status(&PushError::HttpStatus(503)), "throttled");
        // 401/403 stay "rejected" today (a `stale-key` status is #55's
        // classifier), never "gone" — pruning on a signature error deletes a
        // good endpoint because OUR key changed.
        assert_eq!(receipt_status(&PushError::HttpStatus(401)), "rejected");
        assert_eq!(receipt_status(&PushError::HttpStatus(403)), "rejected");
        assert_eq!(receipt_status(&PushError::HttpStatus(500)), "rejected");
    }

    #[test]
    fn endpoint_hash_is_stable_sha256_hex() {
        let endpoint = "https://fcm.googleapis.com/fcm/send/abc";
        let h = endpoint_hash(endpoint);
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h, endpoint_hash(endpoint));
        assert_ne!(h, endpoint_hash("https://fcm.googleapis.com/fcm/send/def"));
    }
}
