use worker::*;

use crate::db;
use crate::models::{
    validate_push_endpoint, validate_topic, PushSubscriptionRequest, PushUnsubscribeRequest,
};

pub async fn vapid_key(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let key = ctx.var("VAPID_PUBLIC_KEY")?.to_string();
    Response::ok(key)
}

pub async fn subscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    let body: PushSubscriptionRequest = req.json().await?;
    // Refuse arbitrary endpoint URLs: only real push services. Without this
    // the worker turns into a generic HTTP-POST amplifier (every publish
    // triggers a signed POST to whatever URL the subscriber registered).
    if let Err(e) = validate_push_endpoint(&body.endpoint) {
        return Response::error(format!("invalid push endpoint: {}", e), 400);
    }
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
    if body.endpoint.is_empty() || body.endpoint.len() > 512 {
        return Response::error("invalid push endpoint", 400);
    }

    let d1 = ctx.d1("DB")?;
    db::delete_push_subscription(&d1, &topic, &body.endpoint).await?;

    Response::ok("unsubscribed")
}

/// Unregister an endpoint from every topic at once. This is the reliable
/// off switch: the client doesn't have to still remember which topics it
/// registered, and one failed request can't leave a topic pushing.
pub async fn unsubscribe_all(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: PushUnsubscribeRequest = req.json().await?;
    if body.endpoint.is_empty() || body.endpoint.len() > 512 {
        return Response::error("invalid push endpoint", 400);
    }

    let d1 = ctx.d1("DB")?;
    db::delete_push_subscriptions_by_endpoint(&d1, &body.endpoint).await?;

    Response::ok("unsubscribed")
}
