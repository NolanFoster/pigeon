-- #61 origin budget. Chrome scores a Web Push origin once a day on messages
-- sent per time-on-site, and a bad day can stick for up to 14 days. Pigeon is
-- one Worker = one origin, so the counter is origin-wide, never per topic or
-- per endpoint. One row per UTC day, upserted; rows older than 14 days are
-- deleted opportunistically at the start of a publish (same pattern as receipt
-- prune — no cron, no Queue).
CREATE TABLE push_budget (
    day TEXT PRIMARY KEY,            -- UTC date, YYYY-MM-DD
    attempted INTEGER NOT NULL,      -- Web Push requests we actually issued
    skipped INTEGER NOT NULL,        -- subscriptions we deliberately did not post
    throttled INTEGER NOT NULL,      -- requests a push service answered 429
    paused_until INTEGER,            -- unix seconds; NULL when not paused
    burst TEXT                       -- JSON {head, buckets:[60 ints]} one-second ring
);
