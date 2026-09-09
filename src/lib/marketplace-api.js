function apiBase() {
  const configured = import.meta.env.VITE_API_ORIGIN;
  return configured ? configured.replace(/\/$/, "") : "";
}

async function request(path, { method = "GET", body = null, headers = {}, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

export async function fetchAuthoritativeListing({ chainId, marketplaceAddress, listingId, fetchImpl = fetch } = {}) {
  const data = await request(`/api/listings/${encodeURIComponent(chainId)}/${encodeURIComponent(marketplaceAddress)}/${encodeURIComponent(listingId)}`, { fetchImpl });
  return normalizeListing(data);
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
