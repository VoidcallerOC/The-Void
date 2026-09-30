import { PURCHASE_STATE } from "./marketplace.js";

function apiBase() {
  const configured = import.meta.env.VITE_API_ORIGIN;
  return configured ? configured.replace(/\/$/, "") : "";
}

async function request(path, { method = "GET", body = null, headers = {}, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Marketplace API returned an invalid response."); }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Marketplace request failed.");
    error.code = payload?.error?.code || "MARKETPLACE_REQUEST_FAILED";
    throw error;
  }
  return payload.data;
}

function normalizeListing(row) {
  if (!row?.id || !row?.listing_id || !row?.marketplace_address || !row?.token_contract_address) throw new Error("Indexed marketplace listing was incomplete.");
  return {
    id: row.id,
    listingId: String(row.listing_id),
    seller: row.seller_wallet,
    chain: Number(row.chain_id),
    marketplace: row.marketplace_address,
    tokenContract: row.token_contract_address,
    contract: row.token_contract_address,
    tokenId: String(row.token_id),
    amount: String(row.remaining_amount),
    initialAmount: String(row.amount),
    price: String(row.price_wei),
    currency: row.currency,
    expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : 0,
    status: row.status,
    authority: "INDEXED",
    updatedAt: row.updated_at || null,
  };
}

export async function fetchIndexedListings({ chainId, marketplaceAddress, tokenContractAddress, tokenId, sellerWallet, status = "ACTIVE", fetchImpl = fetch, signal } = {}) {
  const query = new URLSearchParams();
  if (chainId) query.set("chainId", String(chainId));
  if (marketplaceAddress) query.set("marketplaceAddress", marketplaceAddress);
  if (tokenContractAddress) query.set("tokenContractAddress", tokenContractAddress);
  if (tokenId !== undefined && tokenId !== null && tokenId !== "") query.set("tokenId", String(tokenId));
  if (sellerWallet) query.set("sellerWallet", sellerWallet);
  if (status) query.set("status", status);
  const data = await request(`/api/listings?${query}`, { fetchImpl, signal });
  if (!Array.isArray(data)) throw new Error("Indexed marketplace listings were incomplete.");
  return data.map(normalizeListing);
}

export async function fetchAuthoritativeListing({ chainId, marketplaceAddress, listingId, fetchImpl = fetch, signal } = {}) {
  const data = await request(`/api/listings/${encodeURIComponent(chainId)}/${encodeURIComponent(marketplaceAddress)}/${encodeURIComponent(listingId)}`, { fetchImpl, signal });
  return normalizeListing(data);
}

export async function fetchAuthoritativeMarketplaceTransaction({ chainId, transactionHash, fetchImpl = fetch, signal } = {}) {
  return request(`/api/marketplace/transactions/${encodeURIComponent(chainId)}/${encodeURIComponent(transactionHash)}`, { fetchImpl, signal });
}

const SETTLED_STATUSES = new Set(["CONFIRMED", "FINALIZED", "RECONCILED"]);
const FAILURE_STATES = Object.freeze({
  FAILED: { state: PURCHASE_STATE.FAILED, message: "The authoritative backend marked this purchase failed. Check the transaction record before taking further action." },
  REVERTED: { state: PURCHASE_STATE.REVERTED, message: "The purchase transaction reverted on-chain. Review its wallet receipt before submitting anything else." },
  REPLACED: { state: PURCHASE_STATE.REPLACED, message: "The purchase transaction was replaced. Check the replacement transaction before taking further action." },
  STALE: { state: PURCHASE_STATE.STALE, message: "The submitted transaction is stale. Verify wallet and chain state before taking further action." },
  EXPIRED: { state: PURCHASE_STATE.EXPIRED, message: "The listing expired before settlement. Do not retry this purchase submission." },
  REORGED: { state: PURCHASE_STATE.RECONCILIATION_REQUIRED, message: "The backend reports a chain reorganization. Do not resubmit; reconciliation is required." },
  RECONCILIATION_REQUIRED: { state: PURCHASE_STATE.RECONCILIATION_REQUIRED, message: "The backend requires purchase reconciliation. Do not resubmit this transaction." },
});

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function classifyAuthoritativePurchaseTransaction(transaction, expected = {}) {
  const identityMatches = transaction
    && String(transaction.chain_id) === String(expected.chainId)
    && sameAddress(transaction.transaction_hash, expected.transactionHash)
    && String(transaction.transaction_type).toUpperCase() === "PURCHASE"
    && sameAddress(transaction.from_wallet, expected.buyer)
    && sameAddress(transaction.to_address, expected.marketplaceAddress);
  if (!identityMatches) {
    return { state: PURCHASE_STATE.RECONCILIATION_REQUIRED, message: "The authoritative transaction record does not match this purchase. Do not resubmit; backend reconciliation is required." };
  }

  const status = String(transaction.status || "").toUpperCase();
  if (Object.hasOwn(FAILURE_STATES, status)) return FAILURE_STATES[status];
  if (!SETTLED_STATUSES.has(status)) return null;

  const matchingPurchase = Array.isArray(transaction.purchases) && transaction.purchases.some((purchase) => (
    String(purchase.listingId) === String(expected.listingId)
    && String(purchase.quantity) === String(expected.quantity)
    && SETTLED_STATUSES.has(String(purchase.status || "").toUpperCase())
  ));
  const paymentMatches = String(transaction.value_wei) === String(expected.payment);
  if (!matchingPurchase || !paymentMatches) {
    return { state: PURCHASE_STATE.RECONCILIATION_REQUIRED, message: "The backend marked the transaction settled but did not return a matching indexed purchase record. Do not resubmit; reconciliation is required." };
  }
  return { state: PURCHASE_STATE.CONFIRMED, message: "The authoritative marketplace index confirmed the purchase settlement." };
}

export async function createAuthoritativePurchaseIntent({ listing, wallet, quantity, marketplaceAddress, authHeaders, fetchImpl = fetch } = {}) {
  return request("/api/purchases/intents", { method: "POST", headers: authHeaders, fetchImpl, body: { listingId: listing?.id, buyerWallet: wallet, quantity: String(quantity), idempotencyKey: crypto.randomUUID(), marketplaceAddress } });
}

export async function recordAuthoritativeTransactionSubmission({ transactionHash, chainId, wallet, marketplaceAddress, listingId = null, type, authHeaders, fetchImpl = fetch } = {}) {
  const path = type === "LISTING" ? "/api/listings" : type === "LISTING_CANCEL" ? "/api/listings/cancel" : "/api/purchases/submitted";
  const body = type === "LISTING" || type === "LISTING_CANCEL"
    ? { transactionHash, chainId, sellerWallet: wallet, marketplaceAddress }
    : { transactionHash, chainId, buyerWallet: wallet, marketplaceAddress, listingId };
  return request(path, { method: "POST", headers: authHeaders, fetchImpl, body });
}
