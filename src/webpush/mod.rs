pub mod encrypt;
pub mod vapid;

use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::Message;

pub async fn send_push_to_topic(env: &Env, msg: &Message) -> Result<()> {
    let db = env.d1("DB")?;
    let subscriptions = db::get_push_subscriptions(&db, &msg.topic).await?;

    if subscriptions.is_empty() {
        return Ok(());
    }

    let vapid_private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
    let vapid_public_key = env.var("VAPID_PUBLIC_KEY")?.to_string();
    let vapid_subject = env.var("VAPID_SUBJECT")?.to_string();

    let payload = serde_json::to_vec(msg)?;

    for sub in &subscriptions {
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
            Err(e) => {
                console_log!("Web Push failed for {}: {:?}", &sub.endpoint, e);
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
) -> Result<()> {
    let encrypted = encrypt::encrypt_payload(payload, p256dh, auth)?;
    let auth_header =
        vapid::build_vapid_header(endpoint, vapid_private_key, vapid_public_key, vapid_subject)?;

    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    headers.set("Content-Encoding", "aes128gcm")?;
    headers.set("Content-Type", "application/octet-stream")?;
    headers.set("TTL", "86400")?;

    let body = js_sys::Uint8Array::from(encrypted.as_slice());
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from(body)));

    let req = Request::new_with_init(endpoint, &init)?;
    let mut resp = Fetch::Request(req).send().await?;
    let status = resp.status_code();
    if status >= 400 {
        let body = resp.text().await.unwrap_or_default();
        console_log!("Push endpoint returned {}: {}", status, body);
        return Err(Error::RustError(format!("Push failed with status {}", status)));
    }
    console_log!("Push sent successfully (status {})", status);
    Ok(())
}
