// Normalizes the Studio sale start/end time inputs into the on-chain
// convention: a Unix timestamp in whole SECONDS (the VoidPrimarySale
// `configureSale` ABI takes uint64 startTime/endTime in seconds, matching
// the `Math.floor(Date.now() / 1000)` convention used elsewhere).
//
// The sale form accepts a free-text field, so a human may type a clock time
// such as "6:00am". Passing that straight into BigInt() throws
// "Cannot convert 6:00am to a BigInt". This helper converts recognized
// human-readable representations to seconds, passes through values that are
// already Unix seconds, and rejects anything else with a clear error BEFORE
// it can reach BigInt().

// The contract treats 0 as "no bound" (no start / no end constraint).
export const SALE_TIME_UNSET = 0;

function invalidTime(received) {
  return new Error(
    `Enter a valid sale time such as "6:00am", an ISO datetime, or a Unix timestamp in seconds (received "${received}").`,
  );
}

// Parse a bare 12- or 24-hour clock time: "6:00am", "6am", "12:00pm",
// "18:30", "6:00 AM". Returns { hour, minute } in 24-hour form, or null.
function parseClockTime(raw) {
  const match = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].replace(/\./g, "").toLowerCase() : null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    // 12am → 00:00, 12pm → 12:00, otherwise add 12 for pm.
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

// Combine a local calendar day with an hour/minute into Unix seconds. Uses
// local time so a Studio user's "6:00am" means 6am in their own timezone.
function secondsFromLocalComponents(dayDate, hour, minute) {
  const local = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), hour, minute, 0, 0);
  return Math.floor(local.getTime() / 1000);
}

/**
 * Convert a sale time input into a non-negative Unix timestamp in seconds.
 * @param {string|number|bigint|null|undefined} value
 * @param {{ now?: number }} [options] injectable clock (ms) for bare clock times / tests
 * @returns {number} whole seconds; 0 when unset
 * @throws {Error} for values that cannot be interpreted as a time
 */
export function normalizeSaleTimeToUnixSeconds(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined) return SALE_TIME_UNSET;

  if (typeof value === "bigint") {
    if (value < 0n) throw invalidTime(String(value));
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw invalidTime(String(value));
    return Math.floor(value);
  }

  const raw = String(value).trim();
  if (raw === "") return SALE_TIME_UNSET;

  // Already a Unix timestamp in seconds.
  if (/^\d+$/.test(raw)) return Number(raw);

  // Bare clock time → that time today, in local time.
  const clock = parseClockTime(raw);
  if (clock) return secondsFromLocalComponents(new Date(now), clock.hour, clock.minute);

  // A calendar date plus a 12-hour clock time, e.g. "2026-09-27 6:00am".
  const dated = raw.match(/^(.*\S)\s+(\d{1,2}(?::[0-5]\d)?\s*[ap]\.?m\.?)$/i);
  if (dated) {
    const clockPart = parseClockTime(dated[2]);
    const day = new Date(dated[1]);
    if (clockPart && !Number.isNaN(day.getTime())) {
      return secondsFromLocalComponents(day, clockPart.hour, clockPart.minute);
    }
  }

  // ISO 8601 / datetime-local ("2026-09-27T06:00", "2026-09-27T06:00:00Z").
  // Gated to an explicit YYYY-MM-DD date so loose inputs like "6:99am" fall
  // through to a clean error instead of Date's lenient guesses.
  if (/^\d{4}-\d{2}-\d{2}([T ][0-9:.+\-Z]*)?$/.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000);
  }

  throw invalidTime(raw);
}
