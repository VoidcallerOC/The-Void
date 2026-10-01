import { useMemo, useState } from "react";
import { Btn } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { FUJI_LISTING_CONFIG, LISTING_STATUS, fujiListingTargetError, listingIdFromReceipt, submitApproval, submitCancel, submitListing, validateListingDraft } from "../lib/marketplace.js";
import { fetchAuthoritativeListing, recordAuthoritativeTransactionSubmission } from "../lib/marketplace-api.js";
import { formatWeiAsAvax, parseAvaxToWei, resolveEditionChain } from "../lib/marketplace-surface.js";

const field = { width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px" };

export function ListingPanel({ edition }) {
  const wallet = useWallet();
  const [amount, setAmount] = useState("1");
  const [priceAvax, setPriceAvax] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [stage, setStage] = useState("idle");
  const [message, setMessage] = useState("");
  const [submittedListingId, setSubmittedListingId] = useState(null);
  const chain = useMemo(() => resolveEditionChain(edition), [edition]);
  const tokenId = edition?.tokenIds?.[0];
  const targetError = fujiListingTargetError({
    config: FUJI_LISTING_CONFIG,
    marketplace: FUJI_LISTING_CONFIG.address,
    chain,
    chainId: wallet.chainId,
    editionChainId: edition?.chainId,
    tokenContract: edition?.contractAddress,
  });
  const listingReady = !targetError;
  const owned = listingReady && wallet.connected && tokenId !== undefined
    && Boolean(wallet.owned?.[chain?.key]?.has(Number(tokenId)) || wallet.owned?.[chain?.key]?.has(String(tokenId)));
  const priceWei = parseAvaxToWei(priceAvax);

  const list = async () => {
    if (targetError) { setMessage(targetError); return; }
    const provider = wallet.getProvider();
    if (!provider || !wallet.account) { setMessage("Connect your wallet on Avalanche Fuji before listing."); return; }
    if (!wallet.authenticated) { setMessage("Authenticate your wallet before submitting a listing transaction."); return; }
    if (!priceWei) { setMessage("Enter a native AVAX price."); return; }
    const error = validateListingDraft({ seller: wallet.account, contract: edition.contractAddress, tokenId, amount, price: priceWei, expiresAt: expiresAt ? new Date(expiresAt).getTime() : 0 });
    if (error) { setMessage(error); return; }
    try {
      setStage("approval"); setMessage("Confirm the ERC-1155 approval transaction in your wallet…");
      const approvalReceipt = await submitApproval({ provider, owner: wallet.account, tokenContract: edition.contractAddress, marketplace: FUJI_LISTING_CONFIG.address, chain, chainId: wallet.chainId });
      if (approvalReceipt.status === "0x0") throw new Error("Approval transaction reverted.");
      setStage("listing"); setMessage("Approval confirmed. Confirm the listing transaction in your wallet…");
      const listingReceipt = await submitListing({ provider, owner: wallet.account, edition, marketplace: FUJI_LISTING_CONFIG.address, chain, chainId: wallet.chainId, tokenId, amount, price: priceWei, expiresAt: expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : 0 });
      if (listingReceipt.status === "0x0") throw new Error("Listing transaction reverted.");
      await recordAuthoritativeTransactionSubmission({ transactionHash: listingReceipt.transactionHash, chainId: FUJI_LISTING_CONFIG.chainId, wallet: wallet.account, marketplaceAddress: FUJI_LISTING_CONFIG.address, type: "LISTING", authHeaders: wallet.authHeaders });
      setSubmittedListingId(listingIdFromReceipt(listingReceipt));
      setStage("pending"); setMessage("Listing submitted. It becomes active only after the backend indexes the confirmed marketplace event.");
    } catch (error_) { setStage("error"); setMessage(error_?.message || "Listing failed."); }
  };

  const cancel = async () => {
    if (targetError) { setMessage(targetError); return; }
    if (!submittedListingId) { setMessage("The listing is unavailable. Load the indexed listing before cancellation."); return; }
    if (!wallet.account || !wallet.authenticated) { setMessage("Authenticate your wallet on Avalanche Fuji before submitting a cancellation."); return; }
    try {
      setStage("cancelling"); setMessage("Checking indexed listing state before cancellation…");
      const authoritative = await fetchAuthoritativeListing({ chainId: FUJI_LISTING_CONFIG.chainId, marketplaceAddress: FUJI_LISTING_CONFIG.address, listingId: submittedListingId });
      if (authoritative.status !== LISTING_STATUS.ACTIVE || authoritative.seller.toLowerCase() !== wallet.account.toLowerCase()) throw new Error("The authoritative listing is not an active listing owned by this wallet.");
      setMessage("Confirm the cancellation transaction in your wallet…");
      const receipt = await submitCancel({ provider: wallet.getProvider(), owner: wallet.account, marketplace: FUJI_LISTING_CONFIG.address, listingId: authoritative.listingId, chain, chainId: wallet.chainId });
      if (receipt.status === "0x0") throw new Error("Cancellation transaction reverted.");
      await recordAuthoritativeTransactionSubmission({ transactionHash: receipt.transactionHash, chainId: FUJI_LISTING_CONFIG.chainId, wallet: wallet.account, marketplaceAddress: FUJI_LISTING_CONFIG.address, type: "LISTING_CANCEL", authHeaders: wallet.authHeaders });
      setStage("pending"); setMessage("Cancellation submitted. The listing remains visible until the backend indexes the confirmed cancellation event.");
    } catch (error_) { setStage("error"); setMessage(error_?.message || "Cancellation failed."); }
  };

  return (
    <section style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>Secondary collection · list {edition.title}</div>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 560, lineHeight: 1.6 }}>Owners keep the edition in wallet. A wallet receipt is only a submission signal; the listing becomes visible after the backend indexes a confirmed marketplace event.</p>
      {!listingReady && <p role="alert" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{targetError} No alternate marketplace or chain will be used.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, opacity: listingReady ? 1 : 0.55 }}>
        <div>
          <label htmlFor="listing-amount">QUANTITY</label>
          <input id="listing-amount" type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} style={field} disabled={!listingReady} />
        </div>
        <div>
          <label htmlFor="listing-price">PRICE · AVAX</label>
          <input id="listing-price" inputMode="decimal" value={priceAvax} onChange={(event) => setPriceAvax(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.01" style={field} disabled={!listingReady} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>{priceWei ? formatWeiAsAvax(priceWei) : "Native AVAX only"}</span>
        </div>
        <div>
          <label htmlFor="listing-expiry">EXPIRATION</label>
          <input id="listing-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} style={field} disabled={!listingReady} />
        </div>
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <Btn onClick={list} disabled={stage === "approval" || stage === "listing" || stage === "cancelling" || !owned || !listingReady}>{stage === "approval" ? "APPROVING…" : stage === "listing" ? "CREATING LISTING…" : "LIST EDITION"}</Btn>
        {submittedListingId && <button onClick={cancel} disabled={!listingReady} style={{ ...field, width: "auto", cursor: listingReady ? "pointer" : "not-allowed" }}>CANCEL INDEXED LISTING</button>}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: stage === "pending" ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>{targetError || (!owned && wallet.connected ? "Connect an owned canonical Fuji edition to list it." : message)}</span>
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
