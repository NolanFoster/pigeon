use worker::*;

use crate::models::{validate_topic, ScheduledListItem};

/// `GET /:topic/scheduled` — the pending rows for a topic: id, deliver_at,
/// timezone (if set), title, priority. Never the body (it can be an E2EE
/// envelope or a 16 KB secret). Same capability-URL rule: the topic is the
/// credential.
pub async fn list(req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    let _ = req;
    let namespace = ctx.durable_object("TOPIC_ROOM")?;
    let stub = namespace
        .id_from_name(&crate::schedule::scheduler_id_name(&topic))?
        .get_stub()?;

    let do_req = Request::new_with_init("https://do/list", &RequestInit::new())?;
    let mut resp = stub.fetch_with_request(do_req).await?;
    let text = resp.text().await?;
    let items: Vec<ScheduledListItem> = serde_json::from_str(&text)?;
    Response::from_json(&items)
}

/// `DELETE /:topic/scheduled/:id` — cancel a pending scheduled message.
/// `204` if it existed, `404` if it did not. Cancelling a message that already
/// fired is a 404 (fired messages are ordinary messages).
pub async fn cancel(_req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;
    let id = ctx.param("id").unwrap().to_string();
    if id.is_empty() {
        return Response::error("Not found", 404);
    }

    let namespace = ctx.durable_object("TOPIC_ROOM")?;
    let stub = namespace
        .id_from_name(&crate::schedule::scheduler_id_name(&topic))?
        .get_stub()?;

    let mut init = RequestInit::new();
    init.with_method(Method::Delete);
    let do_req = Request::new_with_init(&format!("https://do/cancel/{}", id), &init)?;
    let resp = stub.fetch_with_request(do_req).await?;
    if resp.status_code() == 404 {
        return Response::error("Not found", 404);
    }
    Ok(Response::ok("")?.with_status(204))
}
