use worker::*;

use crate::db;
use crate::models::{PushSubscriptionRequest, PushUnsubscribeRequest};

pub async fn vapid_key(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let key = ctx.var("VAPID_PUBLIC_KEY")?.to_string();
    Response::ok(key)
}

pub async fn subscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    let body: PushSubscriptionRequest = req.json().await?;

    let now = (Date::now().as_millis() / 1000) as i64;
    let d1 = ctx.d1("DB")?;
    db::insert_push_subscription(
        &d1,
        &topic,
        &body.endpoint,
        &body.keys.p256dh,
        &body.keys.auth,
        now,
    )
    .await?;

    Response::ok("subscribed")
}

pub async fn unsubscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    let body: PushUnsubscribeRequest = req.json().await?;

    let d1 = ctx.d1("DB")?;
    db::delete_push_subscription(&d1, &topic, &body.endpoint).await?;

    Response::ok("unsubscribed")
}
