use uuid::Uuid;
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{Message, validate_topic};

pub async fn handle(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
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
        )
    };

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

    let (title, tags, click, image, markdown) = if is_encrypted {
        // Don't honour content headers for encrypted messages — title/tags/etc.
        // live inside the ciphertext envelope. Store a fixed placeholder title
        // so the server-visible record is uniformly opaque.
        (Some("[encrypted]".to_string()), None, None, None, false)
    } else {
        (
            title_header,
            tags_header,
            click_header,
            image_header,
            markdown_header,
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
        created_at: now as i64,
    };

    // Insert into D1
    let d1 = ctx.d1("DB")?;
    db::insert_message(&d1, &msg).await?;

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

    // Send Web Push notifications (must await, not spawn_local)
    if let Err(e) = crate::webpush::send_push_to_topic(&ctx.env, &msg).await {
        console_log!("Web Push error: {:?}", e);
    }

    Response::from_json(&msg)
}
