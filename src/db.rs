use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::models::{Message, PushSubscriptionRecord};

// Replay bound (ntfy 2.28 parity): never return an unbounded topic. The SQL
// below asks for one extra row (LIMIT 501) so callers can detect truncation
// without a second round-trip.
const REPLAY_MAX: usize = 500;

pub async fn insert_message(db: &D1Database, msg: &Message) -> Result<()> {
    let stmt = db.prepare(
        "INSERT INTO messages (id, topic, title, message, priority, tags, click, image, markdown, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            "SELECT id, topic, title, message, priority, tags, click, image, markdown, created_at
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
            "SELECT id, topic, title, message, priority, tags, click, image, markdown, created_at
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
        "SELECT id, topic, title, message, priority, tags, click, image, markdown, created_at
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
            created_at: row.created_at,
        }
    }
}
