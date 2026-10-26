/**
 * Display-only countdown to the scheduled Genesis claim opening. This constant is the single source for
 * the countdown; it never decides claim availability — the server-verified target and the claim
 * contract do. Monday, October 26, 2026 · 9:00:00 AM EDT (America/New_York) = 13:00:00 UTC.
 */
export const GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS = 1793019600;
export const GENESIS_CLAIM_COUNTDOWN_TIME_ZONE = "America/New_York";
export const GENESIS_CLAIM_COUNTDOWN_LABEL = "Monday, October 26 · 9:00 AM EDT";

/** Remaining time from an absolute target, never negative; recomputed from the clock on every call. */
export function countdownParts(targetSeconds = GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS, nowMs = Date.now()) {
  const remaining = Math.max(0, Math.ceil(targetSeconds - nowMs / 1000));
  return {
    done: remaining === 0,
    totalSeconds: remaining,
    days: Math.floor(remaining / 86_400),
    hours: Math.floor((remaining % 86_400) / 3_600),
    minutes: Math.floor((remaining % 3_600) / 60),
    seconds: remaining % 60,
  };
}

/** The target in the viewer's own locale and time zone, alongside the fixed EDT label. */
export function localTargetLabel(targetSeconds = GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(targetSeconds * 1000));
  } catch {
    return "";
  }
}
