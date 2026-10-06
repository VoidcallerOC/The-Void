import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Eyebrow, Tag } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { findMarketplaceEdition } from "../lib/marketplace-surface.js";
import { artworkFor, ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { FUJI_RELEASE_FACTORY_CONFIG } from "../lib/fuji-release.js";
import { releaseBindingFor } from "../lib/claim-state.js";
import { checkGenesisEligibility, executeGenesisClaim, fetchGenesisClaimConfig, readGenesisClaimed, requestGenesisVoucher } from "../lib/genesis-claim.js";
import { FUJI_REHEARSAL_CLAIM_TARGET } from "../lib/fuji-rehearsal-claim.js";

const CLAIM_PHASES = Object.freeze({
  DISCONNECTED: "disconnected",
  CHECKING: "checking",
  WRONG_NETWORK: "wrong-network",
  ELIGIBLE: "eligible",
  ACCESS_DENIED: "access-denied",
  ELIGIBILITY_UNAVAILABLE: "eligibility-unavailable",
  CLAIM_UNAVAILABLE: "claim-unavailable",
  INVALID_BINDING: "invalid-binding",
  ALREADY_CLAIMED: "already-claimed",
  AUTHORIZED: "authorized",
  PENDING: "pending",
  OWNED: "owned",
  ERROR: "error",
});

const PHASE_LABELS = Object.freeze({
  [CLAIM_PHASES.DISCONNECTED]: "Wallet disconnected",
  [CLAIM_PHASES.CHECKING]: "Checking Genesis eligibility",
  [CLAIM_PHASES.WRONG_NETWORK]: "Wrong network",
  [CLAIM_PHASES.ELIGIBLE]: "Eligible",
  [CLAIM_PHASES.ACCESS_DENIED]: "Access denied",
  [CLAIM_PHASES.ELIGIBILITY_UNAVAILABLE]: "Eligibility unavailable",
  [CLAIM_PHASES.CLAIM_UNAVAILABLE]: "Claim unavailable",
  [CLAIM_PHASES.INVALID_BINDING]: "Invalid release binding",
  [CLAIM_PHASES.ALREADY_CLAIMED]: "Already claimed",
  [CLAIM_PHASES.AUTHORIZED]: "Claim authorized",
  [CLAIM_PHASES.PENDING]: "Transaction pending",
  [CLAIM_PHASES.OWNED]: "Owned",
  [CLAIM_PHASES.ERROR]: "Claim error",
});

function shortAddress(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text || "—";
}

function StateMark({ state }) {
  const positive = [CLAIM_PHASES.ELIGIBLE, CLAIM_PHASES.AUTHORIZED, CLAIM_PHASES.OWNED, CLAIM_PHASES.ALREADY_CLAIMED].includes(state);
  const attention = [CLAIM_PHASES.WRONG_NETWORK, CLAIM_PHASES.ERROR, CLAIM_PHASES.INVALID_BINDING, CLAIM_PHASES.ACCESS_DENIED, CLAIM_PHASES.ELIGIBILITY_UNAVAILABLE].includes(state);
  return <Tag kind={positive ? "crimson" : attention ? "outline" : "ash"}>{PHASE_LABELS[state] || "Checking claim"}</Tag>;
}

function InfoRow({ label, children, mono = false }) {
  return (
    <div className="vc-claim-info-row">
      <Eyebrow>{label}</Eyebrow>
      <div className={mono ? "vc-claim-value vc-claim-mono" : "vc-claim-value"}>{children}</div>
    </div>
  );
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function classifyError(error) {
  if (error?.code === "ELIGIBILITY_UNAVAILABLE") return CLAIM_PHASES.ELIGIBILITY_UNAVAILABLE;
  if (error?.code === "ACCESS_DENIED") return CLAIM_PHASES.ACCESS_DENIED;
  if (error?.code === "ALREADY_CLAIMED") return CLAIM_PHASES.ALREADY_CLAIMED;
  if (error?.code === "INVALID_RELEASE_BINDING" || error?.code === "CLAIM_BINDING_MISMATCH") return CLAIM_PHASES.INVALID_BINDING;
  if (error?.code === "CLAIM_UNAVAILABLE" || error?.code === "CLAIM_AUTHORIZATION_UNAVAILABLE") return CLAIM_PHASES.CLAIM_UNAVAILABLE;
  return CLAIM_PHASES.ERROR;
}

function FujiRehearsalClaimSurface() {
  const target = FUJI_REHEARSAL_CLAIM_TARGET;
  return (
    <section className="vc-claim-page" style={shell}>
      <header className="vc-claim-header">
        <div>
          <Eyebrow red>† Claim · Fuji rehearsal</Eyebrow>
          <h1 className="vc-h1" style={{ margin: "16px 0 0" }}>Fuji Rehearsal Release A</h1>
        </div>
        <StateMark state={CLAIM_PHASES.CLAIM_UNAVAILABLE} />
      </header>
      <div className="vc-claim-layout">
        <figure className="vc-claim-artwork">
          <img src="/assets/voidcaller_art_4.png" alt="Fuji Rehearsal Release A artwork" />
          <figcaption><span>Voidcaller</span><span>Fuji test pressing</span></figcaption>
        </figure>
        <div className="vc-claim-copy">
          <Eyebrow red>Collector-facing release identity</Eyebrow>
          <p className="vc-claim-artist">Voidcaller</p>
          <h2 className="vc-claim-title">Fuji Rehearsal Release A</h2>
          <p className="vc-body vc-body-muted" style={{ maxWidth: 620 }}>A Fuji-only public claim rehearsal. This surface verifies the existing Release A binding before collector claims are enabled.</p>
          <div className="vc-claim-status" aria-live="polite">
            <div className="vc-claim-status-head">
              <Eyebrow red>Claim status</Eyebrow>
              <StateMark state={CLAIM_PHASES.CLAIM_UNAVAILABLE} />
            </div>
            <p className="vc-claim-status-message">Claim execution is intentionally closed for this rehearsal. No claim authorization, wallet signature, or transaction is requested.</p>
          </div>
          <div className="vc-claim-action">
            <button type="button" style={{ ...primaryBtn, opacity: 0.45, cursor: "not-allowed" }} disabled aria-disabled="true">CLAIM UNAVAILABLE</button>
            <Link to="/marketplace" style={ghostBtn}>View marketplace</Link>
          </div>
          <div className="vc-claim-supporting">
            <Eyebrow red>Verified Fuji target</Eyebrow>
            <InfoRow label="Release" mono>{target.releaseContract}</InfoRow>
            <InfoRow label="Primary sale" mono>{target.primarySale}</InfoRow>
            <InfoRow label="Provenance anchor" mono>{target.provenanceAnchor}</InfoRow>
            <InfoRow label="Network">{target.network} · {target.chainId}</InfoRow>
            <InfoRow label="Collector receives">Full self-titled EP · Collector Reliquary access · Token-gated music experiences</InfoRow>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ClaimPage() {
  const { edition: pathEdition } = useParams();
  const [params] = useSearchParams();
  const editionId = pathEdition || params.get("edition") || "";
  const catalog = useMarketplaceCatalogs();
  const wallet = useWallet();
  const item = useMemo(() => findMarketplaceEdition(editionId, [catalog]), [catalog, editionId]);
  const edition = item?.edition || null;
  const release = item?.release || null;
  const artist = item?.artist || null;
  const binding = useMemo(() => releaseBindingFor(edition), [edition]);
  const [phase, setPhase] = useState(CLAIM_PHASES.DISCONNECTED);
  const [message, setMessage] = useState("Connect a wallet to verify Genesis ownership.");
  const [target, setTarget] = useState(null);
  const [voucher, setVoucher] = useState(null);
  const [signature, setSignature] = useState("");
  const [eligibleTokenIds, setEligibleTokenIds] = useState([]);
  const [transactionHash, setTransactionHash] = useState("");
  const [ownershipBalance, setOwnershipBalance] = useState(null);

  const account = wallet.account || "";
  const connected = Boolean(wallet.connected && account);
  const provider = wallet.getProvider?.();

  useEffect(() => {
    let live = true;
    async function synchronizeClaimState() {
      setVoucher(null);
      setSignature("");
      setTransactionHash("");
      setOwnershipBalance(null);
      setEligibleTokenIds([]);
      setTarget(null);
      if (!edition) return;
      if (!connected) {
        setPhase(CLAIM_PHASES.DISCONNECTED);
        setMessage("Connect a wallet to verify Genesis ownership.");
        return;
      }
      if (!binding.valid) {
        setPhase(CLAIM_PHASES.INVALID_BINDING);
        setMessage(binding.reason);
        return;
      }
      if (Number(wallet.chainId) !== binding.chainId) {
        setPhase(CLAIM_PHASES.WRONG_NETWORK);
        setMessage(`Switch your wallet to ${binding.chainId === 43113 ? FUJI_RELEASE_FACTORY_CONFIG.networkName : `chain ${binding.chainId}`} (${binding.chainId}) to claim.`);
        return;
      }
      if (!provider) {
        setPhase(CLAIM_PHASES.ELIGIBILITY_UNAVAILABLE);
        setMessage("Wallet provider is unavailable; Genesis eligibility was not verified.");
        return;
      }
      setPhase(CLAIM_PHASES.CHECKING);
      setMessage("Checking the Genesis collection on Avalanche C-Chain and the destination claim state.");
      try {
        const configuredTarget = await fetchGenesisClaimConfig();
        if (!live) return;
        if (configuredTarget.destinationChainId !== binding.chainId
          || !sameAddress(configuredTarget.releaseContract, binding.releaseContractAddress)
          || !sameAddress(configuredTarget.primarySale, binding.primarySaleAddress)
          || String(configuredTarget.tokenId) !== String(binding.tokenId)) {
          const error = new Error("This page does not match the server-authorized claim release target.");
          error.code = "INVALID_RELEASE_BINDING";
          throw error;
        }
        const alreadyClaimed = await readGenesisClaimed(provider, configuredTarget, account);
        if (!live) return;
        if (alreadyClaimed) {
          setTarget(configuredTarget);
          setPhase(CLAIM_PHASES.ALREADY_CLAIMED);
          setMessage("This wallet has already used its one Genesis-holder claim.");
          return;
        }
        const result = await checkGenesisEligibility(account);
        if (!live) return;
        setTarget(configuredTarget);
        setEligibleTokenIds(result.eligibleTokenIds || []);
        if (!result.eligible) {
          setPhase(CLAIM_PHASES.ACCESS_DENIED);
          setMessage("Access denied. This wallet holds none of Genesis token IDs 0, 1, 2, or 3.");
          return;
        }
        setPhase(CLAIM_PHASES.ELIGIBLE);
        setMessage(`Genesis ownership verified for token${result.eligibleTokenIds.length === 1 ? "" : "s"} ${result.eligibleTokenIds.join(", ")}. This grants one claim.`);
      } catch (error) {
        if (!live) return;
        setPhase(classifyError(error));
        setMessage(error?.message || "Claim eligibility could not be verified.");
      }
    }
    void synchronizeClaimState();
    return () => { live = false; };
  }, [account, binding, connected, edition, provider, wallet.chainId]);

  async function onClaimAction() {
    if (phase === CLAIM_PHASES.ELIGIBLE && !voucher) {
      setPhase(CLAIM_PHASES.CHECKING);
      setMessage("Requesting a signed claim authorization from the server.");
      try {
        const issued = await requestGenesisVoucher(account);
        if (!issued?.voucher || !issued?.signature || !target) throw new Error("The claim service returned an incomplete authorization.");
        if (!sameAddress(issued.voucher.claimant, account)
          || !sameAddress(issued.voucher.releaseContract, target.releaseContract)
          || String(issued.voucher.destinationChainId) !== String(target.destinationChainId)
          || String(issued.voucher.tokenId) !== String(target.tokenId)) {
          const error = new Error("The signed voucher does not match the connected wallet and release target.");
          error.code = "INVALID_RELEASE_BINDING";
          throw error;
        }
        setVoucher(issued.voucher);
        setSignature(issued.signature);
        setPhase(CLAIM_PHASES.AUTHORIZED);
        setMessage("A short-lived EIP-712 voucher is ready. Confirm the free claim transaction in your wallet.");
      } catch (error) {
        setPhase(classifyError(error));
        setMessage(error?.message || "Claim authorization could not be obtained.");
      }
      return;
    }

    if (phase !== CLAIM_PHASES.AUTHORIZED || !voucher || !signature || !target) return;
    setPhase(CLAIM_PHASES.PENDING);
    setMessage("Confirm the transaction in your wallet. The claim will not show as successful until the receipt and token ownership are verified.");
    try {
      const result = await executeGenesisClaim(provider, target, voucher, signature);
      setTransactionHash(result.transactionHash);
      setOwnershipBalance(result.balance);
      setPhase(CLAIM_PHASES.OWNED);
      setMessage("Receipt confirmed and the target release token is owned by this wallet.");
    } catch (error) {
      setPhase(classifyError(error));
      setMessage(error?.message || "The claim transaction did not complete.");
    }
  }

  const artwork = artworkFor(edition, release);
  const actionDisabled = ![CLAIM_PHASES.ELIGIBLE, CLAIM_PHASES.AUTHORIZED].includes(phase);
  const actionText = phase === CLAIM_PHASES.ELIGIBLE && !voucher
    ? "REQUEST CLAIM AUTHORIZATION"
    : phase === CLAIM_PHASES.AUTHORIZED
      ? "CLAIM FREE"
      : phase === CLAIM_PHASES.PENDING
        ? "TRANSACTION PENDING"
        : phase === CLAIM_PHASES.OWNED
          ? "OWNED"
          : phase === CLAIM_PHASES.ALREADY_CLAIMED
            ? "ALREADY CLAIMED"
            : "CLAIM UNAVAILABLE";

  if (!editionId) return <FujiRehearsalClaimSurface />;

  if (!edition) {
    return (
      <section style={shell}>
        <Eyebrow red>† Claim</Eyebrow>
        <h1 className="vc-h1" style={{ margin: "16px 0" }}>Release unavailable</h1>
        <p className="vc-body vc-body-muted" style={{ maxWidth: 620 }}>This claim route is not bound to a published release. Nothing can be claimed.</p>
        <Link to="/marketplace" style={ghostBtn}>Return to marketplace</Link>
      </section>
    );
  }

  return (
    <section className="vc-claim-page" style={shell}>
      <header className="vc-claim-header">
        <div>
          <Eyebrow red>† Claim · release identity</Eyebrow>
          <h1 className="vc-h1" style={{ margin: "16px 0 0" }}>Claim</h1>
        </div>
        <StateMark state={phase} />
      </header>
      <div className="vc-claim-layout">
        <figure className="vc-claim-artwork">
          <img src={artwork} alt={`${edition.title} artwork`} />
          <figcaption><span>{artist?.name || "The Void"}</span><span>{edition.title}</span></figcaption>
        </figure>
        <div className="vc-claim-copy">
          <Eyebrow red>Artwork / release identity</Eyebrow>
          <p className="vc-claim-artist">{artist?.name || "The Void"}</p>
          <h2 className="vc-claim-title">{release?.title || edition.title}</h2>
          <p className="vc-claim-edition">{edition.title} · Token #{binding.tokenId || "—"}</p>
          {edition.description && <p className="vc-body vc-body-muted" style={{ maxWidth: 620 }}>{edition.description}</p>}

          <div className="vc-claim-status" aria-live="polite">
            <div className="vc-claim-status-head">
              <Eyebrow red>Claim status</Eyebrow>
              <StateMark state={phase} />
            </div>
            <p className="vc-claim-status-message">{message}</p>
            {phase === CLAIM_PHASES.AUTHORIZED && <p className="vc-claim-wallet">No claim price; the wallet will pay the destination network’s normal transaction gas.</p>}
            {!connected && <WalletButton />}
            {connected && <p className="vc-claim-wallet vc-claim-mono">Wallet · {shortAddress(account)}</p>}
            {connected && Number(wallet.chainId) !== binding.chainId && <p className="vc-claim-warning">Wrong network · switch to {FUJI_RELEASE_FACTORY_CONFIG.networkName} ({binding.chainId}).</p>}
            {phase === CLAIM_PHASES.ELIGIBILITY_UNAVAILABLE && <p className="vc-claim-warning">An RPC or ownership-read failure is not treated as ineligibility. No voucher or transaction was produced.</p>}
            {phase === CLAIM_PHASES.PENDING && <p className="vc-claim-warning">Waiting for the destination-chain receipt. Do not close this page until confirmation completes.</p>}
            {transactionHash && <p className="vc-claim-wallet vc-claim-mono">Receipt · {transactionHash}</p>}
            {phase === CLAIM_PHASES.OWNED && ownershipBalance !== null && <p className="vc-claim-wallet">Owned balance · {ownershipBalance.toString()}</p>}
          </div>

          <div className="vc-claim-action">
            <button type="button" style={{ ...primaryBtn, opacity: actionDisabled ? 0.45 : 1, cursor: actionDisabled ? "not-allowed" : "pointer" }} disabled={actionDisabled} aria-disabled={actionDisabled} onClick={onClaimAction}>
              {actionText}
            </button>
            <Link to={`/edition/${edition.id}`} style={ghostBtn}>View release</Link>
          </div>

          <div className="vc-claim-supporting">
            <Eyebrow red>Supporting information</Eyebrow>
            <InfoRow label="Genesis eligibility">{eligibleTokenIds.length ? `Verified token${eligibleTokenIds.length === 1 ? "" : "s"} ${eligibleTokenIds.join(", ")}` : "Not verified"}</InfoRow>
            <InfoRow label="Claims per wallet">One · enforced by the destination claim contract</InfoRow>
            <InfoRow label="Provenance">Factory-created release binding required</InfoRow>
            <InfoRow label="Release contract" mono>{binding.valid ? binding.releaseContractAddress : "UNVERIFIED · CLOSED"}</InfoRow>
            <InfoRow label="Token identity" mono>{binding.valid ? `${binding.chainId}:${binding.releaseContractAddress}:${binding.tokenId}` : "UNVERIFIED"}</InfoRow>
            <InfoRow label="Network">{binding.chainId === 43113 ? "Avalanche Fuji · 43113" : `Chain ${binding.chainId || "—"}`}</InfoRow>
            {target && <InfoRow label="Genesis reserved allocation">{target.allocation}</InfoRow>}
          </div>
        </div>
      </div>
    </section>
  );
}
