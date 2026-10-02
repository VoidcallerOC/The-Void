import { useEffect, useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { LISTING_STATUS, MARKETPLACE_CONFIG, PURCHASE_STATE, requiredPayment, submitPurchase } from "../lib/marketplace.js";
import {
  classifyAuthoritativePurchaseTransaction,
  createAuthoritativePurchaseIntent,
  fetchAuthoritativeListing,
  fetchAuthoritativeMarketplaceTransaction,
  fetchIndexedListings,
  recordAuthoritativeTransactionSubmission,
} from "../lib/marketplace-api.js";
import { MARKETPLACE_STATE, formatWeiAsAvax, listingsForEdition, resolveEditionChain, resolveInfrastructureStatus, resolveSecondaryStatus } from "../lib/marketplace-surface.js";

const states = [PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.CONFIRMED];
const failureStates = new Set([
  PURCHASE_STATE.FAILED,
  PURCHASE_STATE.REJECTED,
  PURCHASE_STATE.EXPIRED,
  PURCHASE_STATE.REVERTED,
  PURCHASE_STATE.REPLACED,
  PURCHASE_STATE.STALE,
  PURCHASE_STATE.RECONCILIATION_REQUIRED,
]);
const nextPollDelay = (attempt) => Math.min(1500 * (2 ** Math.min(attempt, 4)), 15000);

export function PurchasePanel({ edition }) {
  const wallet = useWallet();
  const walletAccount = wallet.account;
  const refreshOwnership = wallet.refreshOwnership;
  const infrastructure = resolveInfrastructureStatus();
  const live = infrastructure === MARKETPLACE_STATE.LIVE;
  const chain = useMemo(() => resolveEditionChain(edition), [edition]);
  const [listings, setListings] = useState([]);
  const [listingsState, setListingsState] = useState(live ? "loading" : "idle");
  const [listing, setListing] = useState(null);
  const [quantity, setQuantity] = useState("1");
  const [state, setState] = useState(PURCHASE_STATE.READY);
  const [message, setMessage] = useState("");
  const [pendingPurchase, setPendingPurchase] = useState(null);
  const secondary = resolveSecondaryStatus({ infrastructure, listingsState });
  const editionKey = `${edition.id}:${edition.contractAddress}:${edition.chainId}:${(edition.tokenIds || []).join(",")}`;

  useEffect(() => {
    if (!live || !chain) return undefined;
    const controller = new AbortController();
    fetchIndexedListings({
      chainId: chain.id,
      marketplaceAddress: MARKETPLACE_CONFIG.address,
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
    if (!listing || listing.status !== LISTING_STATUS.ACTIVE) { setMessage("No active indexed listing is available for this edition."); return; }
    const selectedListing = { ...listing };
    const marketplaceTarget = selectedListing.marketplace || MARKETPLACE_CONFIG.address;
    const selectedQuantity = Number(quantity);
    const payment = requiredPayment(selectedListing, selectedQuantity);
    let submitted = null;
    setPendingPurchase(null);
    try {
      setMessage("Creating a purchase intent and verifying the indexed listing, quantity, and payment in your wallet…");
      await createAuthoritativePurchaseIntent({ listing: selectedListing, wallet: wallet.account, quantity: selectedQuantity, marketplaceAddress: marketplaceTarget, authHeaders: wallet.authHeaders });
      submitted = await submitPurchase({
        provider: wallet.getProvider(),
        buyer: wallet.account,
        marketplace: marketplaceTarget,
        listing: selectedListing,
        quantity: selectedQuantity,
        chain,
        chainId: wallet.chainId,
        onState: (nextState) => {
          // A wallet receipt is only observed locally. Only the authoritative
          // marketplace transaction endpoint may move PENDING to CONFIRMED.
          if (nextState === PURCHASE_STATE.CONFIRMED || nextState === PURCHASE_STATE.OBSERVED) return;
          setState(nextState);
        },
      });
      setMessage("Wallet receipt observed. Recording the submission; settlement is not yet confirmed by the marketplace index.");
      await recordAuthoritativeTransactionSubmission({ transactionHash: submitted.txHash, chainId: chain.id, wallet: wallet.account, marketplaceAddress: marketplaceTarget, listingId: selectedListing.id, type: "PURCHASE", authHeaders: wallet.authHeaders });
      setPendingPurchase({
        transactionHash: submitted.txHash,
        chainId: chain.id,
        marketplaceAddress: marketplaceTarget,
        buyer: wallet.account,
        listing: selectedListing,
        quantity: selectedQuantity,
        payment,
      });
      setState(PURCHASE_STATE.PENDING);
      setMessage("Purchase submitted. Waiting for the authoritative index to confirm marketplace settlement.");
    } catch (error) {
      if (submitted?.txHash) {
        setPendingPurchase({
          transactionHash: submitted.txHash,
          chainId: chain.id,
          marketplaceAddress: marketplaceTarget,
          buyer: wallet.account,
          listing: selectedListing,
          quantity: selectedQuantity,
          payment,
        });
        setState(PURCHASE_STATE.RECONCILIATION_REQUIRED);
        setMessage(`Wallet receipt observed for ${submitted.txHash}, but the submission could not be recorded. Do not submit again; this transaction requires backend reconciliation.`);
        return;
      }
      setState(error?.code === "EXPIRED" ? PURCHASE_STATE.EXPIRED : error?.code === 4001 ? PURCHASE_STATE.REJECTED : PURCHASE_STATE.FAILED);
      setMessage(error?.message || "Purchase failed. No collection state was changed.");
    }
  };

  useEffect(() => {
    if (state !== PURCHASE_STATE.PENDING || !pendingPurchase) return undefined;
    let cancelled = false;
    let timer = null;
    let controller = null;
    let attempt = 0;

    const poll = async () => {
      if (cancelled) return;
      controller = new AbortController();
      try {
        const transaction = await fetchAuthoritativeMarketplaceTransaction({
          chainId: pendingPurchase.chainId,
          transactionHash: pendingPurchase.transactionHash,
          signal: controller.signal,
        });
        if (cancelled) return;
        const outcome = classifyAuthoritativePurchaseTransaction(transaction, {
          chainId: pendingPurchase.chainId,
          transactionHash: pendingPurchase.transactionHash,
          buyer: pendingPurchase.buyer,
          marketplaceAddress: pendingPurchase.marketplaceAddress,
          listingId: pendingPurchase.listing.id,
          quantity: pendingPurchase.quantity,
          payment: pendingPurchase.payment,
        });
        if (outcome) {
          setMessage(outcome.message);
          setState(outcome.state);
          if (outcome.state !== PURCHASE_STATE.CONFIRMED) setPendingPurchase(null);
          return;
        }
      } catch (error) {
        if (cancelled || error?.name === "AbortError") return;
        setMessage("The authoritative index has not confirmed settlement yet; this page will keep checking automatically.");
      }
      if (cancelled) return;
      timer = setTimeout(poll, nextPollDelay(attempt));
      attempt += 1;
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    };
  }, [state, pendingPurchase]);

  useEffect(() => {
    if (state !== PURCHASE_STATE.CONFIRMED || !pendingPurchase) return undefined;
    const controller = new AbortController();
    let active = true;

    const refreshIndexedState = async () => {
      const [activeResult, soldResult] = await Promise.allSettled([
        fetchIndexedListings({
          chainId: pendingPurchase.chainId,
          marketplaceAddress: pendingPurchase.marketplaceAddress,
          tokenContractAddress: edition.contractAddress,
          status: "ACTIVE",
          signal: controller.signal,
        }),
        fetchAuthoritativeListing({
          chainId: pendingPurchase.chainId,
          marketplaceAddress: pendingPurchase.marketplaceAddress,
          listingId: pendingPurchase.listing.listingId,
          signal: controller.signal,
        }),
      ]);
      if (!active) return;

      let refreshedListings = false;
      let refreshedSoldListing = false;
      if (activeResult.status === "fulfilled") {
        setListings(listingsForEdition(activeResult.value, edition));
        setListingsState("ready");
        refreshedListings = true;
      }
      if (soldResult.status === "fulfilled") {
        setListing(soldResult.value);
        refreshedSoldListing = soldResult.value.status === LISTING_STATUS.SOLD && String(soldResult.value.amount) === "0";
      }

      if (walletAccount?.toLowerCase() === pendingPurchase.buyer.toLowerCase() && typeof refreshOwnership === "function") {
        try { await refreshOwnership(pendingPurchase.buyer); } catch { /* Settlement remains confirmed by the API even if an RPC balance refresh fails. */ }
      }
      if (!active) return;
      setMessage(refreshedListings && refreshedSoldListing
        ? "Purchase confirmed by the marketplace index. Listing is SOLD with zero remaining; wallet ownership was refreshed where supported."
        : "Purchase confirmed by the marketplace index. Some indexed display data could not be refreshed; no additional transaction was sent.");
      window.dispatchEvent(new Event("void:marketplace-volume-updated"));
    };

    void refreshIndexedState();
    return () => {
      active = false;
      controller.abort();
    };
  }, [state, pendingPurchase, edition, editionKey, walletAccount, refreshOwnership]);

  const payment = listing ? requiredPayment(listing, Number(quantity)) : null;
  const busy = [PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING].includes(state);
  const disabled = !live || busy || state === PURCHASE_STATE.CONFIRMED;
  return (
    <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>Secondary collection · {edition.title}</div>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600, lineHeight: 1.6 }}>Offers are loaded from the indexed backend for this edition. A wallet receipt only records a pending submission; collection state updates after the authoritative blockchain index confirms settlement.</p>
      {secondary !== MARKETPLACE_STATE.LIVE && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{secondary} · no secondary offers are displayed, and purchase stays disabled.</p>}
      {live && listingsState === "ready" && listings.length === 0 && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>No active indexed listings for this edition.</p>}
      {listings.length > 0 && (
        <div style={{ display: "grid", gap: 10, margin: "16px 0" }}>
          {listings.map((item) => (
            <button
              key={item.id || item.listingId}
              disabled={busy || (state === PURCHASE_STATE.CONFIRMED && pendingPurchase?.listing.id === item.id)}
              onClick={() => { setListing(item); setQuantity("1"); setPendingPurchase(null); setState(PURCHASE_STATE.READY); }}
              style={{
                textAlign: "left",
                cursor: busy || (state === PURCHASE_STATE.CONFIRMED && pendingPurchase?.listing.id === item.id) ? "not-allowed" : "pointer",
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
            <input id="purchase-quantity" type="number" min="1" step="1" value={quantity} disabled={disabled || listing.status !== LISTING_STATUS.ACTIVE} onChange={(event) => setQuantity(event.target.value)} style={{ width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px", marginTop: 6 }} />
          </label>
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
        {listing && <Btn onClick={collect} disabled={disabled || listing.status !== LISTING_STATUS.ACTIVE || !wallet.connected}>COLLECT EDITION</Btn>}
      </div>
      {listing && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>SOURCE {listing.authority} · {listing.status} · AVAILABLE {listing.amount} · {formatWeiAsAvax(listing.price)} · TOTAL {formatWeiAsAvax(payment) || "—"}</p>}
      <div aria-live="polite" style={{ marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>{states.map((item, index) => <span key={item} style={{ color: states.indexOf(state) >= index && !failureStates.has(state) ? "var(--vc-crimson)" : "inherit" }}>{index ? " → " : ""}{item}</span>)}</div>
      {failureStates.has(state) && <p style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{state}: {message}</p>}
      {message && !failureStates.has(state) && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{message}</p>}
    </section>
  );
}
