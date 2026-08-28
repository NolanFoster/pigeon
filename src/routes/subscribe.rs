use worker::*;
use crate::models::validate_topic;

pub async fn handle(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    let namespace = ctx.env.durable_object("TOPIC_ROOM")?;
    let stub = namespace.id_from_name(&topic)?.get_stub()?;

    let url = req.url()?;
    let since = url
        .query_pairs()
        .find(|(k, _)| k == "since")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();

    // Forward the topic explicitly: a Durable Object can recover neither its
    // name nor the route parameters, but needs it to replay durable history
    // after registering the socket. This closes the subscribe/publish race.
    let do_url = if since.is_empty() {
        format!("https://do/connect?topic={}", topic)
    } else {
        format!("https://do/connect?topic={}&since={}", topic, since)
    };

    // Forward the original request headers (including Upgrade: websocket)
    let headers = req.headers().clone();
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let do_req = Request::new_with_init(&do_url, &init)?;

    stub.fetch_with_request(do_req).await
}
