use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::models::{Message, PushSubscriptionRecord};

pub async fn insert_message(db: &D1Database, msg: &Message) -> Result<()> {
    let stmt = db.prepare(
        "INSERT INTO messages (id, topic, title, message, priority, tags, click, markdown, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    );
    stmt.bind(&[
        JsValue::from_str(&msg.id),
        JsValue::from_str(&msg.topic),
        msg.title.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from_str(&msg.message),
        JsValue::from(msg.priority as f64),
        msg.tags.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        msg.click.as_deref().map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from(if msg.markdown { 1.0 } else { 0.0 }),
        JsValue::from(msg.created_at as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn get_messages_since(
    db: &D1Database,
    topic: &str,
    since: i64,
) -> Result<Vec<Message>> {
    let stmt = db.prepare(
        "SELECT id, topic, title, message, priority, tags, click, markdown, created_at
         FROM messages WHERE topic = ?1 AND created_at > ?2 ORDER BY created_at ASC",
    );
    let result = stmt
        .bind(&[JsValue::from_str(topic), JsValue::from(since as f64)])?
        .all()
        .await?;

    let rows: Vec<MessageRow> = result.results()?;
    Ok(rows.into_iter().map(|r| r.into()).collect())
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
            markdown: row.markdown != 0,
            created_at: row.created_at,
        }
    }
}
