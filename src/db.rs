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

pub async fn insert_push_subscription(
    db: &D1Database,
    topic: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    created_at: i64,
) -> Result<()> {
    let stmt = db.prepare(
        "INSERT OR REPLACE INTO push_subscriptions (topic, endpoint, p256dh, auth, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    );
    stmt.bind(&[
        JsValue::from_str(topic),
        JsValue::from_str(endpoint),
        JsValue::from_str(p256dh),
        JsValue::from_str(auth),
        JsValue::from(created_at as f64),
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
