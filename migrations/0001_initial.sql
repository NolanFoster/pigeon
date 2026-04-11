CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    title TEXT,
    message TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 3,
    tags TEXT,
    click TEXT,
    markdown INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_topic_created ON messages(topic, created_at);

CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(topic, endpoint)
);

CREATE INDEX idx_push_subs_topic ON push_subscriptions(topic);
