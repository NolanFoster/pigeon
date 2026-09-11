pub mod encrypt;
pub mod vapid;

use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{validate_push_endpoint, Message};

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

pub async fn send_push_to_topic(env: &Env, msg: &Message) -> Result<()> {
    let db = env.d1("DB")?;
    let subscriptions = db::get_push_subscriptions(&db, &msg.topic).await?;

    if subscriptions.is_empty() {
        return Ok(());
    }

    let vapid_private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
    let vapid_public_key = env.var("VAPID_PUBLIC_KEY")?.to_string();
    let vapid_subject = env.var("VAPID_SUBJECT")?.to_string();

    // Thin push: the D1 row and WebSocket carry the full message; the push
    // service gets a size-bounded envelope instead of `serde_json::to_vec(msg)`.
    let payload = push_payload(msg, None);

    for sub in &subscriptions {
        // Defence in depth: rows inserted before the subscribe-time allowlist
        // landed could still point at arbitrary URLs. Skip them.
        if validate_push_endpoint(&sub.endpoint).is_err() {
            console_log!("Skipping push to non-allowlisted endpoint {}", &sub.endpoint);
            if let Err(e) = db::delete_push_subscription(&db, &msg.topic, &sub.endpoint).await {
                console_log!("Failed to delete bad subscription: {:?}", e);
            }
            continue;
        }
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
            Ok(_) => {}
            Err(PushError::PayloadTooLarge) => {
                // One retry with a tiny payload that cannot exceed the budget.
                // 410 is the only status that prunes; a 413/400 size rejection
                // keeps the subscription and the D1 row.
                console_log!(
                    "Push payload too large for {}; retrying with generic payload",
                    &sub.endpoint
                );
                let generic = generic_retry_payload(msg);
                if let Err(e) = send_single_push(
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
                    log_push_error(&db, &msg.topic, &sub.endpoint, e).await;
                }
            }
            Err(e) => log_push_error(&db, &msg.topic, &sub.endpoint, e).await,
        }
    }

    Ok(())
}

async fn log_push_error(db: &worker::D1Database, topic: &str, endpoint: &str, err: PushError) {
    match err {
        PushError::Gone | PushError::NotFound => {
            console_log!("Removing expired push subscription for {}", endpoint);
            if let Err(e) = db::delete_push_subscription(db, topic, endpoint).await {
                console_log!("Failed to delete expired subscription: {:?}", e);
            }
        }
        PushError::PayloadTooLarge => {
            // Shouldn't happen (the generic payload fits), but never prune on size.
            console_log!("Web Push payload still too large for {}", endpoint);
        }
        PushError::HttpStatus(status) => {
            console_log!("Web Push failed for {} with status {}", endpoint, status);
        }
        PushError::Worker(e) => {
            console_log!("Web Push error for {}: {:?}", endpoint, e);
        }
    }
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
    // fetching GET /:topic/messages/:id.
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
) -> std::result::Result<(), PushError> {
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
    Ok(())
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
}
