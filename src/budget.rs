//! Origin budget (#61).
//!
//! Chrome scores a Web Push origin once a day on messages-sent per
//! time-on-site; a day classified disruptive gets 429s that escalate (1 → 7 →
//! 14 days). Pigeon is one Cloudflare Worker — one origin, every topic — so the
//! counter here is origin-wide, never per topic or per endpoint.
//!
//! The budget is fan-out only: D1 inserts and WebSocket broadcasts are never
//! counted, because Chrome cannot see them and counting them would make a busy
//! topic with no subscribers look like spam. One D1 row per UTC day (not per
//! publish), upserted.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::db;

/// Warn (never block) once a UTC day has this many attempts.
pub const DAILY_ATTEMPTS_WARN: i64 = 1_000;
/// The burst ring covers this many one-second buckets.
pub const BURST_WINDOW_SECS: usize = 60;
/// Warn (never block) once this many attempts land in any 60 seconds.
pub const BURST_ATTEMPTS_WARN: i64 = 60;
/// How long a push-service 429 pauses the origin.
pub const PAUSE_SECS: i64 = 60;
/// Budget rows older than this many days are pruned opportunistically.
pub const BUDGET_RETENTION_DAYS: i64 = 14;

/// The state a publish response / `GET /push/budget` reports.
pub struct BudgetSnapshot {
    pub day: String,
    pub attempted: i64,
    pub skipped: i64,
    pub throttled: i64,
    pub paused_until: Option<i64>,
    pub warn: Option<&'static str>,
}

/// UTC `"YYYY-MM-DD"` for a unix-seconds timestamp. Chrome's daily score is
/// UTC, not the publisher's timezone, so the counter must not reset at a local
/// midnight.
pub fn utc_day(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar. Howard Hinnant's `civil_from_days`; pure integer arithmetic so it
/// is deterministic and unit-testable without a JS date formatter.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The last 60 one-second attempt buckets, stored as JSON on the budget row.
/// `buckets[i]` counts attempts in the second whose `unix % 60 == i`. `head` is
/// the unix second of the most recent write; seconds that elapsed with no
/// writes are cleared on the next `record`, so the ring always covers exactly
/// the trailing 60 seconds — including across multi-minute gaps.
#[derive(Debug, Clone, PartialEq)]
pub struct Burst {
    head: i64,
    buckets: [i64; BURST_WINDOW_SECS],
}

impl Default for Burst {
    fn default() -> Self {
        Burst {
            head: 0,
            buckets: [0; BURST_WINDOW_SECS],
        }
    }
}

#[derive(Serialize, Deserialize)]
struct BurstWire {
    head: i64,
    #[serde(default)]
    buckets: Vec<i64>,
}

impl Burst {
    fn idx(unix_secs: i64) -> usize {
        unix_secs.rem_euclid(BURST_WINDOW_SECS as i64) as usize
    }

    /// Record `n` attempts at unix second `now`.
    pub fn record(&mut self, now: i64, n: i64) {
        let gap = now.saturating_sub(self.head);
        if gap >= BURST_WINDOW_SECS as i64 {
            // Every bucket is older than the window — start fresh.
            self.buckets = [0; BURST_WINDOW_SECS];
        } else {
            // Clear the buckets for the seconds that elapsed with no writes
            // (their values are now older than the window).
            for t in (self.head + 1)..=now {
                self.buckets[Self::idx(t)] = 0;
            }
        }
        self.head = now;
        self.buckets[Self::idx(now)] += n;
    }

    pub fn sum(&self) -> i64 {
        self.buckets.iter().sum()
    }

    pub fn to_json(&self) -> String {
        let wire = BurstWire {
            head: self.head,
            buckets: self.buckets.to_vec(),
        };
        serde_json::to_string(&wire)
            .unwrap_or_else(|_| "{\"head\":0,\"buckets\":[]}".to_string())
    }

    pub fn from_json(s: Option<&str>) -> Burst {
        match s.and_then(|j| serde_json::from_str::<BurstWire>(j).ok()) {
            Some(w) => {
                let mut buckets = [0i64; BURST_WINDOW_SECS];
                for (i, v) in w.buckets.iter().take(BURST_WINDOW_SECS).enumerate() {
                    buckets[i] = *v;
                }
                Burst {
                    head: w.head,
                    buckets,
                }
            }
            None => Burst::default(),
        }
    }
}

/// The warn word for the current counters, or None. Both lines are ours, not
/// Chrome's — Chrome has not published the classification threshold, so a warn
/// never changes the status code. `daily` takes precedence over `burst`.
pub fn warn_level(attempted: i64, burst_sum: i64) -> Option<&'static str> {
    if attempted >= DAILY_ATTEMPTS_WARN {
        Some("daily")
    } else if burst_sum >= BURST_ATTEMPTS_WARN {
        Some("burst")
    } else {
        None
    }
}

fn snapshot_from_row(row: Option<db::PushBudgetRow>, day: String) -> BudgetSnapshot {
    match row {
        Some(r) => {
            let burst = Burst::from_json(r.burst.as_deref());
            BudgetSnapshot {
                day,
                attempted: r.attempted,
                skipped: r.skipped,
                throttled: r.throttled,
                paused_until: r.paused_until,
                warn: warn_level(r.attempted, burst.sum()),
            }
        }
        None => BudgetSnapshot {
            day,
            attempted: 0,
            skipped: 0,
            throttled: 0,
            paused_until: None,
            warn: None,
        },
    }
}

/// Read today's budget without mutating it (`GET /push/budget`). A missing row
/// means an untouched day: all zeros.
pub async fn read_budget(db: &D1Database, now: i64) -> Result<BudgetSnapshot> {
    let day = utc_day(now);
    let row = db::get_push_budget(db, &day).await?;
    Ok(snapshot_from_row(row, day))
}

/// True when `paused_until` is set and still in the future.
pub async fn is_paused(db: &D1Database, now: i64) -> Result<bool> {
    let day = utc_day(now);
    match db::get_push_budget(db, &day).await? {
        Some(row) => Ok(row.paused_until.map_or(false, |p| p > now)),
        None => Ok(false),
    }
}

/// The publish-time budget write. Prunes rows older than the retention window,
/// ensures today's row, adds `scheduled` to `attempted` (the optimistic add),
/// records `scheduled` attempts into the burst ring, and adds `skipped_now` to
/// `skipped`. Returns the state the response headers read from.
///
/// The fan-out that actually performs the deliveries runs later in
/// `wait_until`; it reconciles downward (decrement `attempted`, increment
/// `skipped`) for each endpoint it deliberately does not post. A crash between
/// the response and the fan-out over-counts by one publish — the safe
/// direction, because under-counting is how an origin sleepwalks into a
/// 14-day penalty.
pub async fn apply_schedule(
    db: &D1Database,
    now: i64,
    scheduled: i64,
    skipped_now: i64,
) -> Result<BudgetSnapshot> {
    let day = utc_day(now);
    let cutoff = utc_day(now - BUDGET_RETENTION_DAYS * 86_400);
    if let Err(e) = db::prune_old_push_budget(db, &cutoff).await {
        console_log!("Push budget retention failed: {:?}", e);
    }
    db::ensure_push_budget(db, &day).await?;

    let row = db::get_push_budget(db, &day).await?;
    let (attempted_before, skipped_before, throttled, paused_until, burst_raw) = match &row {
        Some(r) => (
            r.attempted,
            r.skipped,
            r.throttled,
            r.paused_until,
            r.burst.clone(),
        ),
        None => (0, 0, 0, None, None),
    };

    let mut burst = Burst::from_json(burst_raw.as_deref());
    burst.record(now, scheduled);
    let new_attempted = attempted_before + scheduled;
    let warn = warn_level(new_attempted, burst.sum());

    db::set_push_budget_attempted_and_burst(db, &day, new_attempted, &burst.to_json()).await?;
    if skipped_now > 0 {
        db::add_push_budget_skipped(db, &day, skipped_now).await?;
    }

    Ok(BudgetSnapshot {
        day,
        attempted: new_attempted,
        skipped: skipped_before + skipped_now,
        throttled,
        paused_until,
        warn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_day_is_stable_and_rolls_at_utc_midnight() {
        // 2026-10-11T00:00:00Z.
        assert_eq!(utc_day(1_791_676_800), "2026-10-11");
        // One second earlier is still 2026-10-10.
        assert_eq!(utc_day(1_791_676_799), "2026-10-10");
        // Unix epoch.
        assert_eq!(utc_day(0), "1970-01-01");
        // A known modern timestamp: 2024-03-01T12:00:00Z.
        assert_eq!(utc_day(1_709_294_400), "2024-03-01");
        // Pre-epoch (negative) does not panic.
        assert_eq!(utc_day(-86_400), "1969-12-31");
    }

    #[test]
    fn burst_records_and_sums_within_one_second() {
        let mut b = Burst::default();
        b.record(1000, 30);
        assert_eq!(b.sum(), 30);
        b.record(1000, 30); // same second accumulates
        assert_eq!(b.sum(), 60);
        assert_eq!(warn_level(0, b.sum()), Some("burst"));
        b.record(1000, 1);
        assert_eq!(b.sum(), 61);
    }

    #[test]
    fn burst_rolls_off_after_sixty_seconds() {
        let mut b = Burst::default();
        b.record(0, 60);
        assert_eq!(b.sum(), 60);
        // 60 seconds later the whole window has aged out.
        b.record(60, 1);
        assert_eq!(b.sum(), 1);
        // 59 seconds later the 60 attempts are still in window: the second-0
        // bucket is the only one that has aged out.
        let mut c = Burst::default();
        c.record(0, 60);
        c.record(59, 0);
        assert_eq!(c.sum(), 60);
    }

    #[test]
    fn burst_clears_stale_buckets_across_a_gap() {
        let mut b = Burst::default();
        b.record(0, 30);
        // A 10-second gap with no writes.
        b.record(10, 5);
        // The 30 from second 0 is still in the 60-second window.
        assert_eq!(b.sum(), 35);
        // After the full window passes, everything is gone.
        b.record(70, 2);
        assert_eq!(b.sum(), 2);
    }

    #[test]
    fn burst_json_roundtrips_and_defaults_on_garbage() {
        let mut b = Burst::default();
        b.record(42, 7);
        let json = b.to_json();
        let parsed = Burst::from_json(Some(json.as_str()));
        assert_eq!(parsed, b);

        assert_eq!(Burst::from_json(None), Burst::default());
        assert_eq!(Burst::from_json(Some("not json")), Burst::default());
        assert_eq!(Burst::from_json(Some("{}")), Burst::default());
    }

    #[test]
    fn warn_level_prefers_daily_over_burst() {
        assert_eq!(warn_level(0, 0), None);
        assert_eq!(warn_level(999, 60), Some("burst"));
        assert_eq!(warn_level(1_000, 0), Some("daily"));
        assert_eq!(warn_level(1_000, 60), Some("daily"));
    }
}
