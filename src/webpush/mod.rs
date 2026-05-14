pub mod encrypt;
pub mod vapid;

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
        return Err(PushError::HttpStatus(status));
    }
    console_log!("Push sent successfully (status {})", status);
    Ok(())
}
