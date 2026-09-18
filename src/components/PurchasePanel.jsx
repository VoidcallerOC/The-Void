import { useEffect, useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { LISTING_STATUS, MARKETPLACE_CONFIG, PURCHASE_STATE, requiredPayment, submitPurchase } from "../lib/marketplace.js";
import { createAuthoritativePurchaseIntent, fetchIndexedListings, recordAuthoritativeTransactionSubmission } from "../lib/marketplace-api.js";
import { MARKETPLACE_STATE, formatWeiAsAvax, listingsForEdition, resolveEditionChain, resolveInfrastructureStatus, resolveSecondaryStatus } from "../lib/marketplace-surface.js";

const states = [PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.CONFIRMED];

export function PurchasePanel({ edition }) {
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  const live = infrastructure === MARKETPLACE_STATE.LIVE;
  const chain = useMemo(() => resolveEditionChain(edition), [edition]);
  const [listings, setListings] = useState([]);
  const [listingsState, setListingsState] = useState(live ? "loading" : "idle");
  const [listing, setListing] = useState(null);
  const [quantity, setQuantity] = useState("1");
  const [state, setState] = useState(PURCHASE_STATE.READY);
  const [message, setMessage] = useState("");
  const secondary = resolveSecondaryStatus({ infrastructure, listingsState });
  const editionKey = `${edition.id}:${edition.contractAddress}:${edition.chainId}:${(edition.tokenIds || []).join(",")}`;

  useEffect(() => {
    if (!live || !chain) return undefined;
    const controller = new AbortController();
    fetchIndexedListings({
      chainId: chain.id,
      tokenContractAddress: edition.contractAddress,
      status: "ACTIVE",
      signal: controller.signal,
    })
      .then((rows) => {
        const matches = listingsForEdition(rows, edition);
        setListings(matches);
        setListing(matches[0] || null);
        setListingsState("ready");
        setMessage(matches.length ? "Indexed secondary offers for this edition." : "The live index has no active listings for this edition.");
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setListings([]);
        setListing(null);
        setListingsState("error");
        setMessage(error?.message || "The marketplace index is unavailable.");
      });
    return () => controller.abort();
  }, [live, chain, edition, editionKey]);

  const collect = async () => {
    if (!wallet.connected || !wallet.account) { setMessage("Connect your wallet before collecting."); return; }
    if (!wallet.authenticated) { setMessage("Authenticate your wallet before submitting a purchase."); return; }
    if (!listing) { setMessage("No active indexed listing is available for this edition."); return; }
    try {
      setMessage("Creating a purchase intent and verifying the indexed listing, quantity, and payment in your wallet…");
      await createAuthoritativePurchaseIntent({ listing, wallet: wallet.account, quantity: Number(quantity), marketplaceAddress: MARKETPLACE_CONFIG.address, authHeaders: wallet.authHeaders });
      const submitted = await submitPurchase({ provider: wallet.getProvider(), buyer: wallet.account, marketplace: MARKETPLACE_CONFIG.address, listing, quantity: Number(quantity), chain, chainId: wallet.chainId, onState: setState });
      await recordAuthoritativeTransactionSubmission({ transactionHash: submitted.txHash, chainId: chain.id, wallet: wallet.account, marketplaceAddress: MARKETPLACE_CONFIG.address, listingId: listing.id, type: "PURCHASE", authHeaders: wallet.authHeaders });
      setState(PURCHASE_STATE.PENDING);
      setMessage("Wallet receipt observed. The purchase remains pending until the backend indexes and confirms the marketplace settlement event.");
    } catch (error) {
      setState(error?.code === "EXPIRED" ? PURCHASE_STATE.EXPIRED : error?.code === 4001 ? PURCHASE_STATE.REJECTED : PURCHASE_STATE.FAILED);
      setMessage(error?.message || "Purchase failed. No collection state was changed.");
    }
  };

  const payment = listing ? requiredPayment(listing, Number(quantity)) : null;
  const disabled = !live || state === PURCHASE_STATE.WALLET_CONFIRMATION || state === PURCHASE_STATE.SUBMITTED || state === PURCHASE_STATE.PENDING;
  return (
    <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>Secondary collection · {edition.title}</div>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600, lineHeight: 1.6 }}>Offers are loaded from the indexed backend for this edition. A wallet receipt only records a pending submission; collection state updates after the authoritative blockchain index confirms settlement.</p>
      {secondary !== MARKETPLACE_STATE.LIVE && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{secondary} · no secondary offers are displayed, and purchase stays disabled.</p>}
      {live && listingsState === "ready" && listings.length === 0 && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>No indexed listings for this edition.</p>}
      {listings.length > 0 && (
        <div style={{ display: "grid", gap: 10, margin: "16px 0" }}>
          {listings.map((item) => (
            <button
              key={item.id || item.listingId}
              onClick={() => { setListing(item); setQuantity("1"); setState(PURCHASE_STATE.READY); }}
              style={{
                textAlign: "left",
                cursor: "pointer",
                border: `1px solid ${listing?.id === item.id ? "var(--vc-crimson)" : "var(--vc-ash)"}`,
                background: "var(--vc-void)",
                color: "var(--vc-bone)",
                padding: "14px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              {item.amount} remaining · {formatWeiAsAvax(item.price) || "Indexed price"} · {item.status}
            </button>
          ))}
        </div>
      )}
      {listing && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, .4fr)", gap: 14, maxWidth: 220 }}>
          <label htmlFor="purchase-quantity" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".1em" }}>QUANTITY
            <input id="purchase-quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} style={{ width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px", marginTop: 6 }} />
          </label>
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
        {listing && <Btn onClick={collect} disabled={disabled || listing.status !== LISTING_STATUS.ACTIVE || !wallet.connected}>COLLECT EDITION</Btn>}
      </div>
      {listing && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>SOURCE {listing.authority} · {listing.status} · AVAILABLE {listing.amount} · {formatWeiAsAvax(listing.price)} · TOTAL {formatWeiAsAvax(payment) || "—"}</p>}
      <div aria-live="polite" style={{ marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>{states.map((item, index) => <span key={item} style={{ color: states.indexOf(state) >= index && ![PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) ? "var(--vc-crimson)" : "inherit" }}>{index ? " → " : ""}{item}</span>)}</div>
      {[PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) && <p style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{state}: {message}</p>}
      {message && ![PURCHASE_STATE.FAILED, PURCHASE_STATE.REJECTED, PURCHASE_STATE.EXPIRED].includes(state) && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{message}</p>}
    </section>
  );
}
