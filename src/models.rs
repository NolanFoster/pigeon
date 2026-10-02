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

/// Validate the optional `X-Language` header: a single BCP 47 tag, at most 35
/// characters, matching `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`. A publisher who
/// set it meant it, so anything else is rejected (400) rather than dropped.
pub fn valid_language_tag(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 35 {
        return false;
    }
    let mut parts = tag.split('-');
    let primary = parts.next().unwrap_or("");
    if !(2..=3).contains(&primary.len()) || !primary.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for sub in parts {
        if sub.is_empty() || sub.len() > 8 || !sub.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
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
    // The publisher's BCP 47 language for this message (X-Language). Carried on
    // the thin plaintext push payload; for E2EE it lives inside the ciphertext
    // and the server never sees it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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

/// One row of `GET /:topic/push/receipts`. Deliberately has no endpoint, no
/// endpoint_hash and no p256dh — the endpoint is a capability credential and
/// must not be echoed to whoever happens to know the topic.
#[derive(Debug, Clone, Serialize)]
pub struct PushReceipt {
    pub message_id: String,
    pub topic: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<i64>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tag_accepts_bcp47_and_rejects_empty_and_url() {
        assert!(valid_language_tag("en"));
        assert!(valid_language_tag("en-GB"));
        assert!(valid_language_tag("zh-Hant-TW"));
        assert!(valid_language_tag("pt-BR"));
        // Empty tag.
        assert!(!valid_language_tag(""));
        // A URL is not a language tag.
        assert!(!valid_language_tag("https://example.com"));
        // A phrase with a space.
        assert!(!valid_language_tag("not a tag"));
        // Too short / too long primary.
        assert!(!valid_language_tag("e"));
        assert!(!valid_language_tag("abcd"));
        // Digits are not a primary subtag.
        assert!(!valid_language_tag("1234"));
        // 36 characters.
        assert!(!valid_language_tag(&"a".repeat(36)));
        // Trailing dash produces an empty subtag.
        assert!(!valid_language_tag("en-"));
        // Subtags are capped at 8 alphanumeric chars.
        assert!(!valid_language_tag("en-abcdefghi"));
        assert!(valid_language_tag("en-abcdefgh"));
    }
}
