import { useEffect, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { countdownParts } from "../lib/genesis-countdown.js";

const pad = (value) => String(value).padStart(2, "0");

/**
 * Time left in an activated Genesis claim. `claimEnd` is the contract's own claimEnd, as the server verified it;
 * this component never computes, resets or extends the window. Display only: at zero it reports the claim
 * closed and calls `onClosed`, so the page re-evaluates its phase; the contract enforces the close regardless.
 */
export function WeekendClaimCountdown({ claimEnd, onClosed }) {
  const end = Number(claimEnd);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const parts = countdownParts(end, nowMs);
  useEffect(() => {
    if (parts.done) {
      onClosed?.();
      return undefined;
    }
    // Each tick re-reads the clock, so throttled or suspended tabs catch up on the next tick or on focus.
    const tick = () => setNowMs(Date.now());
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
    // onClosed is deliberately not a dependency: it fires once, when the window reaches its end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts.done]);
  if (!Number.isFinite(end) || end <= 0) return null;
  const hours = parts.days * 24 + parts.hours;
  return (
    <div className="vc-countdown" data-testid="weekend-claim-countdown">
      <Eyebrow red>{parts.done ? "Genesis claim closed" : "Genesis claim closes in"}</Eyebrow>
      {parts.done ? (
        <p className="vc-countdown-now">The 24-hour Genesis claim window has closed.</p>
      ) : (
        <div className="vc-countdown-grid" role="timer" aria-hidden="true">
          {[["hours", hours], ["minutes", parts.minutes], ["seconds", parts.seconds]].map(([unit, value]) => (
            <div className="vc-countdown-unit" key={unit}>
              <span className="vc-countdown-value">{pad(value)}</span>
              <span className="vc-countdown-label">{unit}</span>
            </div>
          ))}
        </div>
      )}
      <p className="vc-sr-only" aria-live="polite" aria-atomic="true">
        {parts.done ? "The Genesis claim window has closed." : `${hours} hours and ${parts.minutes} minutes left to claim.`}
      </p>
      <p className="vc-countdown-target">
        <time dateTime={new Date(end * 1000).toISOString()}>Closes {new Date(end * 1000).toUTCString()}</time>
      </p>
    </div>
  );
}
