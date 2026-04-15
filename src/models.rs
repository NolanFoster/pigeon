use serde::{Deserialize, Serialize};
use worker::{Error, Result};

pub fn validate_topic(topic: &str) -> Result<()> {
    if topic.is_empty() || topic.len() > 64 {
        return Err(Error::RustError("topic must be 1-64 chars".into()));
    }
    if !topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::RustError("invalid topic characters".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub message: String,
    pub priority: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub markdown: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscriptionRecord {
    pub id: Option<i64>,
    pub topic: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub created_at: i64,
}

/// The JSON body sent by the browser when subscribing to push
#[derive(Debug, Deserialize)]
pub struct PushSubscriptionRequest {
    pub endpoint: String,
    pub keys: PushKeys,
}

#[derive(Debug, Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

/// The JSON body sent when unsubscribing
#[derive(Debug, Deserialize)]
pub struct PushUnsubscribeRequest {
    pub endpoint: String,
}
