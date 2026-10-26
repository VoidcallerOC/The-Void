import { useEffect, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { GENESIS_CLAIM_COUNTDOWN_LABEL, GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS, countdownParts, localTargetLabel } from "../lib/genesis-countdown.js";

const pad = (value) => String(value).padStart(2, "0");

/**
 * Live countdown to the scheduled opening. Display only: reaching zero says the claim is *scheduled*
 * to open; the page's verified claim status still decides whether anything can be claimed.
 */
export function GenesisCountdown({ targetSeconds = GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const parts = countdownParts(targetSeconds, nowMs);
  useEffect(() => {
    if (parts.done) return undefined;
    // Each tick re-reads the clock, so throttled or suspended tabs catch up on the next tick or on focus.
    const tick = () => setNowMs(Date.now());
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [parts.done]);
  const local = localTargetLabel(targetSeconds);
  const units = [["days", parts.days], ["hours", parts.hours], ["minutes", parts.minutes], ["seconds", parts.seconds]];
  // Screen readers get a minute-level summary instead of an announcement every second.
  const spoken = parts.done
    ? "Genesis claims are scheduled to open now."
    : `${parts.days} days, ${parts.hours} hours, ${parts.minutes} minutes until Genesis claims are scheduled to open.`;
  return (
    <div className="vc-countdown" data-testid="genesis-countdown">
      <Eyebrow red>{parts.done ? "Scheduled opening reached" : "Genesis claims open in"}</Eyebrow>
      {parts.done ? (
        <p className="vc-countdown-now">Genesis claims are scheduled to open now.</p>
      ) : (
        <div className="vc-countdown-grid" role="timer" aria-hidden="true">
          {units.map(([unit, value]) => (
            <div className="vc-countdown-unit" key={unit}>
              <span className="vc-countdown-value">{unit === "days" ? value : pad(value)}</span>
              <span className="vc-countdown-label">{unit}</span>
            </div>
          ))}
        </div>
      )}
      <p className="vc-sr-only" aria-live="polite" aria-atomic="true">{spoken}</p>
      <p className="vc-countdown-target">
        <time dateTime={new Date(targetSeconds * 1000).toISOString()}>{GENESIS_CLAIM_COUNTDOWN_LABEL}</time>
        {local && <span className="vc-countdown-local"> · {local} your time</span>}
      </p>
      {parts.done && <p className="vc-countdown-note">The claim status on this page confirms when claiming is actually available.</p>}
    </div>
  );
}
