use worker::*;

use crate::db;

pub async fn handle(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap();

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
    let d1 = ctx.env.d1("DB")?;
    db::delete_messages(&d1, topic).await?;
    Response::ok("deleted")
}
