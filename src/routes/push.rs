use worker::*;

use crate::db;
use crate::models::{
    validate_push_endpoint, validate_topic, PushSubscriptionRequest, PushUnsubscribeRequest,
};

pub async fn vapid_key(_req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    // The browser must be handed the key the worker will actually sign with. The
    // key is derived from VAPID_PRIVATE_KEY whenever the secret is present; the
    // [vars] VAPID_PUBLIC_KEY is only a local-dev fallback (wrangler dev without
    // the secret). A stale var that no longer matches the secret would silently
    // kill every subscription, so log the mismatch at request time.
    if let Ok(secret) = ctx.env.secret("VAPID_PRIVATE_KEY") {
        if let Ok(derived) = crate::webpush::vapid::get_public_key_b64(&secret.to_string()) {
            if let Ok(configured) = ctx.env.var("VAPID_PUBLIC_KEY") {
                if configured.to_string() != derived {
                    console_log!(
                        "VAPID_PUBLIC_KEY var does not match the key derived from VAPID_PRIVATE_KEY; serving the derived key"
                    );
                }
            }
            return Response::ok(derived);
        }
    }
    let key = ctx.var("VAPID_PUBLIC_KEY")?.to_string();
    Response::ok(key)
}

pub async fn subscribe(mut req: Request, ctx: RouteContext<Context>) -> Result<Response> {
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

pub async fn unsubscribe(mut req: Request, ctx: RouteContext<Context>) -> Result<Response> {
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
pub async fn unsubscribe_all(mut req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let body: PushUnsubscribeRequest = req.json().await?;
    if body.endpoint.is_empty() || body.endpoint.len() > 512 {
        return Response::error("invalid push endpoint", 400);
    }

    let d1 = ctx.d1("DB")?;
    db::delete_push_subscriptions_by_endpoint(&d1, &body.endpoint).await?;

    Response::ok("unsubscribed")
}

/// Polled delivery receipts (§56). Same capability-URL model as GET /:topic/json:
/// knowing the topic is the credential. The rows are topic-scoped operational
/// records with a 24-hour life, not an archive.
pub async fn receipts(req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let topic = ctx.param("topic").unwrap().to_string();
    validate_topic(&topic)?;

    let url = req.url()?;
    let since_raw = url
        .query_pairs()
        .find(|(k, _)| k == "since")
        .map(|(_, v)| v);
    let id = url
        .query_pairs()
        .find(|(k, _)| k == "id")
        .map(|(_, v)| v);

    let now = (Date::now().as_millis() / 1000) as i64;
    let since = match since_raw {
        Some(v) => {
            let n = v.parse::<i64>().map_err(|_| {
                worker::Error::RustError("since must be a unix timestamp".into())
            })?;
            // Receipts are an operational signal, not an archive: reject asks
            // older than 24 hours.
            if n < now - 24 * 3600 {
                return Response::error("since is older than 24 hours", 400);
            }
            n
        }
        None => {
            // `id` lookups (the common curl case: publish, then poll that id)
            // may omit `since` and default to the full retention window.
            if id.is_none() {
                return Response::error("since is required", 400);
            }
            now - 24 * 3600
        }
    };

    let d1 = ctx.env.d1("DB")?;
    let receipts = db::get_push_receipts(&d1, &topic, since, id.as_deref()).await?;
    Response::from_json(&receipts)
}
