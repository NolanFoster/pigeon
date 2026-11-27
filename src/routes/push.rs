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

/// Per-network, per-topic Web Push slot cap (#62). A /64 prefix (or a full
/// IPv4 address) may hold this many subscriptions on one topic; the topic-wide
/// ceiling of 1000 is the ceiling, not the fairness rule.
const MAX_PER_NETWORK: u32 = 8;
const MAX_PER_TOPIC: u32 = 1000;

/// `RateLimit-Policy` structured field (draft-ietf-httpapi-ratelimit-headers):
/// a stock of `quota` "subscriptions" items.
fn rate_limit_policy(quota: u32) -> String {
    format!("\"subscriptions\";q={};qu=\"items\"", quota)
}

/// `RateLimit` structured field: `remaining` new slots left in the stock.
fn rate_limit(remaining: u32) -> String {
    format!("\"subscriptions\";r={}", remaining)
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

    // The fairness bucket comes from CF-Connecting-IP only (#62, ntfy 2.38.2):
    // Cloudflare sets it, a client cannot. X-Forwarded-For / X-Real-IP /
    // True-Client-IP are deliberately not read — the first forwarded-for line
    // is attacker-controlled once anything in front of us appends instead of
    // replaces. Missing header (local `wrangler dev`) skips the per-network cap
    // but never the topic cap.
    let connecting_ip = req.headers().get("CF-Connecting-IP")?;
    let prefix_hash = connecting_ip.as_deref().and_then(crate::models::prefix_hash);

    let now = (Date::now().as_millis() / 1000) as i64;

    // A re-POST of an endpoint already on the topic is a refresh, not a new
    // slot: update the keys, keep the existing prefix_hash, and return 200 even
    // when this network is already at its cap or the topic is at 1000.
    let existing = db::get_push_subscription_prefix_hash(&d1, &topic, &body.endpoint).await?;
    if let Some(existing_hash) = existing {
        db::update_push_subscription_keys(
            &d1,
            &topic,
            &body.endpoint,
            &body.keys.p256dh,
            &body.keys.auth,
            now,
        )
        .await?;
        let resp = Response::ok("subscribed")?;
        if let Some(hash) = existing_hash {
            let net_count = db::count_push_subscriptions_by_prefix(&d1, &topic, &hash).await?;
            resp.headers()
                .set("RateLimit", &rate_limit(MAX_PER_NETWORK.saturating_sub(net_count)))?;
        }
        // A grandfathered NULL hash has no prefix to report; RateLimit is
        // omitted and does not change.
        return Ok(resp);
    }

    // New endpoint: the topic cap is the ceiling, then the per-network cap.
    let count = db::count_push_subscriptions(&d1, &topic).await?;
    if count >= MAX_PER_TOPIC {
        let resp =
            Response::error("Too Many Requests: max subscriptions reached for topic", 429)?;
        resp.headers().set("RateLimit-Policy", &rate_limit_policy(MAX_PER_TOPIC))?;
        resp.headers().set("RateLimit", &rate_limit(0))?;
        return Ok(resp);
    }
    if let Some(hash) = prefix_hash.as_deref() {
        let net_count = db::count_push_subscriptions_by_prefix(&d1, &topic, hash).await?;
        if net_count >= MAX_PER_NETWORK {
            let resp =
                Response::error("Too Many Requests: max subscriptions for this network", 429)?;
            resp.headers().set("RateLimit-Policy", &rate_limit_policy(MAX_PER_NETWORK))?;
            resp.headers().set("RateLimit", &rate_limit(0))?;
            return Ok(resp);
        }
    }

    db::insert_push_subscription(
        &d1,
        &topic,
        &body.endpoint,
        &body.keys.p256dh,
        &body.keys.auth,
        now,
        prefix_hash.as_deref(),
    )
    .await?;

    let resp = Response::ok("subscribed")?;
    if let Some(hash) = prefix_hash {
        let net_count = db::count_push_subscriptions_by_prefix(&d1, &topic, &hash).await?;
        resp.headers()
            .set("RateLimit", &rate_limit(MAX_PER_NETWORK.saturating_sub(net_count)))?;
    }
    Ok(resp)
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

/// GET /push/budget — the origin's Web Push day count (#61). No topic and no
/// token: the count is not a secret (it is the number Chrome is already
/// scoring per origin), and this is a counter, not a log — the response never
/// includes a topic name, an endpoint, an endpoint hash, or a message body.
pub async fn budget(_req: Request, ctx: RouteContext<Context>) -> Result<Response> {
    let d1 = ctx.env.d1("DB")?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let s = crate::budget::read_budget(&d1, now).await?;
    Response::from_json(&serde_json::json!({
        "day": s.day,
        "attempted": s.attempted,
        "skipped": s.skipped,
        "throttled": s.throttled,
        "paused_until": s.paused_until,
        "warn": s.warn,
    }))
}
