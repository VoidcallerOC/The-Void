import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { requestedTokenId } from "../lib/asset-actions.js";
import { Btn } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import {
  LISTING_STATUS,
  MARKETPLACE_CONFIG,
  marketplaceConfigForEdition,
  submitApproval,
  submitCancel,
  submitListing,
  validateListingDraft,
  verifyCancelReceipt,
  verifyListingReceipt,
} from "../lib/marketplace.js";
import {
  classifyAuthoritativeCancellationTransaction,
  classifyAuthoritativeListingTransaction,
  fetchAuthoritativeListing,
  fetchAuthoritativeMarketplaceTransaction,
  fetchIndexedListings,
  recordAuthoritativeTransactionSubmission,
} from "../lib/marketplace-api.js";
import { MARKETPLACE_STATE, formatWeiAsAvax, parseAvaxToWei, resolveInfrastructureStatus } from "../lib/marketplace-surface.js";
import { RELEASE_DEPLOYMENT, RELEASE_PER_CONTRACT, releaseDeploymentForMarketplace } from "../../config/release-network.js";
import { isLegacyMarketplace } from "../../config/legacy-collection-marketplace.js";
import { isActiveUnifiedMarketplace, retainedUnifiedMarketplacesFor } from "../../config/unified-marketplace.js";
import { readReleaseListingContext, isReleasePerContractCandidate, calculateListingEconomics, sellerFloorTerms, genesisTokenChoices, readOwnedTokenIds } from "../lib/secondary-listing.js";
import { ensureReleaseChain, releaseChainDescriptor, releaseNetworkRequiredMessage, releaseNetworkSwitchAllowed, releaseNetworkSwitchLabel } from "../lib/release-chain.js";

const field = { width: "100%", boxSizing: "border-box", background: "var(--vc-void)", border: "1px solid var(--vc-ash)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 12, padding: "11px 12px" };
const pollDelay = (attempt) => Math.min(1500 * (2 ** Math.min(attempt, 4)), 15000);
const activeStatus = (value) => String(value || "").toUpperCase() === LISTING_STATUS.ACTIVE;
const sameAddress = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();

function bpsLabel(value) {
  const bps = Number(value);
  if (!Number.isFinite(bps)) return "Unavailable";
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;
}

function errorState(error) {
  if (error?.code === "WRONG_NETWORK") return "wrong-network";
  if (error?.code === "NOT_OWNER") return "not-owner";
  if (error?.code === "ACTIVE_LISTING_EXISTS") return "already-listed";
  if (error?.code === "UNSUPPORTED_RELEASE") return "unsupported";
  if (["MARKETPLACE_UNAVAILABLE", "MARKETPLACE_REQUEST_FAILED", "OWNERSHIP_READ_FAILED", "INVALID_ECONOMICS"].includes(error?.code)) return "unavailable";
  return "error";
}

// A retained unified marketplace keeps settling the listings it already holds, so this asset's existing listing may be
// there; new listings are only ever created on the active marketplace. Empty unless one is recorded.
function retainedListingMarketplaces(edition, marketplaceAddress, tokenId) {
  if (!isActiveUnifiedMarketplace(marketplaceAddress)) return [];
  return retainedUnifiedMarketplacesFor({ chainId: edition?.chainId, contractAddress: edition?.contractAddress, tokenId, factoryAddress: edition?.factoryAddress }).map((entry) => entry.marketplaceAddress);
}

function eventListingMatchesAsset(listing, { chainId, marketplaceAddress, contract, tokenId, seller }) {
  return listing
    && Number(listing.chain) === Number(chainId)
    && sameAddress(listing.marketplace, marketplaceAddress)
    && sameAddress(listing.tokenContract, contract)
    && String(listing.tokenId) === String(tokenId)
    && sameAddress(listing.seller, seller)
    && listing.authority === "INDEXED"
    && activeStatus(listing.status);
}

function statusCopy(stage, message) {
  if (message) return message;
  const copy = {
    checking: "Verifying the factory release, wallet balance, marketplace and royalty on chain…",
    ready: "Ownership and release registration verified on chain.",
    listed: "The authoritative marketplace index confirms this edition is listed.",
    "already-listed": "An active listing already exists for this exact contract and token. A second listing will not be created.",
    "not-owner": "This wallet no longer owns the selected edition on chain. Refresh the page after verifying your wallet.",
    "no-token": "This wallet holds none of this collection's listable tokens on chain. New listings are unavailable.",
    "select-token": "This wallet holds more than one of these tokens. Choose the token to list.",
    "requested-not-held": "The token you chose to list is not held by this wallet on chain. Nothing was selected for you; choose a token this wallet holds.",
    unsupported: `Only a release-per-contract edition on ${RELEASE_DEPLOYMENT.networkName} registered by The-Void’s canonical factory can be listed here. This edition is unsupported; no transaction can be submitted.`,
    unavailable: "Marketplace or ownership verification is unavailable. No listing action was taken.",
    "wrong-network": releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "list this release" }),
    disconnected: "Connect a wallet to verify ownership and list this edition.",
    "reconciliation-required": "A wallet receipt was observed, but authoritative confirmation is incomplete. Do not submit again; reconciliation is required.",
    error: "The listing could not be completed.",
  };
  return copy[stage] || "";
}

export function ListingPanel({ edition }) {
  const wallet = useWallet();
  const infrastructure = resolveInfrastructureStatus();
  // The edition's own factory decides its marketplace (historical clones keep trading on theirs);
  // an edition without a recorded factory keeps the configured release marketplace.
  const marketplace = useMemo(() => marketplaceConfigForEdition(edition, MARKETPLACE_CONFIG), [edition]);
  const deployment = releaseDeploymentForMarketplace(marketplace.address);
  const legacyMarketplace = isLegacyMarketplace(marketplace.address);
  const canonicalMarketplace = legacyMarketplace ? marketplace.address : deployment?.marketplaceAddress || RELEASE_PER_CONTRACT.marketplaceAddress;
  const canonicalChainId = Number(RELEASE_PER_CONTRACT.chainId);
  const candidate = isReleasePerContractCandidate(edition);
  const marketplaceConfigured = infrastructure === MARKETPLACE_STATE.LIVE
    && Number(marketplace.chainId) === canonicalChainId
    && sameAddress(marketplace.address, canonicalMarketplace);
  // A multi-token catalog entry (Genesis ids 0-3) lists one exact token the wallet holds, never a representative id.
  const tokenChoices = useMemo(() => genesisTokenChoices(edition), [edition]);
  const [ownedTokens, setOwnedTokens] = useState({ key: "", ids: null, message: "" });
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const ownershipKey = `${String(edition?.contractAddress || "").toLowerCase()}:${String(wallet.account || "").toLowerCase()}:${Number(wallet.chainId || 0)}`;
  const ownedIds = tokenChoices && ownedTokens.key === ownershipKey ? ownedTokens.ids : null;
  // A listing link from a token card (?token=N) preselects that token, but only once the wallet is verified to hold it.
  const requested = requestedTokenId(useLocation().search);
  const [changingToken, setChangingToken] = useState(false);
  const tokenChoicesRef = useRef(null);
  // "Change token" reveals the choices and moves keyboard focus to the checked one.
  useEffect(() => {
    const choices = tokenChoicesRef.current;
    if (changingToken && choices) (choices.querySelector("input:checked") || choices.querySelector("input"))?.focus();
  }, [changingToken]);
  // A requested token is used only when the wallet is verified to hold it. An unheld request never falls back to another
  // token: the user must choose explicitly.
  const requestedHeld = Boolean(requested && ownedIds?.includes(requested));
  const requestedNotHeld = Boolean(requested && ownedIds && !ownedIds.includes(requested));
  const tokenId = tokenChoices
    ? (selectedTokenId && ownedIds?.includes(selectedTokenId)
      ? selectedTokenId
      : requestedHeld
        ? requested
        : !requestedNotHeld && ownedIds?.length === 1 ? ownedIds[0] : "")
    : String(edition?.tokenIds?.[0] ?? "");
  const contract = String(edition?.contractAddress || "");
  const provider = wallet.provider;
  const assetKey = `${Number(edition?.chainId)}:${contract.toLowerCase()}:${tokenId}`;
  const verificationKey = `${assetKey}:${String(wallet.account || "").toLowerCase()}:${Number(wallet.chainId || 0)}:${marketplaceConfigured}`;
  const wrongNetwork = wallet.connected && Number(wallet.chainId) !== canonicalChainId;
  const [session, setSession] = useState({ key: "", stage: "idle" });
  const [amount, setAmount] = useState("1");
  const [priceAvax, setPriceAvax] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reviewKey, setReviewKey] = useState("");
  // Why REVIEW LISTING did not advance, shown next to the button (the panel status line sits above the form, often off-screen on mobile).
  const [draftError, setDraftError] = useState("");
  const draftErrorRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [retry, setRetry] = useState(0);
  const chainState = session.key === verificationKey ? session : null;
  const stage = pending?.assetKey === assetKey
    ? "pending"
    : !candidate
      ? "unsupported"
      : !marketplaceConfigured
        ? "unavailable"
        : !wallet.connected
          ? "disconnected"
          : wrongNetwork
            ? "wrong-network"
            : tokenChoices && ownedTokens.key === ownershipKey && ownedTokens.message
              ? "unavailable"
              : tokenChoices && !ownedIds
                ? "checking"
                : tokenChoices && ownedIds.length === 0
                  ? "no-token"
                  : tokenChoices && !tokenId
                    ? (requestedNotHeld ? "requested-not-held" : "select-token")
                    : chainState?.stage || "checking";
  const context = chainState?.context || null;
  const currentListing = chainState?.listing || (pending?.assetKey === assetKey ? pending.listing : null);
  const priceWei = parseAvaxToWei(priceAvax);
  const economics = context && priceWei
    ? calculateListingEconomics({ priceWei, amount, marketplaceFeeBps: context.marketplaceFeeBps, royaltyBps: context.royaltyBps })
    : null;
  // LegacyCollectionMarketplace only: the minimum the seller will accept, derived from the fee and royalty they reviewed. Zero tolerance:
  // any royalty increase after listing makes a purchase revert instead of paying the seller less.
  const sellerFloor = legacyMarketplace && context && priceWei ? sellerFloorTerms({ priceWei, amount, marketplaceFeeBps: context.marketplaceFeeBps, royaltyBps: context.royaltyBps }) : null;
  const busy = ["approval", "listing", "cancelling", "pending"].includes(stage);
  const canReview = stage === "ready" && Boolean(wallet.authenticated) && Boolean(context) && !busy;
  const inputDisabled = stage !== "ready" || busy || !wallet.authenticated;
  const reviewing = reviewKey === verificationKey;
  const expiringSeconds = expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : 0;
  const message = (stage === "unavailable" && tokenChoices && ownedTokens.message) || chainState?.message || statusCopy(stage);

  useEffect(() => {
    if (!tokenChoices || !candidate || !marketplaceConfigured || !wallet.connected || !wallet.account || wrongNetwork) return undefined;
    let active = true;
    readOwnedTokenIds({ provider, tokenContractAddress: contract, owner: wallet.account, tokenIds: tokenChoices })
      .then((ids) => { if (active) setOwnedTokens({ key: ownershipKey, ids, message: "" }); })
      .catch((error) => { if (active) setOwnedTokens({ key: ownershipKey, ids: null, message: error?.message || statusCopy("unavailable") }); });
    return () => { active = false; };
  }, [tokenChoices, candidate, marketplaceConfigured, wallet.connected, wallet.account, wrongNetwork, provider, contract, ownershipKey, retry]);

  useEffect(() => {
    if (!candidate || !marketplaceConfigured || !wallet.connected || !wallet.account || wrongNetwork || !tokenId) return undefined;
    const controller = new AbortController();
    let active = true;
    Promise.resolve().then(async () => {
      setSession({ key: verificationKey, stage: "checking", message: statusCopy("checking") });
      try {
        const verified = await readReleaseListingContext({
          provider,
          marketplaceAddress: marketplace.address,
          marketplaceChainId: marketplace.chainId,
          releaseContractAddress: contract,
          tokenId,
          seller: wallet.account,
        });
        if (!active) return;
        const searched = [canonicalMarketplace, ...retainedListingMarketplaces(edition, marketplace.address, tokenId)];
        const listings = (await Promise.all(searched.map((marketplaceAddress) => fetchIndexedListings({
          chainId: canonicalChainId,
          marketplaceAddress,
          tokenContractAddress: contract,
          tokenId,
          sellerWallet: wallet.account,
          status: "ACTIVE",
          signal: controller.signal,
        })))).flat();
        if (!active) return;
        const existing = listings.find((item) => searched.some((marketplaceAddress) => eventListingMatchesAsset(item, {
          chainId: canonicalChainId,
          marketplaceAddress,
          contract,
          tokenId,
          seller: wallet.account,
        })));
        if (existing) {
          setSession({ key: verificationKey, stage: "listed", context: verified, listing: existing, message: statusCopy("listed") });
          return;
        }
        if (BigInt(verified.balance) <= 0n) {
          setSession({ key: verificationKey, stage: "not-owner", context: verified, listing: null, message: statusCopy("not-owner") });
          return;
        }
        setSession({ key: verificationKey, stage: "ready", context: verified, listing: null, message: statusCopy("ready") });
      } catch (error) {
        if (!active || error?.name === "AbortError") return;
        const nextStage = errorState(error);
        setSession({ key: verificationKey, stage: nextStage, errorCode: error?.code || "", message: error?.message || statusCopy(nextStage) });
      }
    });
    return () => { active = false; controller.abort(); };
  }, [candidate, marketplaceConfigured, verificationKey, wallet.connected, wallet.account, wrongNetwork, contract, tokenId, retry, canonicalChainId, canonicalMarketplace, marketplace.address, marketplace.chainId, provider, edition]);

  useEffect(() => {
    if (!pending) return undefined;
    let cancelled = false;
    let timer = null;
    let controller = null;
    let attempt = 0;
    const expected = pending.expected;

    const poll = async () => {
      if (cancelled) return;
      controller = new AbortController();
      const [transactionResult, listingResult] = await Promise.allSettled([
        fetchAuthoritativeMarketplaceTransaction({ chainId: expected.chainId, transactionHash: pending.transactionHash, signal: controller.signal }),
        fetchAuthoritativeListing({ chainId: expected.chainId, marketplaceAddress: expected.marketplaceAddress, listingId: expected.listingId, signal: controller.signal }),
      ]);
      if (cancelled) return;
      const transaction = transactionResult.status === "fulfilled" ? transactionResult.value : null;
      const listing = listingResult.status === "fulfilled" ? listingResult.value : null;
      const outcome = pending.kind === "cancel"
        ? transaction && (String(transaction.status).toUpperCase() === "FAILED" || String(transaction.status).toUpperCase() === "REVERTED" || String(transaction.status).toUpperCase() === "REPLACED" || String(transaction.status).toUpperCase() === "STALE" || String(transaction.status).toUpperCase() === "RECONCILIATION_REQUIRED")
          ? classifyAuthoritativeCancellationTransaction(transaction, null, expected)
          : transaction && listing
            ? classifyAuthoritativeCancellationTransaction(transaction, listing, expected)
            : null
        : transaction && (String(transaction.status).toUpperCase() === "FAILED" || String(transaction.status).toUpperCase() === "REVERTED" || String(transaction.status).toUpperCase() === "REPLACED" || String(transaction.status).toUpperCase() === "STALE" || String(transaction.status).toUpperCase() === "REORGED" || String(transaction.status).toUpperCase() === "RECONCILIATION_REQUIRED")
          ? classifyAuthoritativeListingTransaction(transaction, null, expected)
          : transaction && listing
            ? classifyAuthoritativeListingTransaction(transaction, listing, expected)
            : null;

      if (outcome?.state === "LISTED") {
        setPending(null);
        setSession({ key: pending.verificationKey, stage: "listed", context: pending.context, listing: outcome.listing, message: outcome.message });
        return;
      }
      if (outcome?.state === "CANCELLED") {
        setPending(null);
        setSession({ key: pending.verificationKey, stage: "ready", context: pending.context, listing: null, message: outcome.message });
        return;
      }
      if (outcome && outcome.state !== "LISTED" && outcome.state !== "CANCELLED") {
        setPending(null);
        const needsReconciliation = ["REORGED", "RECONCILIATION_REQUIRED"].includes(outcome.state);
        setSession({ key: pending.verificationKey, stage: needsReconciliation ? "reconciliation-required" : "error", context: pending.context, listing: pending.listing, message: outcome.message });
        return;
      }

      if (cancelled) return;
      timer = setTimeout(poll, pollDelay(attempt));
      attempt += 1;
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    };
  }, [pending]);

  const listingDraftError = () => {
    if (!context) return "On-chain ownership has not been verified.";
    if (!wallet.authenticated) return "Authenticate this wallet before submitting a listing.";
    if (!/^\d+$/.test(amount) || BigInt(amount || "0") <= 0n) return "Quantity must be a positive whole number.";
    if (BigInt(amount || "0") > BigInt(context.balance)) return `Quantity exceeds the on-chain balance of ${context.balance}.`;
    if (!priceWei) return "Enter a valid native AVAX price with no more than 18 decimals.";
    if (!economics) return "The current marketplace fee and edition royalty do not leave valid seller proceeds.";
    if (legacyMarketplace && !sellerFloor) return "This price is too low to set a protective minimum payout. Choose a higher price.";
    if (expiresAt && (!Number.isFinite(new Date(expiresAt).getTime()) || expiringSeconds <= Math.floor(Date.now() / 1000))) return "Expiration must be a valid future date and time.";
    return validateListingDraft({ seller: wallet.account, contract, tokenId, amount, price: priceWei, expiresAt: expiresAt ? new Date(expiresAt).getTime() : 0 });
  };

  const refreshActiveListings = async (signal) => {
    const listings = await fetchIndexedListings({
      chainId: canonicalChainId,
      marketplaceAddress: canonicalMarketplace,
      tokenContractAddress: contract,
      tokenId,
      sellerWallet: wallet.account,
      status: "ACTIVE",
      signal,
    });
    return listings.find((item) => eventListingMatchesAsset(item, {
      chainId: canonicalChainId,
      marketplaceAddress: canonicalMarketplace,
      contract,
      tokenId,
      seller: wallet.account,
    })) || null;
  };

  const review = () => {
    const error = listingDraftError();
    if (error) {
      setDraftError(error);
      requestAnimationFrame(() => draftErrorRef.current?.scrollIntoView?.({ block: "nearest" }));
      return;
    }
    setDraftError("");
    setReviewKey(verificationKey);
  };

  const confirmListing = async () => {
    const error = listingDraftError();
    if (error) {
      setSession((prior) => ({ ...prior, key: verificationKey, stage: "ready", message: error }));
      setReviewKey("");
      return;
    }
    const provider = wallet.getProvider();
    // What the seller reviewed is what is signed: the floor and royalty shown at review, never a recomputed one.
    const reviewedFloor = sellerFloor;
    const reviewedRoyaltyBps = context.royaltyBps;
    let receiptObserved = false;
    let observedTransactionHash = "";
    try {
      setReviewKey("");
      setSession({ key: verificationKey, stage: "checking", context, message: "Rechecking the factory, exact token balance, approval and indexed duplicate status before any transaction…" });
      const latest = await readReleaseListingContext({
        provider,
        marketplaceAddress: marketplace.address,
        marketplaceChainId: marketplace.chainId,
        releaseContractAddress: contract,
        tokenId,
        seller: wallet.account,
      });
      if (BigInt(latest.balance) < BigInt(amount)) throw Object.assign(new Error(`The wallet now owns ${latest.balance} of this token; reduce the listing quantity.`), { code: "NOT_OWNER" });
      const duplicate = await refreshActiveListings();
      if (duplicate) throw Object.assign(new Error(sameAddress(duplicate.seller, wallet.account)
        ? "This edition already has an active indexed listing owned by this wallet."
        : "An active indexed listing already exists for this contract and token."), { code: "ACTIVE_LISTING_EXISTS", listing: duplicate });

      if (!latest.approved) {
        setSession({ key: verificationKey, stage: "approval", context: latest, message: "Confirm marketplace approval in your wallet. This gives the configured marketplace operator access to this release contract’s ERC-1155 tokens." });
        const approvalReceipt = await submitApproval({ provider, owner: wallet.account, tokenContract: contract, marketplace: marketplace.address, chain: releaseChainDescriptor(), chainId: wallet.chainId });
        if (BigInt(approvalReceipt?.status ?? 0) !== 1n) throw Object.assign(new Error("Marketplace approval transaction did not succeed."), { code: "APPROVAL_REVERTED" });
      }

      const afterApproval = await readReleaseListingContext({
        provider,
        marketplaceAddress: marketplace.address,
        marketplaceChainId: marketplace.chainId,
        releaseContractAddress: contract,
        tokenId,
        seller: wallet.account,
      });
      if (BigInt(afterApproval.balance) < BigInt(amount)) throw Object.assign(new Error("The wallet no longer holds the selected listing quantity."), { code: "NOT_OWNER" });
      if (!afterApproval.approved) throw Object.assign(new Error("The marketplace approval did not verify on chain. Listing was not sent."), { code: "APPROVAL_NOT_VERIFIED" });
      if (legacyMarketplace && (!reviewedFloor || String(afterApproval.royaltyBps) !== String(reviewedRoyaltyBps))) {
        throw Object.assign(new Error(`The edition royalty changed from ${bpsLabel(reviewedRoyaltyBps)} to ${bpsLabel(afterApproval.royaltyBps)} since you reviewed this listing. Nothing was sent. Review the listing again.`), { code: "ROYALTY_CHANGED" });
      }
      const duplicateAfterApproval = await refreshActiveListings();
      if (duplicateAfterApproval) throw Object.assign(new Error("An active indexed listing appeared while approval was being confirmed. No duplicate listing was sent."), { code: "ACTIVE_LISTING_EXISTS", listing: duplicateAfterApproval });

      setSession({ key: verificationKey, stage: "listing", context: afterApproval, message: "Confirm the listing transaction in your wallet. The edition remains in your wallet; it is not escrowed." });
      const receipt = await submitListing({
        provider,
        owner: wallet.account,
        edition,
        marketplace: marketplace.address,
        chain: releaseChainDescriptor(),
        chainId: wallet.chainId,
        tokenId,
        amount,
        price: priceWei,
        expiresAt: expiringSeconds,
        // Legacy-collection marketplace only: the purchase reverts unless the seller nets at least this per unit.
        minSellerProceedsPerUnit: legacyMarketplace ? reviewedFloor.perUnitWei : undefined,
      });
      receiptObserved = Boolean(receipt);
      observedTransactionHash = String(receipt?.transactionHash || "");
      const verified = verifyListingReceipt(receipt, {
        seller: wallet.account,
        marketplace: marketplace.address,
        contract,
        tokenId,
        amount,
        price: priceWei,
        expiresAt: expiringSeconds,
      });
      const transactionHash = String(receipt.transactionHash || "");
      if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw Object.assign(new Error("Verified listing receipt did not include a usable transaction hash."), { code: "TRANSACTION_HASH_MISSING" });
      const expected = {
        chainId: canonicalChainId,
        transactionHash,
        transactionType: "LISTING_CREATE",
        marketplaceAddress: marketplace.address,
        seller: wallet.account,
        listingId: verified.listingId,
        contract,
        tokenId,
        amount: String(amount),
        price: String(priceWei),
      };
      setPending({ kind: "create", transactionHash, expected, assetKey, verificationKey, context: afterApproval, listing: null, message: "Wallet receipt verified. Waiting for the authoritative marketplace index." });
      setSession({ key: verificationKey, stage: "pending", context: afterApproval, message: "Wallet receipt verified. The edition is not marked listed until the authoritative index confirms it." });
      try {
        await recordAuthoritativeTransactionSubmission({ transactionHash, chainId: canonicalChainId, wallet: wallet.account, marketplaceAddress: marketplace.address, type: "LISTING", authHeaders: wallet.authHeaders });
      } catch {
        setPending((prior) => prior?.transactionHash === transactionHash ? { ...prior, message: "Wallet receipt verified, but transaction registration was unavailable. Do not submit again; waiting for index reconciliation." } : prior);
        setSession({ key: verificationKey, stage: "reconciliation-required", context: afterApproval, message: "Wallet receipt verified, but transaction registration was unavailable. Do not submit again; waiting for index reconciliation." });
      }
    } catch (error) {
      if (receiptObserved) {
        setSession({ key: verificationKey, stage: "reconciliation-required", context, message: `${error?.message || "The transaction receipt could not be verified."}${observedTransactionHash ? ` Receipt ${observedTransactionHash}.` : ""} Do not resubmit; check the transaction before taking further action.` });
        return;
      }
      const nextStage = errorState(error);
      const resolvedStage = nextStage === "error" ? "ready" : nextStage === "already-listed" && sameAddress(error?.listing?.seller, wallet.account) ? "listed" : nextStage;
      setSession((prior) => ({ ...prior, key: verificationKey, stage: resolvedStage, context: prior.key === verificationKey ? prior.context : context, listing: error?.listing || prior.listing || null, message: error?.message || "Listing was not submitted." }));
    }
  };

  const cancel = async () => {
    if (!currentListing || !wallet.authenticated || !wallet.account) return;
    const listingId = String(currentListing.listingId);
    // An existing listing on a retained unified marketplace is cancelled there; everything else on the canonical one.
    const cancelMarketplace = retainedListingMarketplaces(edition, marketplace.address, tokenId).find((address) => sameAddress(address, currentListing.marketplace)) || canonicalMarketplace;
    let receiptObserved = false;
    let observedTransactionHash = "";
    try {
      setSession({ key: verificationKey, stage: "cancelling", context, listing: currentListing, message: "Rechecking the exact indexed listing before cancellation…" });
      const authoritative = await fetchAuthoritativeListing({ chainId: canonicalChainId, marketplaceAddress: cancelMarketplace, listingId });
      if (!activeStatus(authoritative.status) || !sameAddress(authoritative.seller, wallet.account)
        || !sameAddress(authoritative.tokenContract, contract) || String(authoritative.tokenId) !== tokenId) {
        throw new Error("The authoritative listing is not active or is not the exact listing owned by this wallet.");
      }
      const receipt = await submitCancel({ provider: wallet.getProvider(), owner: wallet.account, marketplace: cancelMarketplace, listingId });
      receiptObserved = Boolean(receipt);
      observedTransactionHash = String(receipt?.transactionHash || "");
      verifyCancelReceipt(receipt, { marketplace: cancelMarketplace, seller: wallet.account, listingId });
      const transactionHash = String(receipt.transactionHash || "");
      if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw Object.assign(new Error("Verified cancellation receipt did not include a usable transaction hash."), { code: "TRANSACTION_HASH_MISSING" });
      const expected = {
        chainId: canonicalChainId,
        transactionHash,
        transactionType: "LISTING_CANCEL",
        marketplaceAddress: cancelMarketplace,
        seller: wallet.account,
        listingId,
        contract,
        tokenId,
        amount: String(authoritative.amount),
        initialAmount: String(authoritative.initialAmount ?? authoritative.amount),
        exactRemainingAmount: true,
        price: String(authoritative.price),
      };
      setPending({ kind: "cancel", transactionHash, expected, assetKey, verificationKey, context, listing: authoritative, message: "Cancellation receipt verified. Waiting for the authoritative index." });
      setSession({ key: verificationKey, stage: "pending", context, listing: authoritative, message: "Cancellation receipt verified. The offer remains visible until the index confirms cancellation." });
      try {
        await recordAuthoritativeTransactionSubmission({ transactionHash, chainId: canonicalChainId, wallet: wallet.account, marketplaceAddress: cancelMarketplace, type: "LISTING_CANCEL", authHeaders: wallet.authHeaders });
      } catch {
        setPending((prior) => prior?.transactionHash === transactionHash ? { ...prior, message: "Cancellation receipt verified, but transaction registration was unavailable. Do not submit again; waiting for index reconciliation." } : prior);
        setSession({ key: verificationKey, stage: "reconciliation-required", context, listing: authoritative, message: "Cancellation receipt verified, but transaction registration was unavailable. Do not submit again; waiting for index reconciliation." });
      }
    } catch (error) {
      setSession((prior) => ({ ...prior, key: verificationKey, stage: receiptObserved ? "reconciliation-required" : "listed", context, listing: currentListing, message: receiptObserved ? `${error?.message || "Cancellation receipt could not be verified."}${observedTransactionHash ? ` Receipt ${observedTransactionHash}.` : ""} Do not submit again.` : error?.message || "Cancellation was not submitted." }));
    }
  };

  const authenticate = async () => {
    try {
      const result = await wallet.authenticate();
      if (result?.error) setSession({ key: verificationKey, stage: "ready", context, message: result.error });
      else setRetry((value) => value + 1);
    } catch (error) {
      setSession({ key: verificationKey, stage: "ready", context, message: error?.message || "Wallet authentication failed." });
    }
  };

  const switchToReleaseNetwork = async () => {
    try {
      if (typeof wallet.ensureNetwork === "function") {
        const result = await wallet.ensureNetwork({ thenAuthenticate: false });
        if (result?.error) throw Object.assign(new Error(result.error), { code: result.code || "WRONG_NETWORK" });
      } else {
        const chainId = await ensureReleaseChain(wallet.getProvider());
        if (Number(chainId) !== canonicalChainId) {
          throw Object.assign(new Error(releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "list this release" })), { code: "WRONG_NETWORK" });
        }
      }
      setSession({ key: verificationKey, stage: "checking", message: "" });
    } catch (error) {
      setSession({ key: verificationKey, stage: "wrong-network", message: error?.message || releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "list this release" }) });
    }
  };

  const listedByThisWallet = currentListing && sameAddress(currentListing.seller, wallet.account);
  const ownerIntro = stage === "listed" && listedByThisWallet
    ? "Your edition is already listed. Manage or cancel this indexed offer below."
    : context && BigInt(context.balance) > 0n
      ? "You own this edition. You can list it for resale."
      : stage === "not-owner"
        ? "This wallet does not currently own this edition. New listings are unavailable."
        : "On-chain ownership and factory registration must verify before a listing can be created.";
  const ownershipDetail = currentListing && listedByThisWallet && context && BigInt(context.balance) <= 0n
    ? "The offer remains indexed, but the wallet no longer holds this token. A marketplace purchase requires the balance and approval to verify; cancel the offer if it is no longer valid."
    : context && BigInt(context.balance) > 0n
      ? "The listing does not escrow your edition; ownership transfers only through a verified marketplace purchase."
      : `Ownership is read directly from this edition’s release contract on ${RELEASE_DEPLOYMENT.networkName}. A failed chain read is never treated as a zero balance.`;
  const identity = candidate
    ? `CHAIN ${canonicalChainId} · CONTRACT ${contract} · TOKEN ${tokenId}`
    : `CHAIN ${Number(edition?.chainId || 0)} · CONTRACT ${contract || "UNAVAILABLE"} · TOKEN ${tokenId || "UNAVAILABLE"}`;
  const economicsForCurrentListing = currentListing && context
    ? calculateListingEconomics({ priceWei: currentListing.price, amount: currentListing.amount, marketplaceFeeBps: context.marketplaceFeeBps, royaltyBps: context.royaltyBps })
    : null;

  return (
    <section id="secondary-listing" aria-labelledby="secondary-listing-title" style={{ marginTop: 40, borderTop: "1px solid var(--vc-ash)", paddingTop: 28, scrollMarginTop: 110 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase" }}>Secondary collection · owner action</div>
      <h2 id="secondary-listing-title" style={{ fontFamily: "var(--font-display)", fontSize: "clamp(22px, 3vw, 28px)", textTransform: "uppercase", lineHeight: 1, margin: "12px 0" }}>List for sale</h2>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65 }}>{ownerIntro} {ownershipDetail}</p>
      <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".08em", overflowWrap: "anywhere" }}>{identity}</p>
      {tokenChoices && ownedIds?.length > 0 && requestedHeld && !changingToken && !selectedTokenId && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", margin: "14px 0", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <span role="status" aria-label={`Listing token #${tokenId}`}>LISTING TOKEN #{tokenId}</span>
          {ownedIds.length > 1 && (
            <button type="button" onClick={() => setChangingToken(true)} disabled={busy} aria-expanded="false" aria-controls="listing-token-choices"
              style={{ background: "transparent", border: "1px solid var(--vc-ash)", color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", padding: "6px 10px", cursor: "pointer" }}>
              Change token
            </button>
          )}
        </div>
      )}
      {tokenChoices && ownedIds?.length > 0 && (!requestedHeld || changingToken || selectedTokenId) && (
        <fieldset id="listing-token-choices" ref={tokenChoicesRef} style={{ border: "1px solid var(--vc-ash)", padding: "12px 14px", margin: "14px 0" }} disabled={busy}>
          <legend style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", padding: "0 6px" }}>Token to list (held by this wallet)</legend>
          {ownedIds.map((id) => (
            <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 18, fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <input type="radio" name="listing-token" value={id} checked={tokenId === id} onChange={() => setSelectedTokenId(id)} />
              Token #{id}
            </label>
          ))}
        </fieldset>
      )}
      {(!candidate || !marketplaceConfigured) && <Btn kind="ash" disabled>LIST FOR SALE</Btn>}
      <details style={{ maxWidth: 760, margin: "12px 0", border: "1px solid var(--vc-ash)", padding: "10px 12px", background: "var(--vc-abyss)" }}>
        <summary style={{ cursor: "pointer", color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".1em" }}>VERIFIED NETWORK AND CONTRACT TARGETS</summary>
        <div style={{ marginTop: 10, color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.8, overflowWrap: "anywhere" }}>
          <div>NETWORK · {String(RELEASE_DEPLOYMENT.networkName || "Avalanche").toUpperCase()} · CHAIN {canonicalChainId}</div>
          <div>{legacyMarketplace ? "LEGACY COLLECTION MARKETPLACE" : `RELEASE FACTORY · ${deployment?.factoryAddress || RELEASE_PER_CONTRACT.factoryAddress}`}</div>
          <div>MARKETPLACE · {canonicalMarketplace}</div>
          <div>RELEASE CONTRACT · {contract || "UNAVAILABLE"}</div>
          <div>CONTRACT · checks clone registration, balance, approval, price, expiry and settlement rules.</div>
          <div>INDEX · provides discoverability and confirmed listing state; an observed wallet receipt alone is not shown as listed.</div>
        </div>
      </details>

      {!candidate && <p role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{statusCopy("unsupported")}</p>}
      {candidate && !marketplaceConfigured && <p role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{`Marketplace unavailable: this build has no matching live ${RELEASE_DEPLOYMENT.networkName} marketplace configuration. No transaction can be submitted.`}</p>}
      {stage === "disconnected" && <div style={{ margin: "18px 0" }}><WalletButton /><span style={{ display: "block", marginTop: 8, color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{message}</span></div>}
      {stage === "wrong-network" && <div style={{ margin: "18px 0" }}><p role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{message}</p>{releaseNetworkSwitchAllowed(RELEASE_DEPLOYMENT) && <Btn onClick={switchToReleaseNetwork}>{releaseNetworkSwitchLabel(RELEASE_DEPLOYMENT)}</Btn>}</div>}
      {wallet.connected && candidate && marketplaceConfigured && !wallet.authenticated && stage !== "wrong-network" && !wallet.needsNetworkSwitch && <div style={{ margin: "14px 0" }}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>A wallet signature is required to register a listing with the marketplace index. No signature is requested for ownership checks.</p><Btn onClick={authenticate}>AUTHENTICATE WALLET</Btn></div>}

      {candidate && marketplaceConfigured && ["checking", "ready", "listed", "already-listed", "not-owner", "no-token", "select-token", "requested-not-held", "unsupported", "unavailable", "error", "reconciliation-required", "approval", "listing", "cancelling"].includes(stage) && (
        <p role="status" aria-live="polite" style={{ color: ["not-owner", "no-token", "requested-not-held", "unsupported", "unavailable", "error", "reconciliation-required"].includes(stage) ? "var(--vc-crimson)" : "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.65, overflowWrap: "anywhere" }}>
          {pending?.assetKey === assetKey ? pending.message || message : message}
        </p>
      )}

      {candidate && marketplaceConfigured && context && ["ready", "listed", "already-listed", "pending"].includes(stage) && (
        <div style={{ marginTop: 18, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "18px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, fontFamily: "var(--font-mono)", fontSize: 11 }}>
            <div><span style={{ color: "var(--vc-bone-dim)" }}>ON-CHAIN BALANCE</span><br />{context.balance}</div>
            <div><span style={{ color: "var(--vc-bone-dim)" }}>MARKETPLACE FEE</span><br />{bpsLabel(context.marketplaceFeeBps)}</div>
            <div><span style={{ color: "var(--vc-bone-dim)" }}>EDITION ROYALTY</span><br />{bpsLabel(context.royaltyBps)}</div>
            <div><span style={{ color: "var(--vc-bone-dim)" }}>SELLER SHARE</span><br />{bpsLabel(10_000 - Number(context.marketplaceFeeBps) - Number(context.royaltyBps))}</div>
          </div>
        </div>
      )}

      {stage === "ready" && context && !reviewing && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 18 }}>
          <label htmlFor="listing-amount" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", color: "var(--vc-bone-dim)" }}>QUANTITY · MAX {context.balance}
            <input id="listing-amount" type="number" min="1" max={context.balance} step="1" value={amount} onChange={(event) => { setAmount(event.target.value); setDraftError(""); }} style={{ ...field, display: "block", marginTop: 7 }} disabled={inputDisabled} />
          </label>
          <label htmlFor="listing-price" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", color: "var(--vc-bone-dim)" }}>PRICE / EDITION · AVAX
            <input id="listing-price" inputMode="decimal" value={priceAvax} onChange={(event) => { setPriceAvax(event.target.value.replace(/[^0-9.]/g, "")); setDraftError(""); }} placeholder="0.01" style={{ ...field, display: "block", marginTop: 7 }} disabled={inputDisabled} />
          </label>
          <label htmlFor="listing-expiry" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", color: "var(--vc-bone-dim)" }}>EXPIRATION · OPTIONAL
            <input id="listing-expiry" type="datetime-local" value={expiresAt} onChange={(event) => { setExpiresAt(event.target.value); setDraftError(""); }} style={{ ...field, display: "block", marginTop: 7 }} disabled={inputDisabled} />
          </label>
          <div style={{ gridColumn: "1 / -1", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>
            {priceWei && economics
              ? `LISTING TOTAL ${formatWeiAsAvax(economics.grossWei)} · ESTIMATED SELLER PROCEEDS ${formatWeiAsAvax(economics.sellerProceedsWei)}`
              : "Enter a price to calculate marketplace fee, edition royalty and estimated seller proceeds from on-chain settings."}
            {legacyMarketplace && sellerFloor ? ` · MINIMUM YOU WILL ACCEPT ${formatWeiAsAvax(sellerFloor.perUnitWei)} PER EDITION` : ""}
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <Btn onClick={review} disabled={!wallet.authenticated || !context}>REVIEW LISTING</Btn>
            <span style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{!wallet.authenticated ? "Authenticate before submitting a listing." : context.approved ? "Marketplace approval already verified." : "One approval transaction may be required before listing."}</span>
          </div>
          {draftError && <p id="listing-draft-error" ref={draftErrorRef} role="alert" style={{ gridColumn: "1 / -1", margin: 0, color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{draftError}</p>}
        </div>
      )}

      {stage === "ready" && context && reviewing && (
        <div role="group" aria-label="Listing review" style={{ marginTop: 18, border: "1px solid var(--vc-crimson)", background: "var(--vc-abyss)", padding: "18px 16px" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", color: "var(--vc-crimson)" }}>REVIEW · EXACT ASSET AND TERMS</div>
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px 18px", margin: "14px 0", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>CONTRACT · TOKEN</dt><dd style={{ margin: "4px 0", overflowWrap: "anywhere" }}>{contract} · {tokenId}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>SELLER · QUANTITY</dt><dd style={{ margin: "4px 0", overflowWrap: "anywhere" }}>{wallet.account} · {amount}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>PRICE / EDITION</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(priceWei)}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>TOTAL ASK</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(economics?.grossWei)}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>MARKETPLACE FEE · {bpsLabel(context.marketplaceFeeBps)}</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(economics?.marketplaceFeeWei)}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>ARTIST ROYALTY · {bpsLabel(context.royaltyBps)}</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(economics?.royaltyWei)}</dd></div>
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>ESTIMATED SELLER PROCEEDS · {bpsLabel(economics?.sellerProceedsBps)}</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(economics?.sellerProceedsWei)}</dd></div>
            {legacyMarketplace && sellerFloor && (
              <div><dt style={{ color: "var(--vc-bone-dim)" }}>MINIMUM YOU WILL ACCEPT</dt><dd style={{ margin: "4px 0" }}>{formatWeiAsAvax(sellerFloor.perUnitWei)} per edition · {formatWeiAsAvax(sellerFloor.totalWei)} for {amount}</dd></div>
            )}
            <div><dt style={{ color: "var(--vc-bone-dim)" }}>EXPIRATION</dt><dd style={{ margin: "4px 0" }}>{expiresAt ? new Date(expiresAt).toLocaleString() : "No expiry"}</dd></div>
          </dl>
          <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.6 }}>Rates come from the configured marketplace contract and this edition’s on-chain royalty. Amounts are estimates using the marketplace’s integer rounding. Confirming may request a separate ERC-1155 approval transaction.</p>
          {legacyMarketplace && sellerFloor && (
            <p role="note" style={{ color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.6 }}>PROTECTED LISTING · You will never receive less than {formatWeiAsAvax(sellerFloor.perUnitWei)} per edition. That is today’s {bpsLabel(context.royaltyBps)} edition royalty and {bpsLabel(context.marketplaceFeeBps)} marketplace fee, with no tolerance added. If the collection raises its royalty before a sale so you would receive less, the purchase fails and nothing moves; the listing then stays unsold until you cancel it and list again. The creator royalty is set by the collection, not by this marketplace.</p>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Btn onClick={confirmListing} disabled={!canReview || !economics}>CONFIRM LISTING</Btn>
            <button type="button" onClick={() => setReviewKey("")} style={{ ...field, width: "auto", cursor: "pointer" }}>EDIT DETAILS</button>
          </div>
        </div>
      )}

      {stage === "listed" && currentListing && listedByThisWallet && (
        <div style={{ marginTop: 18, border: "1px solid var(--vc-crimson)", background: "var(--vc-abyss)", padding: "18px 16px" }}>
          <div style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em" }}>LISTED · INDEX CONFIRMED</div>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", lineHeight: 1.6 }}>Listing {currentListing.listingId} · {currentListing.amount} remaining · {formatWeiAsAvax(currentListing.price)} per edition · {currentListing.authority}</p>
          {economicsForCurrentListing && <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>Estimated proceeds at current amount · {formatWeiAsAvax(economicsForCurrentListing.sellerProceedsWei)}</p>}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link to="/marketplace" style={{ ...field, width: "auto", textDecoration: "none" }}>VIEW MARKETPLACE</Link>
            <Btn onClick={cancel} disabled={!wallet.authenticated}>CANCEL LISTING</Btn>
          </div>
        </div>
      )}

      {stage === "already-listed" && currentListing && (
        <div style={{ marginTop: 18, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "18px 16px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>
          <div style={{ color: "var(--vc-crimson)", letterSpacing: ".12em" }}>ALREADY LISTED · NO DUPLICATE</div>
          <p>Listing {currentListing.listingId} · seller {currentListing.seller} · {currentListing.amount} remaining · {formatWeiAsAvax(currentListing.price)} per edition.</p>
          <Link to="/marketplace" style={{ ...field, width: "auto", display: "inline-block", textDecoration: "none" }}>VIEW MARKETPLACE</Link>
        </div>
      )}

      {stage === "pending" && pending?.assetKey === assetKey && (
        <div style={{ marginTop: 16, border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)", overflowWrap: "anywhere" }}>
          <div>{pending.message || message}</div>
          <div style={{ marginTop: 8 }}>TX · {pending.transactionHash}</div>
          <div style={{ marginTop: 8, color: "var(--vc-crimson)" }}>PENDING INDEX CONFIRMATION · THIS IS NOT YET SHOWN AS {pending.kind === "cancel" ? "CANCELLED" : "LISTED"}.</div>
        </div>
      )}

      {stage === "ready" && !wallet.authenticated && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Authenticate the connected wallet to create or cancel a listing.</p>}
      {stage === "error" && <button type="button" onClick={() => setRetry((value) => value + 1)} style={{ ...field, width: "auto", cursor: "pointer" }}>RETRY VERIFICATION</button>}

      <div aria-live="polite" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>
        {["FACTORY + OWNERSHIP", "APPROVAL", "REVIEW", "INDEXED LISTING"].map((label, index) => {
          const active = stage === "checking" ? index === 0
            : stage === "approval" ? index <= 1
              : stage === "listing" || stage === "cancelling" ? index <= 2
                : stage === "pending" || stage === "listed" || stage === "already-listed" ? index <= 3
                  : stage === "ready" && index === 0;
          return <span key={label} style={{ color: active ? "var(--vc-crimson)" : "inherit" }}>{index ? " → " : ""}{label}</span>;
        })}
      </div>
    </section>
  );
}
