pub mod encrypt;
pub mod vapid;

use sha2::{Digest, Sha256};
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{is_apple_push_endpoint, validate_push_endpoint, Message, PushSubscriptionRecord};

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
    // Optional. When set, plaintext pushes carry a declarative `navigate`
    // (#58); when unset the service worker's navigateFor fills it in.
    let public_origin = env.var("PUBLIC_ORIGIN").ok().map(|v| v.to_string());

    // Thin push: the D1 row and WebSocket carry the full message; the push
    // service gets a size-bounded envelope instead of `serde_json::to_vec(msg)`.
    let payload = push_payload(msg, public_origin.as_deref());

    for sub in subscriptions {
        match send_single_push(
            &sub.endpoint,
            &sub.p256dh,
            &sub.auth,
            &payload,
            &vapid_private_key,
            &vapid_public_key,
            &vapid_subject,
            msg.priority,
            &msg.topic,
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
                    msg.priority,
                    &msg.topic,
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

/// sha256 of a UTF-8 string, hex-encoded (64 chars).
fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// sha256 of the endpoint, hex-encoded. The endpoint is a capability
/// credential, so the receipt table stores the hash and never the URL.
fn endpoint_hash(endpoint: &str) -> String {
    sha256_hex(endpoint)
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
/// Plaintext messages are wrapped as a Declarative Web Push document
/// (`web_push: 8030`, #58) so a declarative UA can render them without our
/// service worker. `public_origin`, when configured, becomes
/// `notification.navigate`; otherwise the service worker's `navigateFor` fills
/// it in. Encrypted messages are not wrapped — the server only sees ciphertext.
pub fn push_payload(msg: &Message, public_origin: Option<&str>) -> Vec<u8> {
    if msg.encrypted {
        // Encrypted pushes are NOT wrapped (#58): the server only sees
        // ciphertext, and putting plaintext in `notification.*` would break the
        // E2EE promise in the README. Do not "finish" the wrap for E2EE.
        build_e2ee_payload(msg)
    } else {
        build_plaintext_payload(msg, public_origin)
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

/// RFC 8030 §5.3 Urgency / §5.2 TTL, keyed on the publisher's X-Priority.
/// `high` is reserved for priorities 4 and 5; priorities 1–2 must not wake the
/// radio, so `very-low`/`low` with a short TTL lets the push service wait for a
/// radio that is already awake instead of churning it. Missing or unparseable
/// priority is already normalised to 3 upstream (publish.rs clamps to 1–5 and
/// sw.js normalises to 3); 0 / 6 / anything else maps to the priority-3 row.
fn delivery_headers(priority: u8) -> (&'static str, u32) {
    match priority {
        1 => ("very-low", 3600),
        2 => ("low", 3600),
        3 => ("normal", 14400),
        4 => ("high", 600),
        5 => ("high", 120),
        _ => ("normal", 14400),
    }
}

/// RFC 8030 `Topic` header value: the first 32 hex chars of sha256(topic). The
/// raw topic is a capability credential, so it must never appear on a header
/// the push service logs. Priorities 1–4 collapse per topic at the push
/// service; priority 5 omits the header so a fire-alert can never be replaced
/// by chatter. Apple's push service rejects an unknown `Topic`, so it is
/// skipped for `*.push.apple.com` (FCM and Mozilla autopush honour it).
fn topic_header(topic: &str, priority: u8, endpoint: &str) -> Option<String> {
    if !(1..=4).contains(&priority) {
        return None;
    }
    if is_apple_push_endpoint(endpoint) {
        return None;
    }
    Some(sha256_hex(topic).chars().take(32).collect())
}

/// The title a declarative notification shows. A declarative message with no
/// title is dropped by the UA, which violates userVisibleOnly, so this never
/// returns an empty string: the publisher's title, else the first line of the
/// body, else a generic fallback. Never the topic name or "Pigeon".
fn notification_title(msg: &Message, truncated_body: &str) -> String {
    if let Some(t) = msg.title.as_deref() {
        let t = t.trim();
        if !t.is_empty() {
            return truncate_utf8(t, TITLE_TRUNCATE_BYTES).to_string();
        }
    }
    let first_line = truncated_body.split('\n').next().unwrap_or("").trim();
    if !first_line.is_empty() {
        return truncate_utf8(first_line, TITLE_TRUNCATE_BYTES).to_string();
    }
    "New message".to_string()
}

/// Absolute navigate URL for a declarative notification, or None. Only built
/// when `public_origin` is a configured absolute http(s) origin: a relative
/// `navigate` is not in the declarative grammar and an Apple UA ignores the
/// whole message. Topics are restricted to URL-safe characters, so no escaping
/// is needed.
fn navigate_url(public_origin: &str, topic: &str) -> Option<String> {
    let origin = public_origin.trim().trim_end_matches('/');
    if origin.is_empty() {
        return None;
    }
    let url = worker::Url::parse(origin).ok()?;
    if (url.scheme() != "https" && url.scheme() != "http") || url.host_str().is_none() {
        return None;
    }
    Some(format!("{}/?topic={}", origin, topic))
}

fn build_plaintext_payload(msg: &Message, public_origin: Option<&str>) -> Vec<u8> {
    // Rule 1: never ship the hero image — the UA fetches it from https: and it
    // is the first thing to blow the 4 KB budget. D1/WS still carry X-Image.
    // Rule 2: body truncated to 240 bytes (full body stays in D1/WS/poll).
    let mut message = truncate_utf8(&msg.message, MESSAGE_TRUNCATE_BYTES).to_string();
    if message.len() < msg.message.len() {
        message.push('…');
    }
    // Rule 3: title truncated to 120 bytes (visible target is ~50).
    let title_field = msg
        .title
        .as_deref()
        .map(|t| truncate_utf8(t, TITLE_TRUNCATE_BYTES).to_string());

    // `pigeon` carries the same fields the flat object carried, so the service
    // worker keeps its priority/tag/Copy/audible-clock behaviour.
    let mut pigeon = serde_json::json!({
        "id": msg.id,
        "topic": msg.topic,
        "message": message,
        "priority": msg.priority,
        "markdown": msg.markdown,
        "created_at": msg.created_at,
    });
    {
        let map = pigeon.as_object_mut().expect("pigeon is an object");
        if let Some(t) = &title_field {
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

    // `notification` is what a declarative UA renders without running our JS.
    // `dir` and `icon` are deliberately omitted; `silent` mirrors the audible
    // budget's intent (true for 1–3, false for 4–5), not its 60s clock.
    let mut notification = serde_json::json!({
        "title": notification_title(msg, &message),
        "silent": msg.priority <= 3,
        "app_badge": "1",
    });
    {
        let map = notification.as_object_mut().expect("notification is an object");
        if !message.is_empty() {
            map.insert("body".into(), serde_json::json!(message));
        }
        if let Some(lang) = &msg.language {
            map.insert("lang".into(), serde_json::json!(lang));
        }
        if let Some(origin) = public_origin {
            if let Some(nav) = navigate_url(origin, &msg.topic) {
                map.insert("navigate".into(), serde_json::json!(nav));
            }
        }
    }

    let mut obj = serde_json::json!({
        "web_push": 8030,
        "notification": notification,
        "pigeon": pigeon,
    });

    // Size ladder (#47), applied to the declarative object: drop pigeon.tags,
    // then pigeon.click, then notification.navigate. `web_push` and
    // `notification.title` are never dropped.
    let mut bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    if let Some(p) = obj.get_mut("pigeon").and_then(|v| v.as_object_mut()) {
        p.remove("tags");
    }
    bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    if let Some(p) = obj.get_mut("pigeon").and_then(|v| v.as_object_mut()) {
        p.remove("click");
    }
    bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    if let Some(n) = obj.get_mut("notification").and_then(|v| v.as_object_mut()) {
        n.remove("navigate");
    }
    bytes = serde_json::to_vec(&obj).unwrap_or_default();
    if bytes.len() <= PUSH_PAYLOAD_MAX_BYTES {
        return bytes;
    }
    // Pathological (title+id+topic alone exceed the cap): a wrap that does not
    // fit is a ladder bug, not a reason to send the flat object.
    console_log!("push_payload: last-resort generic payload for topic {}", msg.topic);
    generic_plaintext_payload(msg)
}

fn generic_plaintext_payload(msg: &Message) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "web_push": 8030,
        "notification": {
            "title": "New message",
            "silent": msg.priority <= 3,
            "app_badge": "1",
        },
        "pigeon": {
            "id": msg.id,
            "topic": msg.topic,
            "priority": msg.priority,
        },
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
            "web_push": 8030,
            "notification": {
                "title": "New message",
                "silent": msg.priority <= 3,
                "app_badge": "1",
            },
            "pigeon": {
                "id": msg.id,
                "topic": msg.topic,
                "priority": msg.priority,
            },
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
    priority: u8,
    topic: &str,
) -> std::result::Result<u16, PushError> {
    let encrypted = encrypt::encrypt_payload(payload, p256dh, auth).map_err(PushError::Worker)?;
    let auth_header =
        vapid::build_vapid_header(endpoint, vapid_private_key, vapid_public_key, vapid_subject)
            .map_err(PushError::Worker)?;

    let headers = Headers::new();
    headers.set("Authorization", &auth_header).map_err(PushError::Worker)?;
    headers.set("Content-Encoding", "aes128gcm").map_err(PushError::Worker)?;
    headers.set("Content-Type", "application/octet-stream").map_err(PushError::Worker)?;
    let (urgency, ttl) = delivery_headers(priority);
    headers.set("TTL", &ttl.to_string()).map_err(PushError::Worker)?;
    headers.set("Urgency", urgency).map_err(PushError::Worker)?;
    // RFC 8030 Topic collapses still-queued messages at the push service; see
    // topic_header for the priority / Apple-endpoint rules.
    if let Some(topic_value) = topic_header(topic, priority, endpoint) {
        headers.set("Topic", &topic_value).map_err(PushError::Worker)?;
    }

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
        assert_eq!(v["web_push"], serde_json::json!(8030));
        assert!(v.get("image").is_none(), "hero images must not ship in push");
        assert!(v["pigeon"].get("image").is_none());
        let body = v["pigeon"]["message"].as_str().unwrap();
        assert!(body.ends_with('…'), "truncated body must end with ellipsis");
        assert!(body.len() <= MESSAGE_TRUNCATE_BYTES + 3);
        assert_eq!(v["pigeon"]["title"].as_str().unwrap(), "Backup failed");
        assert_eq!(v["pigeon"]["markdown"], serde_json::json!(false));
        assert_eq!(v["notification"]["title"].as_str().unwrap(), "Backup failed");
        assert_eq!(v["notification"]["body"].as_str().unwrap(), body);
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
        assert_eq!(v["pigeon"]["language"], serde_json::json!("en-GB"));
        assert_eq!(v["notification"]["lang"], serde_json::json!("en-GB"));
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
    fn delivery_headers_map_priority_to_urgency_and_ttl() {
        assert_eq!(delivery_headers(1), ("very-low", 3600));
        assert_eq!(delivery_headers(2), ("low", 3600));
        assert_eq!(delivery_headers(3), ("normal", 14400));
        assert_eq!(delivery_headers(4), ("high", 600));
        assert_eq!(delivery_headers(5), ("high", 120));
        // 0 / 6 / anything unparseable maps to the priority-3 row.
        assert_eq!(delivery_headers(0), ("normal", 14400));
        assert_eq!(delivery_headers(6), ("normal", 14400));
    }

    #[test]
    fn topic_header_collapses_1_to_4_and_skips_apple_and_priority_5() {
        let fcm = "https://fcm.googleapis.com/fcm/send/abc";
        let apple = "https://web.push.apple.com/QPabcdef";

        let t = topic_header("mytopic", 3, fcm).unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, "mytopic", "the raw topic must never be a header value");

        assert_eq!(topic_header("mytopic", 1, fcm).as_deref().map(str::len), Some(32));
        assert_eq!(topic_header("mytopic", 4, fcm).as_deref().map(str::len), Some(32));
        assert_eq!(topic_header("mytopic", 5, fcm), None);
        assert_eq!(topic_header("mytopic", 3, apple), None);
        assert_eq!(topic_header("mytopic", 5, apple), None);
        assert_eq!(topic_header("mytopic", 1, apple), None);
    }

    #[test]
    fn plaintext_push_is_a_declarative_wrap() {
        let m = Message {
            title: Some("disk2 backup failed".to_string()),
            language: Some("en-GB".to_string()),
            ..base("snapshot took 412s")
        };
        let payload = push_payload(&m, Some("https://pigeon.example"));
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();

        assert_eq!(v["web_push"], serde_json::json!(8030));
        assert_eq!(v["notification"]["title"], serde_json::json!("disk2 backup failed"));
        assert_eq!(v["notification"]["body"], serde_json::json!("snapshot took 412s"));
        assert_eq!(v["notification"]["lang"], serde_json::json!("en-GB"));
        assert_eq!(v["notification"]["navigate"], serde_json::json!("https://pigeon.example/?topic=homelab"));
        assert_eq!(v["notification"]["silent"], serde_json::json!(true)); // priority 3
        assert_eq!(v["notification"]["app_badge"], serde_json::json!("1"));
        assert!(v["notification"].get("icon").is_none(), "icon needs a public_origin and stays omitted");
        assert_eq!(v["pigeon"]["topic"], serde_json::json!("homelab"));
        assert!(payload.len() <= PUSH_PAYLOAD_MAX_BYTES);
    }

    #[test]
    fn plaintext_push_omits_navigate_without_public_origin() {
        let m = base("hi");
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(v["notification"].get("navigate").is_none());
        assert_eq!(v["notification"]["title"], serde_json::json!("hi"));
    }

    #[test]
    fn plaintext_push_title_falls_back_to_first_line_of_body() {
        let m = base("first line\nsecond line");
        let payload = push_payload(&m, None);
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(v["notification"]["title"], serde_json::json!("first line"));
        assert_eq!(v["notification"]["body"], serde_json::json!("first line\nsecond line"));
        assert!(v["pigeon"].get("title").is_none(), "no publisher title means no pigeon.title");
    }

    #[test]
    fn plaintext_push_drops_tags_then_click_to_fit() {
        let m = Message {
            title: Some("disk".to_string()),
            message: "body".to_string(),
            tags: Some("x".repeat(4000)),
            click: Some(format!("https://example.com/{}", "y".repeat(4000))),
            ..base("")
        };
        let payload = push_payload(&m, Some("https://pigeon.example"));
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(payload.len() <= PUSH_PAYLOAD_MAX_BYTES);
        assert_eq!(v["web_push"], serde_json::json!(8030));
        assert!(v["pigeon"].get("tags").is_none(), "tags drop first");
        assert!(v["pigeon"].get("click").is_none(), "click drops second");
        assert_eq!(v["notification"]["title"], serde_json::json!("disk"));
    }

    #[test]
    fn encrypted_push_is_not_wrapped() {
        let m = Message {
            encrypted: true,
            message: "short".to_string(),
            ..base("")
        };
        let payload = push_payload(&m, Some("https://pigeon.example"));
        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(v.get("web_push").is_none(), "E2EE must not be wrapped");
        assert!(v.get("notification").is_none(), "E2EE must not carry plaintext notification");
        assert_eq!(v["encrypted"], serde_json::json!(true));
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
