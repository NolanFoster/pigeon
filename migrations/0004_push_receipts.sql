-- #56 delivery proof. Two additive changes, no data migration:
--  1. messages.language — the optional BCP 47 tag named by X-Language.
--  2. push_receipts — one row per attempted endpoint, polled on the topic.
--     The endpoint is a capability credential: only its sha256 is stored, and
--     the read API never returns the hash either.

ALTER TABLE messages ADD COLUMN language TEXT;

CREATE TABLE push_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    -- sha256 of the endpoint, hex. Never the endpoint itself.
    endpoint_hash TEXT NOT NULL,
    status TEXT NOT NULL,          -- accepted | gone | throttled | too-large | rejected
    http_status INTEGER,           -- the push-service status, or NULL on a worker error
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_receipts_topic_created ON push_receipts(topic, created_at);
CREATE INDEX idx_push_receipts_message ON push_receipts(message_id);
