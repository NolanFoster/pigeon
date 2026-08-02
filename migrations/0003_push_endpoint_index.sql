-- Disabling push deletes an endpoint from every topic at once. The existing
-- UNIQUE(topic, endpoint) index can't serve a lookup keyed on endpoint alone,
-- so that delete would scan the table.
CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);
