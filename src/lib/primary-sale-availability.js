// Primary-sale availability for one edition, shared by the API
// (server/api-service.js) and the storefront. Pure: no ethers, no I/O.
//
// The order mirrors VoidPrimarySale.purchase(): configured, paused, start,
// end, then the sale cap. Edition supply 0 (or blank) is an open edition and
// never means "nothing left": an open edition closes at its sale end time.

export const SALE_AVAILABILITY = Object.freeze({
  OPEN: "open",
  NOT_STARTED: "not-started",
  ENDED: "ended",
  SOLD_OUT: "sold-out",
  PAUSED: "paused",
  UNCONFIGURED: "unconfigured",
});

const STATES = new Set(Object.values(SALE_AVAILABILITY));

function whole(value) {
  if (value === null || value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Edition supply 0, blank or "Open" is an open edition (no edition cap). */
export function isOpenEditionSupply(supply) {
  if (supply === null || supply === undefined) return true;
  const text = String(supply).trim();
  return text === "" || /^0+$/.test(text) || /^open$/i.test(text);
}

/** A capped edition: a positive whole-number supply. */
export function editionSupplyCap(supply) {
  if (isOpenEditionSupply(supply)) return null;
  const text = String(supply).trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

/**
 * sale: the on-chain `sales(tokenId)` tuple as bigints or decimal strings
 * ({ configured, paused, priceWei, maxSupply, sold, perWalletLimit, startTime, endTime }).
 */
export function primarySaleAvailability(sale, { editionSupply = null, now = Date.now() } = {}) {
  const openEdition = isOpenEditionSupply(editionSupply);
  if (!sale || sale.configured !== true) return { state: SALE_AVAILABILITY.UNCONFIGURED, openEdition, startTime: 0, endTime: 0 };
  const nowSeconds = BigInt(Math.floor(Number(now) / 1000));
  const start = whole(sale.startTime);
  const end = whole(sale.endTime);
  const cap = whole(sale.maxSupply);
  const sold = whole(sale.sold);
  const base = { openEdition, startTime: Number(start), endTime: Number(end), unlimited: cap === 0n };
  if (cap !== 0n && sold >= cap) return { ...base, state: SALE_AVAILABILITY.SOLD_OUT };
  if (sale.paused === true) return { ...base, state: SALE_AVAILABILITY.PAUSED };
  if (start !== 0n && nowSeconds < start) return { ...base, state: SALE_AVAILABILITY.NOT_STARTED };
  if (end !== 0n && nowSeconds > end) return { ...base, state: SALE_AVAILABILITY.ENDED };
  return { ...base, state: SALE_AVAILABILITY.OPEN };
}

export function isSaleAvailabilityState(value) {
  return STATES.has(value);
}

export function formatSaleTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${new Date(value * 1000).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
}

/** Collector-facing line for an availability result. */
export function saleAvailabilityLabel(availability) {
  if (!availability) return "";
  const until = formatSaleTime(availability.endTime);
  switch (availability.state) {
    case SALE_AVAILABILITY.OPEN:
      if (availability.openEdition || availability.unlimited) return until ? `Open edition · until ${until}` : "Open edition";
      return until ? `Available · until ${until}` : "Available";
    case SALE_AVAILABILITY.NOT_STARTED: {
      const starts = formatSaleTime(availability.startTime);
      return starts ? `Starts ${starts}` : "Not started";
    }
    case SALE_AVAILABILITY.ENDED:
      return "Sale ended";
    case SALE_AVAILABILITY.SOLD_OUT:
      return "Sold out";
    case SALE_AVAILABILITY.PAUSED:
      return "Sale paused";
    default:
      return "Not yet on sale";
  }
}
