import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { CHAINS } from "../lib/web3.js";
import { fetchListings, LISTING_STATUS, MARKETPLACE_CONFIG, PURCHASE_STATE, requiredPayment, submitPurchase } from "../lib/marketplace.js";

const field = { width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px" };
const states = [PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.OBSERVED, PURCHASE_STATE.CONFIRMED];

export function PurchasePanel({ edition }) {
  const wallet = useWallet();
  const chain = useMemo(() => Object.values(CHAINS).find((item) => item.id === edition.chainId) || CHAINS.cchain, [edition.chainId]);
  const [listings, setListings] = useState([]);
  const [listingId, setListingId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [state, setState] = useState(PURCHASE_STATE.READY);
  const [message, setMessage] = useState("");
  const [collected, setCollected] = useState(false);
  const listing = listings.find((item) => String(item.listing_id || item.listingId) === String(listingId));
  const normalizedListing = listing && { ...listing, listingId: String(listing.listing_id || listing.listingId), seller: listing.seller_wallet || listing.seller, tokenContract: listing.token_contract_address || listing.tokenContract, tokenId: String(listing.token_id ?? listing.tokenId), amount: String(listing.remaining_amount ?? listing.amount), price: String(listing.price_wei ?? listing.price), status: listing.status, expiresAt: listing.expires_at ? Math.floor(new Date(listing.expires_at).getTime() / 1000) : 0 };

  const refresh = useCallback(async () => {
    if (!MARKETPLACE_CONFIG.enabled) return;
    try { setMessage("Refreshing listings from the authoritative indexer…"); const rows = await fetchListings({ filters: { chainId: edition.chainId, tokenContractAddress: edition.contractAddress, tokenId: edition.tokenIds[0], status: LISTING_STATUS.ACTIVE } }); setListings(rows); if (!listingId && rows[0]) setListingId(String(rows[0].listing_id || rows[0].listingId)); setMessage(rows.length ? "Active listings loaded." : "No active listings are currently available."); } catch (error) { setMessage(error?.message || "Could not load marketplace listings."); }
  }, [edition.contractAddress, edition.chainId, edition.tokenIds, listingId]);
  useEffect(() => { const timer = setTimeout(() => { refresh(); }, 0); return () => clearTimeout(timer); }, [refresh]);

  const collect = async () => {
    if (!wallet.connected || !wallet.account) { setMessage("Connect your wallet before collecting."); return; }
    if (!normalizedListing) { setMessage("Choose an active listing first."); return; }
    try { setCollected(false); setMessage("Verify the active listing, quantity, and payment in your wallet…"); await submitPurchase({ provider: wallet.getProvider(), buyer: wallet.account, marketplace: MARKETPLACE_CONFIG.address, listing: normalizedListing, quantity: Number(quantity), chain, chainId: wallet.chainId, onState: setState }); await wallet.refreshOwnership(wallet.account); setCollected(true); setMessage("Settlement confirmed. Your edition is now in your collection."); await refresh(); } catch (error) { setState(error?.code === "EXPIRED" ? PURCHASE_STATE.EXPIRED : error?.code === 4001 ? PURCHASE_STATE.REJECTED : PURCHASE_STATE.FAILED); setMessage(error?.message || "Purchase failed. No collection state was changed."); }
  };

  const payment = normalizedListing ? requiredPayment(normalizedListing, Number(quantity)) : null;
  const disabled = !MARKETPLACE_CONFIG.enabled || state === PURCHASE_STATE.WALLET_CONFIRMATION || state === PURCHASE_STATE.SUBMITTED || state === PURCHASE_STATE.PENDING;
  return <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>COLLECT · PURCHASE EDITION</div><p style={{ color: "var(--vc-bone-dim)", maxWidth: 600, lineHeight: 1.6 }}>Purchases use active listings discovered from the blockchain-backed indexer. The receipt is verified before your collector library refreshes.</p>{!MARKETPLACE_CONFIG.enabled && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Marketplace is not configured for this environment.</p>}<div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(120px, .6fr)", gap: 14, opacity: MARKETPLACE_CONFIG.enabled ? 1 : .55 }}><div><label htmlFor="purchase-listing">ACTIVE LISTING</label><select id="purchase-listing" value={listingId} onChange={(event) => { setListingId(event.target.value); setState(PURCHASE_STATE.READY); }} style={field}><option value="">Choose a listing</option>{listings.map((item) => <option key={item.listing_id || item.listingId} value={item.listing_id || item.listingId}>#{item.listing_id || item.listingId} · {item.remaining_amount || item.amount} available · {item.price_wei || item.price} wei</option>)}</select></div><div><label htmlFor="purchase-quantity">QUANTITY</label><input id="purchase-quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} style={field} /></div></div><div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}><Btn onClick={refresh} disabled={!MARKETPLACE_CONFIG.enabled || disabled}>REFRESH LISTINGS</Btn>{normalizedListing && <Btn onClick={collect} disabled={disabled || normalizedListing.status !== LISTING_STATUS.ACTIVE || !wallet.connected}>COLLECT EDITION</Btn>}</div>{normalizedListing && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--vc-mono)", fontSize: 11 }}>STATUS {normalizedListing.status} · AVAILABLE {normalizedListing.amount} · UNIT PRICE {normalizedListing.price} · TOTAL {payment || "—"} WEI</p>}<div aria-live="polite" style={{ marginTop: 16, fontFamily: "var(--vc-mono)", fontSize: 10, color: state === PURCHASE_STATE.CONFIRMED ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>{states.map((item, index) => <span key={item} style={{ color: states.indexOf(state) >= index && ![PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) ? "var(--vc-crimson)" : "inherit" }}>{index ? " → " : ""}{item}</span>)}</div>{message && <p style={{ color: [PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) ? "var(--vc-crimson)" : "var(--vc-bone-dim)", fontFamily: "var(--vc-mono)", fontSize: 11 }}>{message}</p>}{collected && <div style={{ ...field, marginTop: 20, borderColor: "var(--vc-crimson)" }}><div style={{ color: "var(--vc-crimson)", fontFamily: "var(--vc-mono)", fontSize: 10, letterSpacing: ".16em" }}>YOU COLLECTED</div><h3 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "10px 0" }}>{edition.title}</h3><p style={{ color: "var(--vc-bone-dim)" }}>The asset is reflected in your refreshed collection state.</p></div>}</section>;
}
