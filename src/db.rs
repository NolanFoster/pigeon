use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::models::{Message, PushReceipt, PushSubscriptionRecord};

// Replay bound (ntfy 2.28 parity): never return an unbounded topic. The SQL
// below asks for one extra row (LIMIT 501) so callers can detect truncation
// without a second round-trip.
const REPLAY_MAX: usize = 500;

pub async fn insert_message(db: &D1Database, msg: &Message) -> Result<()> {
    let stmt = db.prepare(
        "INSERT INTO messages (id, topic, title, message, priority, tags, click, image, markdown, language, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    );
    stmt.bind(&[
        JsValue::from_str(&msg.id),
        JsValue::from_str(&msg.topic),
        msg.title.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from_str(&msg.message),
        JsValue::from(msg.priority as f64),
        msg.tags.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        msg.click.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        msg.image.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from(if msg.markdown { 1.0 } else { 0.0 }),
        msg.language.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from(msg.created_at as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Fetch messages for a topic since `since`, bounded to the newest 500 when
/// `since == 0` ("all") or the first 500 after the cursor otherwise.
///
/// Returns `(messages, truncated)` where `truncated` is true when the cap cut
/// the result short. Messages are always in ascending `created_at` order so the
/// existing client can reverse them into a newest-first list unchanged.
///
/// The Durable Object's WebSocket history replay calls this same function, so
/// the WS bootstrap and the JSON poll share the same replay bound.
pub async fn get_messages_since(
    db: &D1Database,
    topic: &str,
    since: i64,
) -> Result<(Vec<Message>, bool)> {
    if since == 0 {
        // "all": newest 500. Query newest-first (insertion order breaks ties in
        // the second-granularity created_at), keep the newest, reverse to
        // ascending for the client.
        let stmt = db.prepare(
            "SELECT id, topic, title, message, priority, tags, click, image, markdown, language, created_at
             FROM messages WHERE topic = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 501",
        );
        let result = stmt.bind(&[JsValue::from_str(topic)])?.all().await?;
        let rows: Vec<MessageRow> = result.results()?;
        let truncated = rows.len() > REPLAY_MAX;
        let mut messages: Vec<Message> = rows
            .into_iter()
            .take(REPLAY_MAX)
            .map(|r| r.into())
            .collect();
        messages.reverse();
        Ok((messages, truncated))
    } else {
        // Forward from the cursor, stop at the cap so a cursor-holding client
        // never skips.
        let stmt = db.prepare(
            "SELECT id, topic, title, message, priority, tags, click, image, markdown, language, created_at
             FROM messages WHERE topic = ?1 AND created_at > ?2 ORDER BY created_at ASC, rowid ASC LIMIT 501",
        );
        let result = stmt
            .bind(&[JsValue::from_str(topic), JsValue::from(since as f64)])?
            .all()
            .await?;
        let rows: Vec<MessageRow> = result.results()?;
        let truncated = rows.len() > REPLAY_MAX;
        let messages: Vec<Message> = rows
            .into_iter()
            .take(REPLAY_MAX)
            .map(|r| r.into())
            .collect();
        Ok((messages, truncated))
    }
}

pub async fn get_message(
    db: &D1Database,
    topic: &str,
    id: &str,
) -> Result<Option<Message>> {
    let stmt = db.prepare(
        "SELECT id, topic, title, message, priority, tags, click, image, markdown, language, created_at
         FROM messages WHERE topic = ?1 AND id = ?2 LIMIT 1",
    );
    let result = stmt
        .bind(&[JsValue::from_str(topic), JsValue::from_str(id)])?
        .first::<MessageRow>(None)
        .await?;
    Ok(result.map(|r| r.into()))
}

pub async fn get_push_subscriptions(
    db: &D1Database,
    topic: &str,
) -> Result<Vec<PushSubscriptionRecord>> {
    let stmt = db.prepare(
        "SELECT id, topic, endpoint, p256dh, auth, created_at
         FROM push_subscriptions WHERE topic = ?1",
    );
    let result: D1Result = stmt.bind(&[JsValue::from_str(topic)])?.all().await?;
    result.results()
}

pub async fn count_push_subscriptions(db: &D1Database, topic: &str) -> Result<u32> {
    let stmt = db.prepare("SELECT COUNT(*) as count FROM push_subscriptions WHERE topic = ?1");
    let result = stmt.bind(&[JsValue::from_str(topic)])?.first::<u32>(Some("count")).await?;
    Ok(result.unwrap_or(0))
}

/// Row shape for the existence lookup in #62: whether a (topic, endpoint) row
/// exists and, if so, the `prefix_hash` it was registered under. `prefix_hash`
/// is `None` for grandfathered rows (registered before the column existed) and
/// for rows created while `CF-Connecting-IP` was absent.
#[derive(serde::Deserialize)]
struct PrefixHashRow {
    prefix_hash: Option<String>,
}

/// `Ok(None)` when no such row exists; `Ok(Some(None))` when the row exists but
/// its `prefix_hash` is NULL (grandfathered); `Ok(Some(Some(hash)))` otherwise.
pub async fn get_push_subscription_prefix_hash(
    db: &D1Database,
    topic: &str,
    endpoint: &str,
) -> Result<Option<Option<String>>> {
    let stmt = db.prepare(
        "SELECT prefix_hash FROM push_subscriptions WHERE topic = ?1 AND endpoint = ?2 LIMIT 1",
    );
    let result = stmt
        .bind(&[JsValue::from_str(topic), JsValue::from_str(endpoint)])?
        .first::<PrefixHashRow>(None)
        .await?;
    Ok(result.map(|r| r.prefix_hash))
}

/// Number of subscription rows on one topic that carry `prefix_hash`. Only
/// non-NULL hashes count toward the per-network cap (#62); grandfathered NULL
/// rows count toward the topic cap of 1000 and toward no prefix.
pub async fn count_push_subscriptions_by_prefix(
    db: &D1Database,
    topic: &str,
    prefix_hash: &str,
) -> Result<u32> {
    let stmt = db.prepare(
        "SELECT COUNT(*) as count FROM push_subscriptions WHERE topic = ?1 AND prefix_hash = ?2",
    );
    let result = stmt
        .bind(&[JsValue::from_str(topic), JsValue::from_str(prefix_hash)])?
        .first::<u32>(Some("count"))
        .await?;
    Ok(result.unwrap_or(0))
}

pub async fn insert_push_subscription(
    db: &D1Database,
    topic: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    created_at: i64,
    prefix_hash: Option<&str>,
) -> Result<()> {
    let stmt = db.prepare(
        "INSERT INTO push_subscriptions (topic, endpoint, p256dh, auth, created_at, prefix_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    stmt.bind(&[
        JsValue::from_str(topic),
        JsValue::from_str(endpoint),
        JsValue::from_str(p256dh),
        JsValue::from_str(auth),
        JsValue::from(created_at as f64),
        prefix_hash.map_or(JsValue::NULL, JsValue::from_str),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Refresh the keys of an endpoint already on the topic (#62). `prefix_hash`
/// is deliberately untouched: a re-POST is a refresh, not a new slot, and it
/// must not move the row between network buckets.
pub async fn update_push_subscription_keys(
    db: &D1Database,
    topic: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    created_at: i64,
) -> Result<()> {
    let stmt = db.prepare(
        "UPDATE push_subscriptions SET p256dh = ?1, auth = ?2, created_at = ?3
         WHERE topic = ?4 AND endpoint = ?5",
    );
    stmt.bind(&[
        JsValue::from_str(p256dh),
        JsValue::from_str(auth),
        JsValue::from(created_at as f64),
        JsValue::from_str(topic),
        JsValue::from_str(endpoint),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_messages(db: &D1Database, topic: &str) -> Result<()> {
    let stmt = db.prepare("DELETE FROM messages WHERE topic = ?1");
    stmt.bind(&[JsValue::from_str(topic)])?.run().await?;
    Ok(())
}

pub async fn delete_message(db: &D1Database, topic: &str, id: &str) -> Result<()> {
    let stmt = db.prepare("DELETE FROM messages WHERE topic = ?1 AND id = ?2");
    stmt.bind(&[JsValue::from_str(topic), JsValue::from_str(id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn delete_push_subscription(
    db: &D1Database,
    topic: &str,
    endpoint: &str,
) -> Result<()> {
    let stmt = db.prepare(
        "DELETE FROM push_subscriptions WHERE topic = ?1 AND endpoint = ?2",
    );
    stmt.bind(&[JsValue::from_str(topic), JsValue::from_str(endpoint)])?
        .run()
        .await?;
    Ok(())
}

/// Removes a push endpoint from every topic it was ever registered against.
/// A client that wants push off can only enumerate the topics it still knows
/// about — topics dropped earlier (or on another install of the same browser
/// profile) would keep pushing forever. Deleting by endpoint alone makes
/// "disable push" a single, complete operation.
pub async fn delete_push_subscriptions_by_endpoint(
    db: &D1Database,
    endpoint: &str,
) -> Result<()> {
    let stmt = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1");
    stmt.bind(&[JsValue::from_str(endpoint)])?.run().await?;
    Ok(())
}

/// Record one delivery attempt. The endpoint is stored only as a sha256 hash —
/// never the URL itself. One attempt is one row until #55's deferred retry
/// lands; that retry will upsert on (message_id, endpoint_hash) instead of
/// inserting a second row.
pub async fn insert_push_receipt(
    db: &D1Database,
    message_id: &str,
    topic: &str,
    endpoint_hash: &str,
    status: &str,
    http_status: Option<i64>,
    created_at: i64,
) -> Result<()> {
    let stmt = db.prepare(
        "INSERT INTO push_receipts (message_id, topic, endpoint_hash, status, http_status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    stmt.bind(&[
        JsValue::from_str(message_id),
        JsValue::from_str(topic),
        JsValue::from_str(endpoint_hash),
        JsValue::from_str(status),
        http_status.map_or(JsValue::NULL, JsValue::from),
        JsValue::from(created_at as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Read receipts for a topic since a cursor, optionally filtered to one message
/// id. Newest last (ascending), capped at the newest 500 rows. Only the public
/// fields are selected — the endpoint hash never leaves the table.
pub async fn get_push_receipts(
    db: &D1Database,
    topic: &str,
    since: i64,
    message_id: Option<&str>,
) -> Result<Vec<PushReceipt>> {
    // LIMIT is inlined (a compile-time constant) rather than bound — keeps the
    // query's bind count unambiguous across the two shapes.
    let query = if message_id.is_some() {
        "SELECT message_id, topic, status, http_status, created_at
         FROM push_receipts
         WHERE topic = ?1 AND created_at >= ?2 AND message_id = ?3
         ORDER BY created_at DESC, id DESC LIMIT 500"
    } else {
        "SELECT message_id, topic, status, http_status, created_at
         FROM push_receipts
         WHERE topic = ?1 AND created_at >= ?2
         ORDER BY created_at DESC, id DESC LIMIT 500"
    };

    let mut binds: Vec<JsValue> = vec![
        JsValue::from_str(topic),
        JsValue::from(since as f64),
    ];
    if let Some(mid) = message_id {
        binds.push(JsValue::from_str(mid));
    }

    let stmt = db.prepare(query).bind(&binds)?;
    let result = stmt.all().await?;
    let rows: Vec<PushReceiptRow> = result.results()?;

    // DESC query keeps the newest; reverse so the JSON array is newest-last.
    let mut receipts: Vec<PushReceipt> = rows.into_iter().map(|r| r.into()).collect();
    receipts.reverse();
    Ok(receipts)
}

/// Opportunistic retention: receipts older than 24 hours are deleted at the
/// start of a publish to their topic. The `id IN (SELECT … LIMIT 200)` cap keeps
/// a long-neglected topic from turning one publish into a table scan. No cron,
/// no Queue — this rides the publish that already touches the table.
pub async fn prune_old_push_receipts(db: &D1Database, topic: &str, cutoff: i64) -> Result<()> {
    let stmt = db.prepare(
        "DELETE FROM push_receipts
         WHERE id IN (
             SELECT id FROM push_receipts WHERE topic = ?1 AND created_at < ?2 LIMIT 200
         )",
    );
    stmt.bind(&[JsValue::from_str(topic), JsValue::from(cutoff as f64)])?
        .run()
        .await?;
    Ok(())
}

/// One row of the origin push budget (#61). `burst` is a JSON object
/// `{"head": <unix second>, "buckets": [60 ints]}` (see `budget::Burst`).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PushBudgetRow {
    pub attempted: i64,
    pub skipped: i64,
    pub throttled: i64,
    pub paused_until: Option<i64>,
    pub burst: Option<String>,
}

pub async fn get_push_budget(db: &D1Database, day: &str) -> Result<Option<PushBudgetRow>> {
    let stmt = db.prepare(
        "SELECT attempted, skipped, throttled, paused_until, burst
         FROM push_budget WHERE day = ?1 LIMIT 1",
    );
    let result = stmt
        .bind(&[JsValue::from_str(day)])?
        .first::<PushBudgetRow>(None)
        .await?;
    Ok(result)
}

/// Create today's row if it does not exist. `day` is a "YYYY-MM-DD" UTC date.
pub async fn ensure_push_budget(db: &D1Database, day: &str) -> Result<()> {
    let stmt = db.prepare(
        "INSERT OR IGNORE INTO push_budget (day, attempted, skipped, throttled, paused_until, burst)
         VALUES (?1, 0, 0, 0, NULL, NULL)",
    );
    stmt.bind(&[JsValue::from_str(day)])?.run().await?;
    Ok(())
}

/// Overwrite the optimistic attempt count and burst ring for the day.
pub async fn set_push_budget_attempted_and_burst(
    db: &D1Database,
    day: &str,
    attempted: i64,
    burst: &str,
) -> Result<()> {
    let stmt = db.prepare("UPDATE push_budget SET attempted = ?1, burst = ?2 WHERE day = ?3");
    stmt.bind(&[
        JsValue::from(attempted as f64),
        JsValue::from_str(burst),
        JsValue::from_str(day),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn add_push_budget_skipped(db: &D1Database, day: &str, n: i64) -> Result<()> {
    let stmt = db.prepare("UPDATE push_budget SET skipped = skipped + ?1 WHERE day = ?2");
    stmt.bind(&[JsValue::from(n as f64), JsValue::from_str(day)])?
        .run()
        .await?;
    Ok(())
}

pub async fn add_push_budget_throttled(db: &D1Database, day: &str, n: i64) -> Result<()> {
    let stmt = db.prepare("UPDATE push_budget SET throttled = throttled + ?1 WHERE day = ?2");
    stmt.bind(&[JsValue::from(n as f64), JsValue::from_str(day)])?
        .run()
        .await?;
    Ok(())
}

/// Reconcile the optimistic fan-out add: these endpoints were not posted, so
/// they move from `attempted` to `skipped`. `attempted` is floored at 0 —
/// over-counting is the safe direction, never let a reconcile underflow it.
pub async fn reconcile_push_budget_skip(db: &D1Database, day: &str, n: i64) -> Result<()> {
    let stmt = db.prepare(
        "UPDATE push_budget SET attempted = MAX(0, attempted - ?1), skipped = skipped + ?1 WHERE day = ?2",
    );
    stmt.bind(&[JsValue::from(n as f64), JsValue::from_str(day)])?
        .run()
        .await?;
    Ok(())
}

/// Raise `paused_until` to `paused_until` only if it is unset or currently
/// earlier (a second 429 must not shorten an existing pause).
pub async fn raise_push_budget_pause(db: &D1Database, day: &str, paused_until: i64) -> Result<()> {
    let stmt = db.prepare(
        "UPDATE push_budget SET paused_until = ?1
         WHERE day = ?2 AND (paused_until IS NULL OR paused_until < ?1)",
    );
    stmt.bind(&[JsValue::from(paused_until as f64), JsValue::from_str(day)])?
        .run()
        .await?;
    Ok(())
}

/// Delete budget rows older than the retention window. `cutoff_day` is a
/// "YYYY-MM-DD" string; lexicographic order is chronological order, so a plain
/// `<` comparison is correct.
pub async fn prune_old_push_budget(db: &D1Database, cutoff_day: &str) -> Result<()> {
    let stmt = db.prepare("DELETE FROM push_budget WHERE day < ?1");
    stmt.bind(&[JsValue::from_str(cutoff_day)])?.run().await?;
    Ok(())
}

/// Internal row type for D1 deserialization
#[derive(serde::Deserialize)]
struct MessageRow {
    id: String,
    topic: String,
    title: Option<String>,
    message: String,
    priority: u8,
    tags: Option<String>,
    click: Option<String>,
    image: Option<String>,
    markdown: i32,
    language: Option<String>,
    created_at: i64,
}

impl From<MessageRow> for Message {
    fn from(row: MessageRow) -> Self {
        Message {
            id: row.id,
            topic: row.topic,
            title: row.title,
            message: row.message,
            priority: row.priority,
            tags: row.tags,
            click: row.click,
            image: row.image,
            markdown: row.markdown != 0,
            // No persisted column; the client detects encryption by inspecting
            // the envelope shape of `message`.
            encrypted: false,
            language: row.language,
            created_at: row.created_at,
        }
    }
}

/// Internal row type for receipt deserialization (the public shape omits the
/// endpoint hash, which is never selected on the read path).
#[derive(serde::Deserialize)]
struct PushReceiptRow {
    message_id: String,
    topic: String,
    status: String,
    http_status: Option<i64>,
    created_at: i64,
}

impl From<PushReceiptRow> for PushReceipt {
    fn from(row: PushReceiptRow) -> Self {
        PushReceipt {
            message_id: row.message_id,
            topic: row.topic,
            status: row.status,
            http_status: row.http_status,
            created_at: row.created_at,
        }
    }
}
