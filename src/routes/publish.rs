use uuid::Uuid;
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{valid_language_tag, Message, validate_topic};

// ntfy 2.28 field caps. Titles and tags are fan-out amplifiers: every
// subscriber's Web Push carries them, so an unbounded header inflates every
// fan-out. Byte length, not character length (matches ntfy and how FCM counts).
const TITLE_MAX_BYTES: usize = 1024;
const TAGS_MAX_BYTES: usize = 512;

pub async fn handle(mut req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    // Extract every header value we need up-front so the immutable borrow on
    // `req.headers()` ends before the mutable `req.text()` call below.
    let (
        is_encrypted,
        max_body,
        content_length_opt,
        priority,
        title_header,
        tags_header,
        click_header,
        image_header,
        markdown_header,
        language_header,
    ) = {
        let headers = req.headers();
        let content_type = headers.get("Content-Type")?.unwrap_or_default();
        let encrypted_header = headers
            .get("X-Encrypted")?
            .map(|v| v == "1" || v == "true" || v == "yes")
            .unwrap_or(false);
        let is_encrypted = encrypted_header || content_type == "application/vnd.pigeon.e2ee+json";
        // Encrypted payloads carry a base64url ciphertext envelope inside JSON,
        // which inflates the wire size. Allow a larger ceiling for those.
        let max_body = if is_encrypted { 16384 } else { 8192 };
        let content_length_opt = headers.get("Content-Length")?;
        let priority: u8 = headers
            .get("X-Priority")?
            .or(headers.get("Priority")?)
            .and_then(|p| p.parse().ok())
            .unwrap_or(3)
            .clamp(1, 5);
        let title_header = headers.get("X-Title")?.or(headers.get("Title")?);
        let tags_header = headers.get("X-Tags")?.or(headers.get("Tags")?);
        let click_header = headers.get("X-Click")?.or(headers.get("Click")?);
        let image_header = headers.get("X-Image")?.or(headers.get("Image")?);
        let markdown_header = headers
            .get("X-Markdown")?
            .or(headers.get("Markdown")?)
            .map(|v| v == "1" || v == "true" || v == "yes")
            .unwrap_or(false);
        let language_header = headers.get("X-Language")?.or(headers.get("Language")?);
        (
            is_encrypted,
            max_body,
            content_length_opt,
            priority,
            title_header,
            tags_header,
            click_header,
            image_header,
            markdown_header,
            language_header,
        )
    };

    // Publish field caps (§1). Reject before D1 insert so a 1 MB title can't
    // inflate every fan-out. The caps apply to the plaintext path only — E2EE
    // POSTs ignore content headers (the plaintext lives inside the envelope),
    // and their size stays bounded by the body ceiling.
    if !is_encrypted {
        if let Some(t) = title_header.as_deref() {
            if t.len() > TITLE_MAX_BYTES {
                return Response::error("title too long", 400);
            }
        }
        if let Some(t) = tags_header.as_deref() {
            if t.len() > TAGS_MAX_BYTES {
                return Response::error("tags too long", 400);
            }
        }
        // A publisher who set X-Language meant it: reject a bad tag rather than
        // silently dropping it (same rule as over-long titles and tags).
        if let Some(l) = language_header.as_deref() {
            if !valid_language_tag(l) {
                return Response::error("language invalid", 400);
            }
        }
    }

    // Reject oversized bodies before reading them — otherwise a 100MB POST
    // is fully buffered into worker memory before the post-read check fires.
    // Clients can lie about / omit Content-Length, so we still check after.
    if let Some(cl) = content_length_opt {
        if let Ok(n) = cl.parse::<usize>() {
            if n > max_body {
                return Response::error("Payload Too Large", 413);
            }
        }
    }

    let body = req.text().await?;
    if body.len() > max_body {
        return Response::error("Payload Too Large", 413);
    }

    // For E2EE the language lives inside the ciphertext (the client seals it
    // next to title/click/image); the server ignores the header and stores None.
    let (title, tags, click, image, markdown, language) = if is_encrypted {
        (Some("[encrypted]".to_string()), None, None, None, false, None)
    } else {
        (
            title_header,
            tags_header,
            click_header,
            image_header,
            markdown_header,
            language_header,
        )
    };

    let now = Date::now().as_millis() / 1000;

    let msg = Message {
        id: Uuid::new_v4().to_string(),
        topic: topic.clone(),
        title,
        message: body,
        priority,
        tags,
        click,
        image,
        markdown,
        encrypted: is_encrypted,
        language,
        created_at: now as i64,
    };

    // Insert into D1
    let d1 = ctx.d1("DB")?;
    db::insert_message(&d1, &msg).await?;

    // Opportunistic receipt retention (§56): delete rows older than 24h for this
    // topic at the start of the publish. No cron, no Queue — this rides the
    // publish that already touches the table.
    if let Err(e) = db::prune_old_push_receipts(&d1, &topic, now as i64 - 24 * 3600).await {
        console_log!("Receipt retention failed: {:?}", e);
    }

    // Broadcast to WebSocket subscribers via Durable Object
    let namespace = ctx.durable_object("TOPIC_ROOM")?;
    let stub = namespace.id_from_name(&topic)?.get_stub()?;
    let broadcast_body = serde_json::to_string(&msg)?;

    let do_headers = Headers::new();
    do_headers.set("Content-Type", "application/json")?;
    let mut do_init = RequestInit::new();
    do_init
        .with_method(Method::Post)
        .with_headers(do_headers)
        .with_body(Some(JsValue::from_str(&broadcast_body)));
    let do_req = Request::new_with_init("https://do/broadcast", &do_init)?;
    match stub.fetch_with_request(do_req).await {
        Ok(resp) => {
            if resp.status_code() != 200 {
                console_log!("DO broadcast returned status {}", resp.status_code());
            }
        }
        Err(e) => {
            console_log!("DO broadcast failed: {:?}", e);
        }
    }

    // Web Push fan-out. Count the allowlisted subscriptions first, then hand the
    // actual delivery to wait_until so a slow push service never stalls the
    // publish response. The response only carries the count and the receipts URL.
    let subscriptions = crate::webpush::prepare_subscriptions(&ctx.env, &topic).await?;
    let attempted = subscriptions.len();
    if attempted > 0 {
        let env = ctx.env.clone();
        let msg_clone = msg.clone();
        ctx.data.wait_until(async move {
            if let Err(e) =
                crate::webpush::send_push_to_topic(&env, &msg_clone, &subscriptions).await
            {
                console_log!("Web Push error: {:?}", e);
            }
        });
    }

    let resp = Response::from_json(&msg)?;
    resp.headers().set("X-Message-Id", &msg.id)?;
    resp.headers().set("X-Push-Attempted", &attempted.to_string())?;
    if attempted > 0 {
        resp.headers().set(
            "X-Push-Receipts",
            &format!("/{}/push/receipts?id={}", topic, msg.id),
        )?;
    }
    Ok(resp)
}
