//! Wall-clock scheduled delivery (#60).
//!
//! `X-At` holds a message until a wall-clock instant. Two forms are accepted
//! and no others:
//!
//! - RFC 3339 with a `Z` or a numeric offset (`2026-12-10T11:00:00-05:00`).
//!   The offset inside the timestamp *is* the timezone; `X-Timezone` must not
//!   also be set.
//! - A phrase (`tomorrow, 10am`, `tomorrow 10:00`, `today, 9pm`), only when
//!   `X-Timezone` carries an IANA name. "Today"/"tomorrow" are evaluated in
//!   that timezone, never in UTC, and never by guessing an offset.
//!
//! Timezone resolution is deliberately a *pure function over an injected
//! offset resolver* (`OffsetFn`) so the parser and the DST gap/overlap rules
//! are unit-testable on the host. The production resolver (`intl_offset`)
//! shells out to `Intl.DateTimeFormat`; it never runs in `cargo test`.

use worker::*;

/// Seconds of slack below which a timestamp is treated as a normal publish,
/// not a schedule: an alarm cannot fire that soon anyway, and telling the
/// publisher "omit the header" is more honest than accepting a 1-second delay.
const MIN_FORWARD_SECONDS: i64 = 5;
/// Same 7-day cap as #39's `X-Delay`. A Worker is not a calendar.
const MAX_FORWARD_SECONDS: i64 = 7 * 24 * 3600;
/// Pending-row ceiling per topic (#60 §4). The 51st schedule is a 429.
pub const MAX_PENDING: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleError {
    /// X-At value was not one of the accepted forms.
    InvalidAt,
    /// A phrase was given with no IANA timezone.
    MissingTimezone,
    /// X-Timezone was set on an RFC 3339 value that already carries an offset.
    TimezoneOnOffset,
    /// X-Timezone is not an IANA name.
    InvalidTimezone,
    /// The instant is in the past, or less than 5 seconds away.
    InThePast,
    /// More than 7 days out.
    TooFarAhead,
    /// The phrase lands in the hour that does not exist (spring forward).
    DstGap,
}

impl ScheduleError {
    pub fn message(&self) -> &'static str {
        match self {
            ScheduleError::InvalidAt => "at invalid",
            ScheduleError::MissingTimezone => "timezone required",
            ScheduleError::TimezoneOnOffset => "timezone on offset timestamp",
            ScheduleError::InvalidTimezone => "timezone invalid",
            ScheduleError::InThePast => "at in the past",
            ScheduleError::TooFarAhead => "at too far ahead",
            ScheduleError::DstGap => "at in dst gap",
        }
    }
}

impl From<ScheduleError> for Error {
    fn from(e: ScheduleError) -> Self {
        Error::RustError(e.message().into())
    }
}

/// The resolved outcome of an `X-At` header.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// Unix milliseconds at which the message must be delivered.
    pub deliver_at_ms: i64,
    /// The IANA name, kept only when the publisher used a phrase (so a later
    /// `GET /:topic/scheduled` can show what we interpreted).
    pub timezone: Option<String>,
    /// `Some("earlier")` when the phrase lands in a DST overlap (the hour that
    /// happens twice) and the earlier offset was chosen.
    pub dst: Option<&'static str>,
}

/// Resolve the UTC offset (seconds east of UTC) in effect at `instant_ms` for
/// the IANA zone `tz`. Returns `InvalidTimezone` for an unknown name.
pub type OffsetFn<'a> = &'a dyn Fn(i64, &str) -> Result<i32, ScheduleError>;

// ---------------------------------------------------------------------------
// Pure civil<->unix date math (Howard Hinnant's days-from-civil), all UTC.
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn unix_ms_from_civil_utc(y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> i64 {
    days_from_civil(y, mo, d) * 86_400_000
        + h as i64 * 3_600_000
        + mi as i64 * 60_000
        + s as i64 * 1000
        + ms as i64
}

fn civil_from_unix_ms_utc(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let h = (rem / 3_600_000) as u32;
    let mi = ((rem % 3_600_000) / 60_000) as u32;
    let s = ((rem % 60_000) / 1000) as u32;
    (y, mo, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// RFC 3339 parsing (Z or ±HH:MM; fractional seconds truncated to ms).
// ---------------------------------------------------------------------------

fn parse_rfc3339(s: &str) -> Result<(i64, bool), ScheduleError> {
    // bool = true when the value carried an explicit Z/numeric offset.
    let (date, time) = s.split_once(['T', 't']).ok_or(ScheduleError::InvalidAt)?;

    let mut dp = date.split('-');
    let y: i64 = dp.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    let mo: u32 = dp.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    let d: u32 = dp.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    if dp.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return Err(ScheduleError::InvalidAt);
    }

    let (hh, mi, s, ms) = parse_time_of_day(time)?;

    let civil_ms = unix_ms_from_civil_utc(y, mo, d, hh, mi, s, ms);

    if time.ends_with('Z') || time.ends_with('z') {
        return Ok((civil_ms, true));
    }
    let sign_idx = match time.find(['+', '-']) {
        Some(i) => i,
        None => return Ok((civil_ms, false)), // no offset: caller rejects
    };
    let sign: i64 = if time.as_bytes()[sign_idx] == b'-' { -1 } else { 1 };
    let off = &time[sign_idx + 1..];
    let (oh, om) = off.split_once(':').ok_or(ScheduleError::InvalidAt)?;
    let oh: i64 = oh.parse().map_err(|_| ScheduleError::InvalidAt)?;
    let om: i64 = om.parse().map_err(|_| ScheduleError::InvalidAt)?;
    if oh > 23 || om > 59 {
        return Err(ScheduleError::InvalidAt);
    }
    let offset_ms = sign * (oh * 3600 + om * 60) * 1000;
    Ok((civil_ms - offset_ms, true))
}

/// Parse the `HH:MM:SS[.fff]` part (plus an optional trailing offset/Z that
/// callers strip). Returns hour, minute, second, milliseconds.
fn parse_time_of_day(time: &str) -> Result<(u32, u32, u32, u32), ScheduleError> {
    let body = if let Some(i) = time.find(['+', '-', 'Z', 'z']) {
        &time[..i]
    } else {
        time
    };
    let (hms, frac) = match body.split_once('.') {
        Some((h, f)) => (h, f),
        None => (body, ""),
    };
    let mut parts = hms.split(':');
    let hh: u32 = parts.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    let mi: u32 = parts.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    let s: u32 = parts.next().and_then(|v| v.parse().ok()).ok_or(ScheduleError::InvalidAt)?;
    if parts.next().is_some() || hh > 23 || mi > 59 || s > 59 {
        return Err(ScheduleError::InvalidAt);
    }
    let ms: u32 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().take(3).collect();
        let mut v = 0u32;
        for c in digits.chars() {
            v = v * 10 + c.to_digit(10).ok_or(ScheduleError::InvalidAt)?;
        }
        v * 10u32.pow(3 - digits.len() as u32)
    };
    Ok((hh, mi, s, ms))
}

fn looks_like_rfc3339(s: &str) -> bool {
    // RFC 3339 always begins with a four-digit year. Phrases begin with
    // "today"/"tomorrow" (which contain 't'), so presence of 't' is not a
    // reliable discriminator.
    let t = s.trim_start();
    t.len() >= 4 && t.as_bytes()[..4].iter().all(|b| b.is_ascii_digit())
}

// ---------------------------------------------------------------------------
// Phrase parsing: `today, 9pm`, `tomorrow, 10am`, `tomorrow 10:00`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DayKind {
    Today,
    Tomorrow,
}

fn parse_phrase(s: &str) -> Result<(DayKind, u32, u32), ScheduleError> {
    let lower = s.trim().to_ascii_lowercase();
    let (day, rest) = if let Some(r) = lower.strip_prefix("tomorrow") {
        (DayKind::Tomorrow, r)
    } else if let Some(r) = lower.strip_prefix("today") {
        (DayKind::Today, r)
    } else {
        return Err(ScheduleError::InvalidAt);
    };
    let rest = rest.trim_start_matches([',', ' ']).trim();
    let (h, m) = parse_clock(rest)?;
    Ok((day, h, m))
}

/// Parse a clock time: `10am`, `9pm`, `10:00`, `21:30`. A bare `10` with no
/// meridian is ambiguous and rejected.
fn parse_clock(s: &str) -> Result<(u32, u32), ScheduleError> {
    let lower = s.to_ascii_lowercase();
    if let Some(body) = lower.strip_suffix("am").or_else(|| lower.strip_suffix("pm")) {
        let hour: u32 = body.trim().parse().map_err(|_| ScheduleError::InvalidAt)?;
        if !(1..=12).contains(&hour) {
            return Err(ScheduleError::InvalidAt);
        }
        let h = if lower.ends_with("am") {
            if hour == 12 { 0 } else { hour }
        } else if hour == 12 {
            12
        } else {
            hour + 12
        };
        return Ok((h, 0));
    }
    let (hh, mm) = s.split_once(':').ok_or(ScheduleError::InvalidAt)?;
    let h: u32 = hh.parse().map_err(|_| ScheduleError::InvalidAt)?;
    let m: u32 = mm.parse().map_err(|_| ScheduleError::InvalidAt)?;
    if h > 23 || m > 59 {
        return Err(ScheduleError::InvalidAt);
    }
    Ok((h, m))
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// The calendar date in `tz` at `now_ms`, as a UTC "wall clock" civil value.
fn civil_date_in_tz(
    now_ms: i64,
    tz: &str,
    offset_fn: OffsetFn,
) -> Result<(i64, u32, u32), ScheduleError> {
    let off_ms = offset_fn(now_ms, tz)? as i64 * 1000;
    let (y, mo, d, _, _, _) = civil_from_unix_ms_utc(now_ms + off_ms);
    Ok((y, mo, d))
}

/// Turn a civil wall-clock time (expressed as if it were a UTC epoch) in `tz`
/// into a real instant. Detects DST gaps (error) and overlaps (earlier offset,
/// `dst: "earlier"`).
fn civil_to_instant(
    civil_ms: i64,
    tz: &str,
    offset_fn: OffsetFn,
) -> Result<(i64, Option<&'static str>), ScheduleError> {
    // Fixed point: instant = civil - offset(instant). Converges for valid
    // times; oscillates (never equal) across a gap.
    let mut t = civil_ms;
    for _ in 0..8 {
        let off_ms = offset_fn(t, tz)? as i64 * 1000;
        let guess = civil_ms - off_ms;
        if guess == t {
            break;
        }
        t = guess;
    }

    let off_ms = offset_fn(t, tz)? as i64 * 1000;
    if t + off_ms != civil_ms {
        // No instant shows this wall clock: the hour was skipped.
        return Err(ScheduleError::DstGap);
    }

    // Overlap: the hour happens twice. Look one hour later; if the offset
    // changed and that later instant also shows the same wall clock, the
    // earlier occurrence (larger offset) is the one we report.
    let later = t + 3_600_000;
    let later_off_ms = offset_fn(later, tz)? as i64 * 1000;
    if later_off_ms != off_ms {
        let t2 = civil_ms - later_off_ms;
        if t2 != t && t2 + later_off_ms == civil_ms && off_ms > later_off_ms {
            return Ok((t, Some("earlier")));
        }
    }

    Ok((t, None))
}

/// Resolve an `X-At` value (and optional `X-Timezone`) into a delivery instant.
pub fn resolve(
    at: &str,
    timezone: Option<&str>,
    now_ms: i64,
    offset_fn: OffsetFn,
) -> Result<Resolution, ScheduleError> {
    let at = at.trim();
    if at.is_empty() {
        return Err(ScheduleError::InvalidAt);
    }

    let (deliver_at_ms, timezone_used, dst) = if looks_like_rfc3339(at) {
        let (ms, has_offset) = parse_rfc3339(at)?;
        if !has_offset {
            return Err(ScheduleError::MissingTimezone);
        }
        if let Some(tz) = timezone {
            if !tz.trim().is_empty() {
                return Err(ScheduleError::TimezoneOnOffset);
            }
        }
        (ms, None, None)
    } else {
        let (day, h, m) = parse_phrase(at)?;
        let tz = timezone
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .ok_or(ScheduleError::MissingTimezone)?;
        // Validate the name up front via the resolver (intl_offset checks
        // Intl.supportedValuesOf("timeZone"); test resolvers check their own
        // table). This also forces the offset query that may fail on an
        // unknown name.
        offset_fn(now_ms, tz)?;
        let (y0, mo0, d0) = civil_date_in_tz(now_ms, tz, offset_fn)?;
        let (y, mo, d) = if day == DayKind::Tomorrow {
            civil_from_days(days_from_civil(y0, mo0, d0) + 1)
        } else {
            (y0, mo0, d0)
        };
        let civil_ms = unix_ms_from_civil_utc(y, mo, d, h, m, 0, 0);
        let (instant, dst) = civil_to_instant(civil_ms, tz, offset_fn)?;
        (instant, Some(tz.to_string()), dst)
    };

    if deliver_at_ms < now_ms + MIN_FORWARD_SECONDS * 1000 {
        return Err(ScheduleError::InThePast);
    }
    if deliver_at_ms > now_ms + MAX_FORWARD_SECONDS * 1000 {
        return Err(ScheduleError::TooFarAhead);
    }

    Ok(Resolution {
        deliver_at_ms,
        timezone: timezone_used,
        dst,
    })
}

// ---------------------------------------------------------------------------
// Production offset resolver over `Intl.DateTimeFormat`.
// ---------------------------------------------------------------------------

/// Validate a timezone name against the runtime's IANA database and return the
/// offset in effect at `instant_ms` for it. Never reads a forwarded header.
pub fn intl_offset(instant_ms: i64, tz: &str) -> Result<i32, ScheduleError> {
    use js_sys::Intl;
    use worker::wasm_bindgen::JsCast;

    if tz.is_empty() {
        return Err(ScheduleError::InvalidTimezone);
    }
    let supported = Intl::supported_values_of(Intl::SupportedValuesKey::TimeZone);
    let needle = js_sys::JsString::from(tz);
    if supported.index_of(&needle, 0) < 0 {
        return Err(ScheduleError::InvalidTimezone);
    }

    let options = Intl::DateTimeFormatOptions::new();
    options.set_time_zone(tz);
    options.set_time_zone_name(Intl::TimeZoneNameFormat::LongOffset);

    let locales = js_sys::Array::new();
    let fmt = Intl::DateTimeFormat::new(&locales, options.as_ref());
    let date = js_sys::Date::new(&worker::wasm_bindgen::JsValue::from_f64(instant_ms as f64));
    let parts = fmt.format_to_parts(&date);

    for i in 0..parts.length() {
        let part: Intl::DateTimeFormatPart = parts
            .get(i)
            .dyn_into()
            .map_err(|_| ScheduleError::InvalidTimezone)?;
        if part.type_() == Intl::DateTimeFormatPartType::TimeZoneName {
            return parse_gmt_offset(&String::from(part.value()));
        }
    }
    Err(ScheduleError::InvalidTimezone)
}

/// Parse "GMT+09:00" / "GMT-04:30" / "GMT" into offset seconds.
fn parse_gmt_offset(s: &str) -> Result<i32, ScheduleError> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("GMT") || s.eq_ignore_ascii_case("UTC") {
        return Ok(0);
    }
    let body = s
        .trim_start_matches("GMT")
        .trim_start_matches("UTC")
        .trim_start_matches("UT");
    let (sign, rest) = if let Some(r) = body.strip_prefix('+') {
        (1i32, r)
    } else if let Some(r) = body.strip_prefix('-') {
        (-1i32, r)
    } else {
        return Err(ScheduleError::InvalidTimezone);
    };
    let (h, m): (i32, i32) = if let Some((hh, mm)) = rest.split_once(':') {
        (
            hh.parse().map_err(|_| ScheduleError::InvalidTimezone)?,
            mm.parse().map_err(|_| ScheduleError::InvalidTimezone)?,
        )
    } else {
        (rest.parse().map_err(|_| ScheduleError::InvalidTimezone)?, 0)
    };
    Ok(sign * (h * 3600 + m * 60))
}

/// The Durable Object id name for a topic's scheduler. One DO instance per
/// topic, on the already-migrated `TopicRoom` class, under its own namespace —
/// separate storage and alarm from the live WebSocket room.
pub fn scheduler_id_name(topic: &str) -> String {
    format!("scheduled:topic:{}", topic)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offset_table(instant_ms: i64, tz: &str) -> Result<i32, ScheduleError> {
        match tz {
            "Asia/Tokyo" => Ok(9 * 3600),
            "America/New_York" => Ok(-5 * 3600),
            "Test/Spring" => {
                // Offset -5 before 07:00Z, -4 after (02:00 wall skipped).
                let t = unix_ms_from_civil_utc(2026, 3, 8, 7, 0, 0, 0);
                if instant_ms < t { Ok(-5 * 3600) } else { Ok(-4 * 3600) }
            }
            "Test/Fall" => {
                // Offset -4 before 06:00Z, -5 after (02:00 wall repeats).
                let t = unix_ms_from_civil_utc(2026, 11, 1, 6, 0, 0, 0);
                if instant_ms < t { Ok(-4 * 3600) } else { Ok(-5 * 3600) }
            }
            _ => Err(ScheduleError::InvalidTimezone),
        }
    }

    fn resolve_at(at: &str, tz: Option<&str>, now_ms: i64) -> Result<Resolution, ScheduleError> {
        resolve(at, tz, now_ms, &offset_table)
    }

    #[test]
    fn rfc3339_z_and_offset_map_to_unix_ms() {
        let now = unix_ms_from_civil_utc(2026, 12, 1, 0, 0, 0, 0);
        let r = resolve_at("2026-12-02T10:00:00Z", None, now).unwrap();
        assert_eq!(r.deliver_at_ms, unix_ms_from_civil_utc(2026, 12, 2, 10, 0, 0, 0));
        let r = resolve_at("2026-12-03T11:00:00-05:00", None, now).unwrap();
        assert_eq!(r.deliver_at_ms, unix_ms_from_civil_utc(2026, 12, 3, 16, 0, 0, 0));
        assert!(r.timezone.is_none());
    }

    #[test]
    fn rfc3339_without_offset_is_rejected() {
        assert_eq!(
            resolve_at("2026-12-10T11:00:00", None, 0).unwrap_err(),
            ScheduleError::MissingTimezone
        );
    }

    #[test]
    fn timezone_on_offset_timestamp_is_rejected() {
        assert_eq!(
            resolve_at("2026-12-10T11:00:00-05:00", Some("Asia/Tokyo"), 0).unwrap_err(),
            ScheduleError::TimezoneOnOffset
        );
    }

    #[test]
    fn phrase_without_timezone_is_rejected() {
        assert_eq!(
            resolve_at("tomorrow, 10am", None, 0).unwrap_err(),
            ScheduleError::MissingTimezone
        );
    }

    #[test]
    fn past_and_too_far_are_rejected() {
        let now = unix_ms_from_civil_utc(2026, 11, 1, 0, 0, 0, 0);
        assert_eq!(
            resolve_at("2026-10-01T00:00:00Z", None, now).unwrap_err(),
            ScheduleError::InThePast
        );
        assert_eq!(
            resolve_at("2026-12-01T00:00:00Z", None, now).unwrap_err(),
            ScheduleError::TooFarAhead
        );
    }

    #[test]
    fn phrase_timezones_disagree() {
        // Noon UTC: both Tokyo and New York are on the same calendar date, so
        // "tomorrow" means the same day in both zones and the instants differ by
        // exactly the offset difference (9h vs -5h = 14h).
        let now = unix_ms_from_civil_utc(2026, 11, 1, 12, 0, 0, 0);
        let tokyo = resolve_at("tomorrow, 10am", Some("Asia/Tokyo"), now).unwrap();
        let ny = resolve_at("tomorrow, 10am", Some("America/New_York"), now).unwrap();
        assert_eq!(ny.deliver_at_ms - tokyo.deliver_at_ms, 14 * 3600 * 1000);
    }

    #[test]
    fn dst_gap_is_rejected() {
        // 12:00Z on the transition day: "today" in Test/Spring is 2026-03-08
        // (wall = 08:00 EDT), and 02:30 is the hour that does not exist.
        let now = unix_ms_from_civil_utc(2026, 3, 8, 12, 0, 0, 0);
        assert_eq!(
            resolve_at("today, 2:30", Some("Test/Spring"), now).unwrap_err(),
            ScheduleError::DstGap
        );
    }

    #[test]
    fn dst_overlap_uses_earlier_offset() {
        // 04:00Z on the fall-back day: "today" in Test/Fall is 2026-11-01
        // (wall = 00:00 EDT), and 01:30 happens twice. The earlier occurrence
        // is 01:30 EDT = 05:30Z.
        let now = unix_ms_from_civil_utc(2026, 11, 1, 4, 0, 0, 0);
        let r = resolve_at("today, 1:30", Some("Test/Fall"), now).unwrap();
        assert_eq!(r.deliver_at_ms, unix_ms_from_civil_utc(2026, 11, 1, 5, 30, 0, 0));
        assert_eq!(r.dst, Some("earlier"));
    }

    #[test]
    fn phrase_clock_forms() {
        assert_eq!(parse_phrase("tomorrow, 10am").unwrap(), (DayKind::Tomorrow, 10, 0));
        assert_eq!(parse_phrase("tomorrow 10:00").unwrap(), (DayKind::Tomorrow, 10, 0));
        assert_eq!(parse_phrase("today, 9pm").unwrap(), (DayKind::Today, 21, 0));
        assert_eq!(parse_phrase("today, 12am").unwrap(), (DayKind::Today, 0, 0));
        assert_eq!(parse_phrase("today, 12pm").unwrap(), (DayKind::Today, 12, 0));
        assert!(parse_phrase("in 2 hours").is_err());
        assert!(parse_phrase("next Friday").is_err());
        assert!(parse_phrase("10am").is_err());
    }

    #[test]
    fn date_math_round_trips() {
        for (y, mo, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 12, 31), (1969, 12, 31)] {
            let ms = unix_ms_from_civil_utc(y, mo, d, 12, 34, 56, 789);
            let (yy, mm, dd, h, mi, s) = civil_from_unix_ms_utc(ms);
            assert_eq!((yy, mm, dd, h, mi, s), (y, mo, d, 12, 34, 56));
        }
    }

    #[test]
    fn gmt_offset_parsing() {
        assert_eq!(parse_gmt_offset("GMT+09:00").unwrap(), 9 * 3600);
        assert_eq!(parse_gmt_offset("GMT-04:30").unwrap(), -(4 * 3600 + 30 * 60));
        assert_eq!(parse_gmt_offset("GMT").unwrap(), 0);
        assert_eq!(parse_gmt_offset("GMT+9").unwrap(), 9 * 3600);
    }
}
