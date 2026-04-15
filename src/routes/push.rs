use worker::*;

use crate::db;
use crate::models::{PushSubscriptionRequest, PushUnsubscribeRequest, validate_topic};

pub async fn vapid_key(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let key = ctx.var("VAPID_PUBLIC_KEY")?.to_string();
    Response::ok(key)
}

pub async fn subscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    let body: PushSubscriptionRequest = req.json().await?;
    let d1 = ctx.d1("DB")?;

    let count = db::count_push_subscriptions(&d1, &topic).await?;
    if count >= 1000 {
        return Response::error("Too Many Requests: max subscriptions reached for topic", 429);
    }

    let now = (Date::now().as_millis() / 1000) as i64;
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
    validate_topic(&topic)?;

    let body: PushUnsubscribeRequest = req.json().await?;

    let d1 = ctx.d1("DB")?;
    db::delete_push_subscription(&d1, &topic, &body.endpoint).await?;

    Response::ok("unsubscribed")
}
