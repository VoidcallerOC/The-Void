import { useState } from "react";
import { artworkSources } from "../lib/artwork.js";
import { Link, useLocation, useParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { getEditionCatalog } from "../domain/models.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { MARKETPLACE_STATE, resolveSecondaryStatus } from "../lib/marketplace-surface.js";
import { artworkFor, ghostBtn, shell } from "../lib/marketplace-chrome.js";
import { assetTokenId } from "../lib/asset-actions.js";
import { isReleasePerContractCandidate } from "../lib/secondary-listing.js";
import { listedTokenView, playableTrackFor, tokenView } from "../lib/token-view.js";
import { NotFoundPage } from "./NotFoundPage.jsx";
import { PlayTokenButton } from "./PlayTokenButton.jsx";
import { PurchasePanel } from "./PurchasePanel.jsx";

/**
 * One token's own page: its on-chain name and art, and only the indexed offers for that exact token, with the
 * existing purchase flow. The edition stays one link away for its shared context.
 */
export function TokenPage() {
  const catalog = useMarketplaceCatalogs();
  const { edition: editionId, tokenId: rawTokenId } = useParams();
  const result = getEditionCatalog(catalog, editionId);
  const [failedImages, setFailedImages] = useState([]);
  const listingId = new URLSearchParams(useLocation().search).get("listing");
  if (!result && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading token…</p></section>;
  }
  const tokenId = result ? assetTokenId(result.edition, rawTokenId) : null;
  if (!result || tokenId === null) return <NotFoundPage kind="token" backTo="/marketplace" backLabel="Marketplace" />;
  const { edition, release, artist } = result;
  const token = listedTokenView(catalog, edition, release, tokenId);
  const editionArt = artworkFor(edition, release);
  const candidates = [...new Set([token.artwork, token.artworkFallback, editionArt].filter(Boolean).flatMap((src) => artworkSources(src, { width: 1200 })))];
  const image = candidates.find((src) => !failedImages.includes(src)) || editionArt;
  const showingTokenArt = !artworkSources(editionArt, { width: 1200 }).includes(image);
  const track = playableTrackFor(tokenView(catalog, { edition, release, tokenId }).token);
  const secondary = resolveSecondaryStatus();
  const title = token.name || `Token #${tokenId}`;
  return (
    <section style={shell}>
      <Eyebrow red>† Token #{tokenId}</Eyebrow>
      <div className="vc-edition-plate" style={{ marginTop: 18 }}>
        <img src={image} onError={() => setFailedImages((prior) => (prior.includes(image) ? prior : [...prior, image]))} alt={showingTokenArt ? `${title}, token #${tokenId} artwork` : `${edition.title} edition artwork`} />
        <div>
          <p className="vc-card-kicker">{artist?.name}</p>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 8vw, 88px)", lineHeight: 0.9, textTransform: "uppercase", margin: "8px 0 12px" }}>{title}</h1>
          {!token.name && <p className="vc-card-meta">Token metadata unavailable.</p>}
          <p className="vc-card-release">Token #{tokenId} · from the <Link to={`/edition/${encodeURIComponent(edition.id)}`} style={{ color: "inherit" }}>{edition.title}</Link> edition</p>
          <p className="vc-card-meta" style={{ overflowWrap: "anywhere" }}>Chain {edition.chainId} · Contract {edition.contractAddress} · Token {tokenId}</p>
          {track && <div style={{ margin: "18px 0" }}><PlayTokenButton track={track} queueId={`token-page:${edition.id}:${tokenId}`} collection={release?.title || edition.title} label={`Play ${title} preview`} /></div>}
          <div style={{ marginTop: 12 }}><Link to={`/edition/${encodeURIComponent(edition.id)}`} style={ghostBtn}>View edition</Link></div>
          {secondary === MARKETPLACE_STATE.LIVE && isReleasePerContractCandidate(edition) && <PurchasePanel edition={edition} tokenId={tokenId} listingId={listingId} />}
        </div>
      </div>
    </section>
  );
}
