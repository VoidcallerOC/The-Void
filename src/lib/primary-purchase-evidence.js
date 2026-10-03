export const PRIMARY_PURCHASE_EVIDENCE_KEY = "the-void.primary-purchase-evidence.v1";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function evidenceKey({ editionId, tokenId, purchaser }) {
  return [String(editionId || ""), String(tokenId ?? ""), String(purchaser || "").toLowerCase()].join(":");
}

export function normalizePrimaryPurchaseEvidence(input = {}) {
  if (!input.transactionHash || !input.editionId || input.tokenId === undefined || !input.purchaser) return null;
  return {
    transactionHash: String(input.transactionHash).toLowerCase(),
    tokenId: String(input.tokenId),
    editionId: String(input.editionId),
    quantity: String(input.quantity ?? "1"),
    priceWei: String(input.priceWei ?? "0"),
    purchaser: String(input.purchaser).toLowerCase(),
    savedAt: input.savedAt || new Date().toISOString(),
  };
}

export function savePrimaryPurchaseEvidence(input, store = storage()) {
  const evidence = normalizePrimaryPurchaseEvidence(input);
  if (!evidence || !store?.getItem || !store?.setItem) return evidence;
  try {
    const current = JSON.parse(store.getItem(PRIMARY_PURCHASE_EVIDENCE_KEY) || "{}");
    current[evidenceKey(evidence)] = evidence;
    store.setItem(PRIMARY_PURCHASE_EVIDENCE_KEY, JSON.stringify(current));
  } catch {
    // Receipt display remains functional even when browser storage is unavailable.
  }
  return evidence;
}

export function loadPrimaryPurchaseEvidence({ editionId, tokenId, purchaser }, store = storage()) {
  if (!editionId || tokenId === undefined || !purchaser || !store?.getItem) return null;
  try {
    const current = JSON.parse(store.getItem(PRIMARY_PURCHASE_EVIDENCE_KEY) || "{}");
    return normalizePrimaryPurchaseEvidence(current[evidenceKey({ editionId, tokenId, purchaser })]);
  } catch {
    return null;
  }
}
