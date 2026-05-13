use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::validate_topic;

pub async fn handle(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap();
    validate_topic(topic)?;

    let url = _req.url()?;
    let since: i64 = url
        .query_pairs()
        .find(|(k, _)| k == "since")
        .and_then(|(_, v)| {
            if v == "all" {
                Some(0)
            } else {
                v.parse().ok()
            }
        })
        .unwrap_or(0);

    let d1 = ctx.env.d1("DB")?;
    let messages = db::get_messages_since(&d1, topic, since).await?;

    Response::from_json(&messages)
}

pub async fn delete(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap();
    validate_topic(topic)?;
    let d1 = ctx.env.d1("DB")?;
    db::delete_messages(&d1, topic).await?;
    Response::ok("deleted")
}

pub async fn delete_one(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;
    let id = ctx.param("id").unwrap().to_string();

    let d1 = ctx.env.d1("DB")?;
    db::delete_message(&d1, &topic, &id).await?;

    let event = serde_json::json!({
        "deleted": true,
        "id": id,
        "topic": topic,
    });
    let event_body = event.to_string();

    let namespace = ctx.durable_object("TOPIC_ROOM")?;
    let stub = namespace.id_from_name(&topic)?.get_stub()?;
    let do_headers = Headers::new();
    do_headers.set("Content-Type", "application/json")?;
    let mut do_init = RequestInit::new();
    do_init
        .with_method(Method::Post)
        .with_headers(do_headers)
        .with_body(Some(JsValue::from_str(&event_body)));
    let do_req = Request::new_with_init("https://do/broadcast", &do_init)?;
    if let Err(e) = stub.fetch_with_request(do_req).await {
        console_log!("DO delete broadcast failed: {:?}", e);
    }

    Response::ok("deleted")
}
