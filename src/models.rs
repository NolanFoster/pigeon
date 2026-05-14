use serde::{Deserialize, Serialize};
use worker::{Error, Result, Url};

pub fn validate_topic(topic: &str) -> Result<()> {
    if topic.is_empty() || topic.len() > 64 {
        return Err(Error::RustError("topic must be 1-64 chars".into()));
    }
    if !topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::RustError("invalid topic characters".into()));
    }
    Ok(())
}

/// Hosts whose suffixes we trust to be real Web Push services. Anything else
/// would let `/topic/push/subscribe` turn the worker into a generic HTTP-POST
/// amplifier (an attacker registers an arbitrary URL, then every published
/// message triggers a signed POST to it).
const PUSH_HOST_SUFFIXES: &[&str] = &[
    "fcm.googleapis.com",
    "android.googleapis.com",
    ".push.services.mozilla.com",
    "updates.push.services.mozilla.com",
    ".notify.windows.com",
    ".push.apple.com",
    "web.push.apple.com",
    "api.push.apple.com",
];

pub fn validate_push_endpoint(endpoint: &str) -> Result<()> {
    if endpoint.is_empty() || endpoint.len() > 512 {
        return Err(Error::RustError("push endpoint must be 1-512 chars".into()));
    }
    let url = Url::parse(endpoint)
        .map_err(|_| Error::RustError("push endpoint is not a valid URL".into()))?;
    if url.scheme() != "https" {
        return Err(Error::RustError("push endpoint must be https".into()));
    }
    let host = match url.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return Err(Error::RustError("push endpoint has no host".into())),
    };
    let allowed = PUSH_HOST_SUFFIXES.iter().any(|s| {
        if let Some(stripped) = s.strip_prefix('.') {
            // Suffix match — allow any subdomain.
            host.ends_with(stripped) && host.len() > stripped.len() && host[..host.len() - stripped.len()].ends_with('.')
        } else {
            // Exact host match.
            host == *s
        }
    });
    if !allowed {
        return Err(Error::RustError(
            "push endpoint host is not a recognized push service".into(),
        ));
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
    // True when `message` holds an opaque client-side ciphertext envelope and
    // none of the content headers (title/tags/click/image) were honoured.
    #[serde(default, skip_serializing_if = "is_false")]
    pub encrypted: bool,
    pub created_at: i64,
}

fn is_false(b: &bool) -> bool { !*b }

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
