// Pure helpers for reviewing and editing a release's live primary sale from
// Studio. VoidPrimarySale.configureSale has no "already configured" guard, so
// the edition artist may call it again. These helpers mirror its validation
// so a bad edit is caught before simulation, and describe the sale window in
// plain language (local time and UTC) so a short or wrong-timezone window is
// obvious before signing.
import { avaxToWei, weiToAvax } from "./primary-sale.js";
import { normalizeSaleTimeToUnixSeconds } from "./sale-time.js";

export const SALE_DURATION_PRESETS = Object.freeze([
  Object.freeze({ label: "1 hour", seconds: 3600 }),
  Object.freeze({ label: "24 hours", seconds: 86_400 }),
  Object.freeze({ label: "5 days", seconds: 432_000 }),
]);

// Windows shorter than this get an explicit warning on the confirmation.
export const SHORT_SALE_WINDOW_SECONDS = 3600;

export function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Unix seconds → a datetime-local input value in the browser's time zone ("" for 0). */
export function toLocalInputValue(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "";
  const date = new Date(value * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatLocalTime(seconds, options = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(Number(seconds) * 1000));
}

export function formatUtcTime(seconds, options = { dateStyle: "medium", timeStyle: "short" }) {
  return `${new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC", hourCycle: "h23" }).format(new Date(Number(seconds) * 1000))} UTC`;
}

/** Both renderings of an on-chain time, or null when the bound is unset (0). */
export function formatSaleInstant(seconds) {
  const value = Number(seconds || 0);
  if (!value) return null;
  return { local: formatLocalTime(value), utc: formatUtcTime(value) };
}

export function formatDuration(totalSeconds) {
  let seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const parts = [];
  for (const [unit, size] of [["day", 86_400], ["hour", 3600], ["minute", 60]]) {
    const count = Math.floor(seconds / size);
    seconds -= count * size;
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
  }
  return parts.slice(0, 2).join(" ");
}

/** upcoming / live / ended from the on-chain sale; paused is reported separately. */
export function saleStatus(sale, nowSec = nowSeconds()) {
  if (!sale?.configured) return "not-configured";
  const start = Number(sale.startTime || 0n);
  const end = Number(sale.endTime || 0n);
  if (end && nowSec > end) return "ended";
  if (sale.maxSupply !== 0n && sale.sold >= sale.maxSupply) return "ended";
  if (start && nowSec < start) return "upcoming";
  return "live";
}

export const SALE_STATUS_LABELS = Object.freeze({
  "not-configured": "Not on sale",
  upcoming: "Upcoming",
  live: "Live",
  ended: "Ended",
});

/** Editable form values prefilled from the live on-chain sale. */
export function saleFormFromChain(sale) {
  return {
    price: weiToAvax(String(sale.priceWei)),
    maxSupply: sale.maxSupply === 0n ? "" : sale.maxSupply.toString(),
    perWalletLimit: sale.perWalletLimit === 0n ? "" : sale.perWalletLimit.toString(),
    start: toLocalInputValue(sale.startTime),
    end: toLocalInputValue(sale.endTime),
    paused: Boolean(sale.paused),
  };
}

/** Sets the end time `seconds` after the start (or after now when the sale starts immediately). */
export function applyDurationPreset(form, seconds, nowSec = nowSeconds()) {
  let start;
  try { start = normalizeSaleTimeToUnixSeconds(form.start); } catch { start = 0; }
  const from = start || nowSec;
  return { ...form, end: toLocalInputValue(from + seconds) };
}

function wholeNumber(text, message) {
  const value = String(text ?? "").trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) throw new Error(message);
  return BigInt(value);
}

/**
 * Genesis holder claim invariants (GenesisHolderClaim._assertPublicAllocation):
 * the sale cap must equal publicAllocation, and while claims are live the sale
 * may not start before claimsOpenedAt + 24 hours.
 */
export function claimGuardErrors(values, claim) {
  if (!claim || claim.state === "none" || claim.state === "loading") return [];
  if (claim.state !== "active") return [`The Genesis holder claim for this token could not be checked${claim.message ? `: ${claim.message}` : ""}. Edits are blocked until it can be checked.`];
  const errors = [];
  if (values.maxSupply !== claim.publicAllocation) {
    errors.push(`A Genesis holder claim is configured for this token. The sale cap must stay ${claim.publicAllocation.toString()} (the public allocation); a different cap breaks holder claims.`);
  }
  if (claim.live && values.startTime < claim.minimumStart) {
    const at = formatSaleInstant(claim.minimumStart);
    errors.push(`Genesis holder claims are still open. The sale cannot start before ${at.local} your time (${at.utc}), 24 hours after claims opened.`);
  }
  return errors;
}

/**
 * Validates an edit with the same rules as VoidPrimarySale.configureSale, plus
 * "end must be after start" and "end must be in the future" for a sale that
 * will be unpaused. Returns { values, errors }; values are on-chain units.
 */
export function buildSaleChange({ form, sale = null, editionMaxSupply, claim = null, nowSec = nowSeconds() }) {
  const errors = [];
  const openEdition = BigInt(editionMaxSupply ?? 0) === 0n;
  const sold = sale?.sold ?? 0n;
  let priceWei = 0n;
  try { priceWei = BigInt(avaxToWei(form.price)); } catch (error) { errors.push(error.message); }

  let maxSupply = 0n;
  try {
    const parsed = wholeNumber(form.maxSupply, "Sale cap must be a whole number.");
    maxSupply = parsed ?? 0n;
    if (!openEdition) {
      if (parsed === null || parsed === 0n) errors.push("Set how many copies this sale can sell.");
      else if (parsed > BigInt(editionMaxSupply)) errors.push(`Sale cap exceeds the edition supply of ${BigInt(editionMaxSupply).toString()}.`);
    }
    if (maxSupply !== 0n && maxSupply < sold) errors.push(`Sale cap can't be lower than the ${sold.toString()} already sold.`);
  } catch (error) { errors.push(error.message); }

  let perWalletLimit = 0n;
  try {
    const parsed = wholeNumber(form.perWalletLimit, "Per-wallet limit must be a whole number.");
    perWalletLimit = parsed ?? 0n;
    if (!openEdition && (perWalletLimit === 0n || perWalletLimit > maxSupply)) errors.push("Per-wallet limit must be between 1 and the sale cap.");
    if (openEdition && maxSupply !== 0n && perWalletLimit > maxSupply) errors.push("Per-wallet limit can't be more than the sale cap.");
  } catch (error) { errors.push(error.message); }

  let startTime = 0n;
  let endTime = 0n;
  try { startTime = BigInt(normalizeSaleTimeToUnixSeconds(form.start)); } catch (error) { errors.push(`Start: ${error.message}`); }
  try { endTime = BigInt(normalizeSaleTimeToUnixSeconds(form.end)); } catch (error) { errors.push(`End: ${error.message}`); }
  const paused = Boolean(form.paused);
  if (openEdition && endTime === 0n) errors.push("An open edition needs an end time. The end time is what closes the edition.");
  if (endTime !== 0n && startTime !== 0n && endTime <= startTime) errors.push("The end time must be after the start time.");
  if (endTime !== 0n && !paused && endTime <= BigInt(nowSec)) errors.push("The end time has already passed. Pick a future end time to reopen the sale.");

  const values = { priceWei, maxSupply, perWalletLimit, startTime, endTime, paused, openEdition };
  if (!errors.length) errors.push(...claimGuardErrors(values, claim));
  return { values, errors };
}

/** "Sale runs for 1 hour: 7:45 PM → 8:45 PM your time (18:45 → 19:45 UTC)". */
export function describeSaleWindow({ startTime, endTime, nowSec = nowSeconds() }) {
  const start = Number(startTime || 0);
  const end = Number(endTime || 0);
  const from = start || nowSec;
  const time = { timeStyle: "short" };
  const sameDay = end && new Date(from * 1000).toDateString() === new Date(end * 1000).toDateString();
  const style = sameDay ? time : { dateStyle: "medium", timeStyle: "short" };
  const localFrom = start ? formatLocalTime(from, style) : "now";
  const utcFrom = start ? formatUtcTime(from, style).replace(/ UTC$/, "") : "now";
  if (!end) return `Sale starts ${start ? `${localFrom} your time (${formatUtcTime(from, style)})` : "now"} and has no end time.`;
  const duration = formatDuration(end - from);
  return `Sale runs for ${duration}: ${localFrom} → ${formatLocalTime(end, style)} your time (${utcFrom} → ${formatUtcTime(end, style)}).`;
}

export function saleWindowWarning({ startTime, endTime, nowSec = nowSeconds() }) {
  const end = Number(endTime || 0);
  if (!end) return "";
  const length = end - (Number(startTime || 0) || nowSec);
  return length < SHORT_SALE_WINDOW_SECONDS ? `Short window: the sale is open for only ${formatDuration(length)}.` : "";
}
