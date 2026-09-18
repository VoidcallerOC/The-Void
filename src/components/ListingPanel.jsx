import { useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { LISTING_STATUS, MARKETPLACE_CONFIG, listingIdFromReceipt, submitApproval, submitCancel, submitListing, validateListingDraft } from "../lib/marketplace.js";
import { fetchAuthoritativeListing, recordAuthoritativeTransactionSubmission } from "../lib/marketplace-api.js";
import { MARKETPLACE_STATE, formatWeiAsAvax, parseAvaxToWei, resolveEditionChain, resolveInfrastructureStatus } from "../lib/marketplace-surface.js";

const field = { width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px" };

export function ListingPanel({ edition }) {
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  const live = infrastructure === MARKETPLACE_STATE.LIVE;
  const [amount, setAmount] = useState("1");
  const [priceAvax, setPriceAvax] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [stage, setStage] = useState("idle");
  const [message, setMessage] = useState("");
  const [submittedListingId, setSubmittedListingId] = useState(null);
  const chain = useMemo(() => resolveEditionChain(edition), [edition]);
  const tokenId = edition.tokenIds[0];
  const owned = wallet.connected && Boolean(wallet.owned?.[chain?.key]?.has(Number(tokenId)) || wallet.owned?.[chain?.key]?.has(String(tokenId)));
  const priceWei = parseAvaxToWei(priceAvax);

  const list = async () => {
    const provider = wallet.getProvider();
    if (!provider || !wallet.account) { setMessage("Connect your wallet before listing."); return; }
    if (!wallet.authenticated) { setMessage("Authenticate your wallet before submitting a listing transaction."); return; }
    if (!live || !MARKETPLACE_CONFIG.address) { setMessage("Marketplace listing is awaiting a reviewed test-network deployment."); return; }
    if (!chain) { setMessage("This edition is not attached to a supported collection chain."); return; }
    if (!priceWei) { setMessage("Enter a native AVAX price."); return; }
    const error = validateListingDraft({ seller: wallet.account, contract: edition.contractAddress, tokenId, amount, price: priceWei, expiresAt: expiresAt ? new Date(expiresAt).getTime() : 0 });
    if (error) { setMessage(error); return; }
    try {
      setStage("approval"); setMessage("Confirm the ERC-1155 approval transaction in your wallet…");
      const approvalReceipt = await submitApproval({ provider, owner: wallet.account, tokenContract: edition.contractAddress, marketplace: MARKETPLACE_CONFIG.address, chain, chainId: wallet.chainId });
      if (approvalReceipt.status === "0x0") throw new Error("Approval transaction reverted.");
      setStage("listing"); setMessage("Approval confirmed. Confirm the listing transaction in your wallet…");
      const listingReceipt = await submitListing({ provider, owner: wallet.account, edition, marketplace: MARKETPLACE_CONFIG.address, chain, chainId: wallet.chainId, tokenId, amount, price: priceWei, expiresAt: expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : 0 });
      if (listingReceipt.status === "0x0") throw new Error("Listing transaction reverted.");
      await recordAuthoritativeTransactionSubmission({ transactionHash: listingReceipt.transactionHash, chainId: chain.id, wallet: wallet.account, marketplaceAddress: MARKETPLACE_CONFIG.address, type: "LISTING", authHeaders: wallet.authHeaders });
      setSubmittedListingId(listingIdFromReceipt(listingReceipt));
      setStage("pending"); setMessage("Listing submitted. It becomes active only after the backend indexes the confirmed marketplace event.");
    } catch (error_) { setStage("error"); setMessage(error_?.message || "Listing failed."); }
  };

  const cancel = async () => {
    if (!submittedListingId) { setMessage("The listing is unavailable. Load the indexed listing before cancellation."); return; }
    if (!wallet.authenticated) { setMessage("Authenticate your wallet before submitting a cancellation."); return; }
    try {
      setStage("cancelling"); setMessage("Checking indexed listing state before cancellation…");
      const authoritative = await fetchAuthoritativeListing({ chainId: chain.id, marketplaceAddress: MARKETPLACE_CONFIG.address, listingId: submittedListingId });
      if (authoritative.status !== LISTING_STATUS.ACTIVE || authoritative.seller.toLowerCase() !== wallet.account.toLowerCase()) throw new Error("The authoritative listing is not an active listing owned by this wallet.");
      setMessage("Confirm the cancellation transaction in your wallet…");
      const receipt = await submitCancel({ provider: wallet.getProvider(), owner: wallet.account, marketplace: MARKETPLACE_CONFIG.address, listingId: authoritative.listingId });
      if (receipt.status === "0x0") throw new Error("Cancellation transaction reverted.");
      await recordAuthoritativeTransactionSubmission({ transactionHash: receipt.transactionHash, chainId: chain.id, wallet: wallet.account, marketplaceAddress: MARKETPLACE_CONFIG.address, type: "LISTING_CANCEL", authHeaders: wallet.authHeaders });
      setStage("pending"); setMessage("Cancellation submitted. The listing remains visible until the backend indexes the confirmed cancellation event.");
    } catch (error_) { setStage("error"); setMessage(error_?.message || "Cancellation failed."); }
  };

  return (
    <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>Secondary collection · list {edition.title}</div>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 560, lineHeight: 1.6 }}>Owners keep the edition in wallet. A wallet receipt is only a submission signal; the listing becomes visible after the backend indexes a confirmed marketplace event.</p>
      {!live && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>IMPLEMENTED / NOT LIVE · no reviewed marketplace contract is configured. Listing stays disabled so this cannot be mistaken for live trading.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, opacity: live ? 1 : 0.55 }}>
        <div>
          <label htmlFor="listing-amount">QUANTITY</label>
          <input id="listing-amount" type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} style={field} disabled={!live} />
        </div>
        <div>
          <label htmlFor="listing-price">PRICE · AVAX</label>
          <input id="listing-price" inputMode="decimal" value={priceAvax} onChange={(event) => setPriceAvax(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.01" style={field} disabled={!live} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>{priceWei ? formatWeiAsAvax(priceWei) : "Native AVAX only"}</span>
        </div>
        <div>
          <label htmlFor="listing-expiry">EXPIRATION</label>
          <input id="listing-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} style={field} disabled={!live} />
        </div>
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <Btn onClick={list} disabled={stage === "approval" || stage === "listing" || stage === "cancelling" || !owned || !live}>{stage === "approval" ? "APPROVING…" : stage === "listing" ? "CREATING LISTING…" : "LIST EDITION"}</Btn>
        {submittedListingId && <button onClick={cancel} style={{ ...field, width: "auto", cursor: "pointer" }}>CANCEL INDEXED LISTING</button>}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: stage === "pending" ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>{!owned && wallet.connected ? "Connect an owned edition to list it." : message}</span>
      </div>
      <div aria-live="polite" style={{ marginTop: 16, display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>
        <span style={{ color: stage !== "idle" ? "var(--vc-crimson)" : "inherit" }}>1. WALLET</span>
        <span>→</span>
        <span style={{ color: stage === "listing" || stage === "pending" || stage === "cancelling" ? "var(--vc-crimson)" : "inherit" }}>2. APPROVAL</span>
        <span>→</span>
        <span style={{ color: stage === "pending" ? "var(--vc-crimson)" : "inherit" }}>3. INDEXED CONFIRMATION</span>
      </div>
    </section>
  );
}
