pub mod encrypt;
pub mod vapid;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{validate_push_endpoint, Message};

enum PushError {
    Gone,
    NotFound,
    HttpStatus(u16),
    Worker(worker::Error),
}

/// RFC 8030 delivery knobs derived from the publisher's `X-Priority`. Before
/// #36 this number was only painted on the message card; now it actually
/// changes the `Urgency` and `TTL` on the push POST, and whether the push
/// service may collapse an undelivered previous copy via the `Topic` header.
struct DeliveryOptions {
    urgency: &'static str,
    ttl: u32,
}

fn delivery_options(priority: u8) -> DeliveryOptions {
    match priority {
        1 => DeliveryOptions { urgency: "very-low", ttl: 3600 },
        2 => DeliveryOptions { urgency: "low", ttl: 3600 },
        3 => DeliveryOptions { urgency: "normal", ttl: 14_400 },
        4 => DeliveryOptions { urgency: "high", ttl: 600 },
        // 5 = max/urgent. Priority is clamped to 1..=5 at publish time, so
        // anything else that slips through defaults to the urgent bucket.
        _ => DeliveryOptions { urgency: "high", ttl: 120 },
    }
}

/// RFC 8030 `Topic` header value. This header is sent unencrypted to the push
/// service, so it must never leak the capability-URL topic name: it is a
/// stable, truncated SHA-256 hash instead. Push services drop an undelivered
/// previous message carrying the same `Topic`, which is how a priority 1–4
/// "progress" update replaces itself while the device is offline. Priority 5
/// omits the header entirely so an urgent alert can never be overwritten.
fn collapse_topic_token(topic: &str) -> String {
    let digest = Sha256::digest(topic.as_bytes());
    let encoded = URL_SAFE_NO_PAD.encode(digest.as_slice());
    encoded.chars().take(32).collect()
}

/// Pure, unit-testable derivation of the delivery headers for a message.
/// Returns `(urgency, ttl_seconds, collapse_topic_header)`.
fn delivery_headers(priority: u8, topic: &str) -> (&'static str, u32, Option<String>) {
    let opts = delivery_options(priority);
    let topic_header = if priority <= 4 {
        Some(collapse_topic_token(topic))
    } else {
        None
    };
    (opts.urgency, opts.ttl, topic_header)
}

pub async fn send_push_to_topic(env: &Env, msg: &Message) -> Result<()> {
    let db = env.d1("DB")?;
    let subscriptions = db::get_push_subscriptions(&db, &msg.topic).await?;

    if subscriptions.is_empty() {
        return Ok(());
    }

    let vapid_private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
    let vapid_public_key = env.var("VAPID_PUBLIC_KEY")?.to_string();
    let vapid_subject = env.var("VAPID_SUBJECT")?.to_string();

    // For e2ee messages, ship only the opaque ciphertext envelope in the push
    // payload. The Service Worker decrypts using a key it pulls from
    // IndexedDB. The server never sees the plaintext.
    let payload = if msg.encrypted {
        serde_json::to_vec(&serde_json::json!({
            "id": msg.id,
            "topic": msg.topic,
            "priority": msg.priority,
            "encrypted": true,
            "ct": msg.message,
            "created_at": msg.created_at,
        }))?
    } else {
        serde_json::to_vec(msg)?
    };

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
            msg,
            &vapid_private_key,
            &vapid_public_key,
            &vapid_subject,
        )
        .await
        {
            Ok(_) => {}
            Err(PushError::Gone | PushError::NotFound) => {
                console_log!("Removing expired push subscription for {}", &sub.endpoint);
                if let Err(e) = db::delete_push_subscription(&db, &msg.topic, &sub.endpoint).await {
                    console_log!("Failed to delete expired subscription: {:?}", e);
                }
            }
            Err(PushError::HttpStatus(status)) => {
                console_log!("Web Push failed for {} with status {}", &sub.endpoint, status);
            }
            Err(PushError::Worker(e)) => {
                console_log!("Web Push error for {}: {:?}", &sub.endpoint, e);
            }
        }
    }

    Ok(())
}

async fn send_single_push(
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &[u8],
    msg: &Message,
    vapid_private_key: &str,
    vapid_public_key: &str,
    vapid_subject: &str,
) -> std::result::Result<(), PushError> {
    let encrypted = encrypt::encrypt_payload(payload, p256dh, auth).map_err(PushError::Worker)?;
    let auth_header =
        vapid::build_vapid_header(endpoint, vapid_private_key, vapid_public_key, vapid_subject)
            .map_err(PushError::Worker)?;

    let (urgency, ttl, topic_header) = delivery_headers(msg.priority, &msg.topic);

    let headers = Headers::new();
    headers.set("Authorization", &auth_header).map_err(PushError::Worker)?;
    headers.set("Content-Encoding", "aes128gcm").map_err(PushError::Worker)?;
    headers.set("Content-Type", "application/octet-stream").map_err(PushError::Worker)?;
    headers.set("TTL", &ttl.to_string()).map_err(PushError::Worker)?;
    headers.set("Urgency", urgency).map_err(PushError::Worker)?;
    if let Some(topic) = topic_header {
        headers.set("Topic", &topic).map_err(PushError::Worker)?;
    }
    console_log!(
        "Sending push (priority={}, urgency={}, ttl={})",
        msg.priority,
        urgency,
        ttl
    );

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
    // #44: some push services answer a freshly-revoked grant with 401/403
    // instead of 410. Treat those as Gone too, so the row is pruned and we stop
    // fanning out to an endpoint Chrome already killed. 429 must NOT delete --
    // that is rate limiting, not a dead grant (#40).
    if status == 401 || status == 403 {
        let body = resp.text().await.unwrap_or_default();
        console_log!(
            "Push endpoint {} returned {} (permission gone): {}",
            endpoint,
            status,
            body
        );
        return Err(PushError::Gone);
    }
    if status >= 400 {
        let body = resp.text().await.unwrap_or_default();
        console_log!("Push endpoint returned {}: {}", status, body);
        return Err(PushError::HttpStatus(status));
    }
    console_log!("Push sent successfully (status {})", status);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_maps_to_rfc8030_urgency_and_ttl() {
        assert_eq!(delivery_options(1).urgency, "very-low");
        assert_eq!(delivery_options(1).ttl, 3600);

        assert_eq!(delivery_options(2).urgency, "low");
        assert_eq!(delivery_options(2).ttl, 3600);

        assert_eq!(delivery_options(3).urgency, "normal");
        assert_eq!(delivery_options(3).ttl, 14_400);

        assert_eq!(delivery_options(4).urgency, "high");
        assert_eq!(delivery_options(4).ttl, 600);

        assert_eq!(delivery_options(5).urgency, "high");
        assert_eq!(delivery_options(5).ttl, 120);
    }

    #[test]
    fn collapse_token_is_hashed_and_never_the_raw_topic() {
        let topic = "homelab";
        let token = collapse_topic_token(topic);
        assert_ne!(token, topic);
        assert_eq!(token.len(), 32);
        assert!(!token.contains(topic));
        // Deterministic for a given topic.
        assert_eq!(token, collapse_topic_token(topic));
        // Distinct topics produce distinct tokens.
        assert_ne!(collapse_topic_token("homelab"), collapse_topic_token("alerts"));
    }

    #[test]
    fn priority_five_has_no_collapse_topic_header() {
        let (urgency, ttl, topic) = delivery_headers(5, "homelab");
        assert_eq!(urgency, "high");
        assert_eq!(ttl, 120);
        assert!(topic.is_none());
    }

    #[test]
    fn priority_one_collapses_per_topic() {
        let (urgency, ttl, topic) = delivery_headers(1, "homelab");
        assert_eq!(urgency, "very-low");
        assert_eq!(ttl, 3600);
        assert_eq!(topic.as_deref(), Some(collapse_topic_token("homelab").as_str()));
    }
}
