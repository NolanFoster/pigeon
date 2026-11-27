-- #62 per-network Web Push slot cap. Additive, no data migration:
--  push_subscriptions.prefix_hash — hex sha256 of the client's network prefix
--  (IPv6 /64, or the full IPv4 address) taken from CF-Connecting-IP at
--  subscribe time. The raw address is never stored; only this hash is, the
--  same rule as endpoint_hash on receipts. Existing rows are NULL and are
--  grandfathered: they count toward the topic cap of 1000 and toward no
--  prefix. The index serves the per-topic, per-prefix count used to enforce
--  the cap of 8 subscriptions per network per topic.

ALTER TABLE push_subscriptions ADD COLUMN prefix_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_push_subs_topic_prefix
    ON push_subscriptions(topic, prefix_hash);
