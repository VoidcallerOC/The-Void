import { useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { CHAINS } from "../lib/web3.js";
import { LISTING_STATUS, MARKETPLACE_CONFIG, PURCHASE_STATE, readListing, requiredPayment, submitPurchase } from "../lib/marketplace.js";

const field = { width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px" };
const states = [PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.CONFIRMED];

export function PurchasePanel({ edition }) {
  const wallet = useWallet();
  const chain = useMemo(() => Object.values(CHAINS).find((item) => item.id === edition.chainId) || CHAINS.cchain, [edition.chainId]);
  const [listingId, setListingId] = useState("");
  const [listing, setListing] = useState(null);
  const [quantity, setQuantity] = useState("1");
  const [state, setState] = useState(PURCHASE_STATE.READY);
  const [message, setMessage] = useState("");
  const [collected, setCollected] = useState(false);

  const load = async () => {
    if (!MARKETPLACE_CONFIG.enabled || !MARKETPLACE_CONFIG.address) { setMessage("Purchasing is awaiting a reviewed test-network deployment."); return; }
    if (!listingId || !/^\d+$/.test(listingId)) { setMessage("Enter a numeric listing ID."); return; }
    try { setMessage("Reading the current listing state…"); const next = await readListing({ provider: wallet.getProvider(), marketplace: MARKETPLACE_CONFIG.address, listingId }); setListing(next); setQuantity("1"); setState(next.status === LISTING_STATUS.ACTIVE ? PURCHASE_STATE.READY : PURCHASE_STATE.FAILED); setMessage(next.status === LISTING_STATUS.ACTIVE ? "Listing is active. Choose your quantity." : `Listing is ${next.status}.`); } catch (error) { setState(PURCHASE_STATE.FAILED); setMessage(error?.message || "Could not load listing."); }
  };

  const collect = async () => {
    if (!wallet.connected || !wallet.account) { setMessage("Connect your wallet before collecting."); return; }
    if (!listing) { setMessage("Load an active listing first."); return; }
    try {
      setCollected(false); setMessage("Verify the active listing, quantity, and payment in your wallet…");
      await submitPurchase({ provider: wallet.getProvider(), buyer: wallet.account, marketplace: MARKETPLACE_CONFIG.address, listing, quantity: Number(quantity), chain, chainId: wallet.chainId, onState: setState });
      await wallet.refreshOwnership(wallet.account);
      setCollected(true); setMessage("Settlement confirmed. Your edition is now in your collection.");
    } catch (error) {
      setState(error?.code === "EXPIRED" ? PURCHASE_STATE.EXPIRED : error?.code === 4001 ? PURCHASE_STATE.REJECTED : PURCHASE_STATE.FAILED);
      setMessage(error?.message || "Purchase failed. No collection state was changed.");
    }
  };

  const payment = listing ? requiredPayment(listing, Number(quantity)) : null;
  const disabled = !MARKETPLACE_CONFIG.enabled || state === PURCHASE_STATE.WALLET_CONFIRMATION || state === PURCHASE_STATE.SUBMITTED || state === PURCHASE_STATE.PENDING;
  return <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>COLLECT · PURCHASE EDITION</div><p style={{ color: "var(--vc-bone-dim)", maxWidth: 600, lineHeight: 1.6 }}>Purchases settle on-chain in native currency. The listing is read again before the wallet transaction, and the receipt is verified before your collector library refreshes.</p>{!MARKETPLACE_CONFIG.enabled && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Test deployment pending. No production marketplace contract is configured.</p>}<div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(120px, .6fr)", gap: 14, opacity: MARKETPLACE_CONFIG.enabled ? 1 : .55 }}><div><label htmlFor="purchase-listing" style={field}>LISTING ID</label><input id="purchase-listing" value={listingId} onChange={(event) => setListingId(event.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 1" style={field} /></div><div><label htmlFor="purchase-quantity" style={field}>QUANTITY</label><input id="purchase-quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} style={field} /></div></div><div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}><Btn onClick={load} disabled={!MARKETPLACE_CONFIG.enabled || state === PURCHASE_STATE.PENDING}>LOAD LISTING</Btn>{listing && <Btn onClick={collect} disabled={disabled || listing.status !== LISTING_STATUS.ACTIVE || !wallet.connected}>COLLECT EDITION</Btn>}</div>{listing && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>STATUS {listing.status} · AVAILABLE {listing.amount} · UNIT PRICE {listing.price} · TOTAL {payment || "—"} WEI</p>}<div aria-live="polite" style={{ marginTop: 16, fontFamily: "var(--vc-mono)", fontSize: 10, color: state === PURCHASE_STATE.CONFIRMED ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>{states.map((item, index) => <span key={item} style={{ color: states.indexOf(state) >= index && ![PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) ? "var(--vc-crimson)" : "inherit" }}>{index ? " → " : ""}{item}</span>)}</div>{[PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) && <p style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{state}: {message}</p>}{collected && <div style={{ ...field, marginTop: 20, borderColor: "var(--vc-crimson)" }}><div style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em" }}>YOU COLLECTED</div><h3 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "10px 0" }}>{edition.title}</h3><p style={{ color: "var(--vc-bone-dim)" }}>The asset is reflected in your refreshed collection state.</p></div>}{message && !collected && ![PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{message}</p>}</section>;
}
