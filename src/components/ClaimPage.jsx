import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Eyebrow, Tag } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { findMarketplaceEdition } from "../lib/marketplace-surface.js";
import { artworkFor, ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { readReleaseBalance } from "../lib/release-asset.js";
import { FUJI_RELEASE_FACTORY_CONFIG } from "../lib/fuji-release.js";
import { claimState, claimStateLabel, CLAIM_STATES, releaseBindingFor } from "../lib/claim-state.js";

function shortAddress(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text || "—";
}

function StateMark({ state }) {
  const positive = state === CLAIM_STATES.CLAIM_AVAILABLE || state === CLAIM_STATES.ALREADY_CLAIMED;
  const attention = state === CLAIM_STATES.WRONG_NETWORK || state === CLAIM_STATES.ERROR || state === CLAIM_STATES.INVALID_RELEASE_BINDING;
  return <Tag kind={positive ? "crimson" : attention ? "outline" : "ash"}>{claimStateLabel(state)}</Tag>;
}

function InfoRow({ label, children, mono = false }) {
  return (
    <div className="vc-claim-info-row">
      <Eyebrow>{label}</Eyebrow>
      <div className={mono ? "vc-claim-value vc-claim-mono" : "vc-claim-value"}>{children}</div>
    </div>
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
  const [ownershipRead, setOwnershipRead] = useState({ key: "", balance: null, error: "" });
  const networkReady = wallet.connected && Number(wallet.chainId) === binding.chainId;
  const ownershipKey = `${edition?.id || ""}:${wallet.account || ""}:${binding.releaseContractAddress}:${binding.tokenId || ""}`;

  useEffect(() => {
    let live = true;
    if (!binding.valid || !networkReady || !wallet.account) return undefined;
    const provider = wallet.getProvider?.();
    if (!provider) return undefined;
    readReleaseBalance(provider, binding, wallet.account)
      .then((value) => { if (live) setOwnershipRead({ key: ownershipKey, balance: value, error: "" }); })
      .catch((error) => { if (live) setOwnershipRead({ key: ownershipKey, balance: null, error: error?.message || "Ownership could not be verified on chain." }); });
    return () => { live = false; };
  }, [binding, networkReady, ownershipKey, wallet, wallet.account, wallet.connected, wallet.getProvider]);

  const balance = ownershipRead.key === ownershipKey ? ownershipRead.balance : null;
  const readError = ownershipRead.key === ownershipKey ? ownershipRead.error : "";
  const reading = Boolean(binding.valid && networkReady && wallet.account && ownershipRead.key !== ownershipKey);

  const result = claimState({
    edition,
    walletConnected: wallet.connected,
    chainId: wallet.chainId,
    balance,
    // There is deliberately no claim executor in this repository. Keeping this
    // false makes the CTA honest and leaves the UI ready for a future executor.
    executorAvailable: false,
    error: readError,
  });
  const state = reading && result.state !== CLAIM_STATES.INVALID_RELEASE_BINDING ? CLAIM_STATES.WALLET_CONNECTED : result.state;
  const actionDisabled = state !== CLAIM_STATES.CLAIM_AVAILABLE;
  const artwork = artworkFor(edition, release);

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
        <StateMark state={state} />
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
              <StateMark state={state} />
            </div>
            <p className="vc-claim-status-message">{result.message}</p>
            {!wallet.connected && <WalletButton />}
            {wallet.connected && <p className="vc-claim-wallet vc-claim-mono">Wallet · {shortAddress(wallet.account)}</p>}
            {wallet.connected && Number(wallet.chainId) !== binding.chainId && <p className="vc-claim-warning">Wrong network · switch to {FUJI_RELEASE_FACTORY_CONFIG.networkName} ({binding.chainId}).</p>}
            {readError && <p className="vc-claim-warning">Ownership read failed closed. No claim action was enabled.</p>}
          </div>

          <div className="vc-claim-action">
            <button type="button" style={{ ...primaryBtn, opacity: actionDisabled ? 0.45 : 1, cursor: actionDisabled ? "not-allowed" : "pointer" }} disabled={actionDisabled} aria-disabled={actionDisabled}>
              {state === CLAIM_STATES.ALREADY_CLAIMED ? "CLAIMED" : state === CLAIM_STATES.CLAIM_AVAILABLE ? "CLAIM" : "CLAIM UNAVAILABLE"}
            </button>
            <Link to={`/edition/${edition.id}`} style={ghostBtn}>View release</Link>
          </div>

          <div className="vc-claim-supporting">
            <Eyebrow red>Supporting information</Eyebrow>
            <InfoRow label="Ownership">{balance !== null ? `${balance.toString()} token${balance === 1n ? "" : "s"} held` : "Not verified"}</InfoRow>
            <InfoRow label="Provenance">Factory-created release binding required</InfoRow>
            <InfoRow label="Release contract" mono>{binding.valid ? binding.releaseContractAddress : "UNVERIFIED · CLOSED"}</InfoRow>
            <InfoRow label="Token identity" mono>{binding.valid ? `${binding.chainId}:${binding.releaseContractAddress}:${binding.tokenId}` : "UNVERIFIED"}</InfoRow>
            <InfoRow label="Network">{binding.chainId === 43113 ? "Avalanche Fuji · 43113" : `Chain ${binding.chainId || "—"}`}</InfoRow>
          </div>
        </div>
      </div>
    </section>
  );
}
