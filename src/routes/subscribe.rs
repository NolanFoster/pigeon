use worker::*;

pub async fn handle(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();

    let namespace = ctx.env.durable_object("TOPIC_ROOM")?;
    let stub = namespace.id_from_name(&topic)?.get_stub()?;

    let url = req.url()?;
    let since = url
        .query_pairs()
        .find(|(k, _)| k == "since")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();

    let do_url = if since.is_empty() {
        "https://do/connect".to_string()
    } else {
        format!("https://do/connect?since={}", since)
    };

    // Forward the original request headers (including Upgrade: websocket)
    let headers = req.headers().clone();
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let do_req = Request::new_with_init(&do_url, &init)?;

    stub.fetch_with_request(do_req).await
}
