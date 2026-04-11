use uuid::Uuid;
use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::Message;

pub async fn handle(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    let body = req.text().await?;

    let headers = req.headers();
    let title = headers.get("X-Title")?.or(headers.get("Title")?);
    let priority: u8 = headers
        .get("X-Priority")?
        .or(headers.get("Priority")?)
        .and_then(|p| p.parse().ok())
        .unwrap_or(3);
    let tags = headers.get("X-Tags")?.or(headers.get("Tags")?);
    let click = headers.get("X-Click")?.or(headers.get("Click")?);
    let image = headers.get("X-Image")?.or(headers.get("Image")?);
    let markdown = headers
        .get("X-Markdown")?
        .or(headers.get("Markdown")?)
        .map(|v| v == "1" || v == "true" || v == "yes")
        .unwrap_or(false);

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
