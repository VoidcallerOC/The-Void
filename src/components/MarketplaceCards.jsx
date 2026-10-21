import { useState } from "react";
import { primaryExperience } from "../domain/models.js";
import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { editionIsCollectable, editionPriceLabel, editionSupplyLabel, editionTypeLabel, formatWeiAsAvax } from "../lib/marketplace-surface.js";
import { artworkFor, ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import { ListForSaleLink } from "./AssetActions.jsx";
import { listedTokenView } from "../lib/token-view.js";

export function SectionHead({ id, eyebrow, title, children, action }) {
  return (
    <div className="vc-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, margin: "24px 0 22px", flexWrap: "wrap" }}>
      <div>
        {eyebrow && <Eyebrow red>{eyebrow}</Eyebrow>}
        <h2 id={id} style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 52px)", lineHeight: 0.95, textTransform: "uppercase", margin: "10px 0 0" }}>{title}</h2>
        {children && <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65, margin: "12px 0 0" }}>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function QuietStatus({ primary, secondary }) {
  return (
    <p className="vc-quiet-status" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", margin: 0 }}>
      Official editions · {primary} · Secondary index · {secondary}
    </p>
  );
}

function Includes({ items = [] }) {
  if (!items.length) return null;
  return (
    <div>
      <Eyebrow>Collector receives</Eyebrow>
      <ul className="vc-includes">
        {items.map((entry) => <li key={entry}>{entry}</li>)}
      </ul>
    </div>
  );
}

function experienceAction(item) {
  const experience = item.experiences?.find((candidate) => candidate?.id);
  if (experience) {
    return <Link to={`/experience/${experience.id}`} style={primaryBtn}>Open experience</Link>;
  }
  return <Link to={`/edition/${item.edition.id}`} style={ghostBtn}>View edition</Link>;
}

function objectClass(edition, chain) {
  const id = String(chain?.id || edition.chainId || "");
  if (id === "43114") return { label: "The relic", tone: "is-relic", note: "Avalanche C-Chain pressing" };
  if (id === "43113") return { label: "Rehearsal", tone: "is-rehearsal", note: "Fuji test pressing · not the relic" };
  return { label: "Pressing", tone: "", note: chain?.name || edition.chain || "Avalanche" };
}

export function EditionCard({ item, owned = false }) {
  const { edition, artist, release, primary, chain } = item;
  const image = artworkFor(edition, release);
  const chainName = chain?.name || edition.chain || "Avalanche";
  const chainId = chain?.id || edition.chainId;
  const price = editionPriceLabel(edition);
  const object = objectClass(edition, chain);
  const collectable = editionIsCollectable(edition, primary);
  const supplyLabel = editionSupplyLabel(edition, primary);
  const action = owned ? <>{experienceAction(item)}<ListForSaleLink edition={edition} owned style={ghostBtn} /></> : collectable
    ? <Link to={primary.href} style={primaryBtn}>Collect</Link>
    : <Link to={`/edition/${edition.id}`} style={ghostBtn}>View edition</Link>;

  return (
    <article className="vc-market-card" data-edition-id={edition.id}>
      <div className="vc-sleeve" style={{ display: "flex", flexDirection: "column" }}>
        <Link to={`/edition/${edition.id}`} className="vc-sleeve-art" aria-label={`View ${edition.title} edition`} style={{ display: "block" }}>
          <img src={image} alt={`${edition.title} artwork`} style={{ width: "100%", aspectRatio: "1", height: "auto", objectFit: "contain", objectPosition: "center", display: "block", background: "#000" }} />
        </Link>
        <div className="vc-sleeve-copy">
          <span className={`vc-object-mark ${object.tone}`}>{object.label}</span>
          <p className="vc-card-kicker">{artist?.name || "The Void"}</p>
          <h3 className="vc-card-title">{edition.title}</h3>
          <p className="vc-card-release">{release?.id ? <Link to={`/release/${release.id}`} style={{ color: "inherit", textDecoration: "none" }}>{release.title}</Link> : release?.title || "Official release"}</p>
          <p className="vc-card-meta">{object.note} · {editionTypeLabel(edition)} · {supplyLabel}</p>
          <p className="vc-card-meta">
            {collectable ? "Available to collect" : primary.availability === "minted" ? "Primary mint complete" : primary.saleState || primary.availability === "available" ? "Not available to collect" : "View edition details"}
            {price ? ` · ${price}` : ""}
          </p>
          <Includes items={edition.includes} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "auto", paddingTop: 8 }}>
            {action}
          </div>
          <details className="vc-colophon">
            <summary>Provenance</summary>
            <p>{chainName} · Chain {chainId}</p>
            {edition.contractAddress && <p>{edition.contractAddress}</p>}
          </details>
        </div>
      </div>
    </article>
  );
}

function shortWallet(wallet) {
  const value = String(wallet || "");
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value || "Seller unavailable";
}

export function SecondaryListingCard({ item, listings = [], owned = false, catalog = null }) {
  const { edition, artist, release, primary, chain } = item;
  const chainName = chain?.name || edition.chain || "Avalanche";
  const chainId = chain?.id || edition.chainId;
  const active = listings.filter((listing) => listing?.authority === "INDEXED" && String(listing.status).toUpperCase() === "ACTIVE");
  const tokens = [...new Set(active.map((listing) => String(listing.tokenId)))].map((tokenId) => listedTokenView(catalog, edition, release, tokenId));
  const tokenById = new Map(tokens.map((token) => [token.tokenId, token]));
  // One listed token: the card is about that token, so it leads with that token's own art and name.
  const single = tokens.length === 1 ? tokens[0] : null;
  const heading = single?.name || edition.title;
  const editionArt = artworkFor(edition, release);
  const [failedImages, setFailedImages] = useState([]);
  // Token image, then the token's local art, then the edition art; each is dropped only after it fails to load.
  const image = [single?.artwork, single?.artworkFallback, editionArt].filter(Boolean).find((src) => !failedImages.includes(src)) || editionArt;
  const showingTokenArt = Boolean(single) && image !== editionArt;

  return (
    <article className="vc-market-card" data-edition-id={edition.id}>
      <Link to={`/edition/${edition.id}`} style={{ display: "block", color: "inherit", textDecoration: "none" }} aria-label={`View ${heading} secondary listings`}>
        <img src={image} onError={() => setFailedImages((prior) => (prior.includes(image) ? prior : [...prior, image]))} alt={showingTokenArt ? `${single.name}, token #${single.tokenId} artwork` : `${edition.title} edition artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", borderBottom: "1px solid var(--vc-ash)" }} />
      </Link>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        <span className={`vc-object-mark ${objectClass(edition, chain).tone}`}>{objectClass(edition, chain).label}</span>
        <p className="vc-card-kicker">{artist?.name || "The Void"} · Secondary pressing</p>
        <h3 className="vc-card-title">{heading}</h3>
        {single?.name && <p className="vc-card-meta" style={{ margin: 0 }}>Token #{single.tokenId} · from the {edition.title} edition</p>}
        <p className="vc-card-release">{release?.id ? <Link to={`/release/${release.id}`} style={{ color: "inherit", textDecoration: "none" }}>{release.title}</Link> : release?.title || "Official release"}</p>
        <p className="vc-card-meta">{active.length} active indexed offer{active.length === 1 ? "" : "s"}</p>
        <details className="vc-colophon"><summary>Provenance</summary><p>{chainName} · Chain {chainId}</p></details>
        <Includes items={edition.includes} />
        <div aria-label="Active indexed offers" style={{ display: "grid", gap: 10 }}>
          {active.map((listing) => (
            <div key={listing.id || listing.listingId} style={{ borderTop: "1px solid var(--vc-ash)", paddingTop: 10 }}>
              <p className="vc-card-meta" style={{ margin: "0 0 4px" }}>Token #{String(listing.tokenId)} · {tokenById.get(String(listing.tokenId))?.name || "Token metadata unavailable"}</p>
              <p className="vc-card-meta" style={{ margin: "0 0 4px" }}>Seller · {shortWallet(listing.seller)}</p>
              <p className="vc-card-meta" style={{ margin: 0 }}>
                Available · {listing.amount || "—"} · {formatWeiAsAvax(listing.price) || "Price unavailable"}
              </p>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "auto", paddingTop: 8 }}>
          <Link to={`/edition/${edition.id}`} style={primaryBtn}>View edition</Link>
          {primary.availability === "available" && <Link to={primary.href} style={ghostBtn}>Collect</Link>}
          {owned && primaryExperience(item.experiences)?.id && <Link to={`/experience/${primaryExperience(item.experiences).id}`} style={ghostBtn}>Open experience</Link>}
        </div>
      </div>
    </article>
  );
}

// The artist's persisted profile picture. An image that is missing or fails to
// load falls back to the artist's initial instead of a broken-image icon.
export function ArtistAvatar({ artist, size = 56 }) {
  const [failed, setFailed] = useState("");
  const src = artist.avatar || "";
  const initial = String(artist.name || "?").trim().charAt(0).toUpperCase() || "?";
  const box = { width: size, height: size, borderRadius: "50%", border: "1px solid var(--vc-ash)", marginBottom: 14, flexShrink: 0, overflow: "hidden", background: "rgba(0,0,0,.5)" };
  if (!src || failed === src) {
    return <div role="img" aria-label={`${artist.name} profile picture placeholder`} data-testid="artist-avatar-fallback" style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: size / 2.2 }}>{initial}</div>;
  }
  return <img src={src} alt={`${artist.name} profile picture`} data-testid="artist-avatar" onError={() => setFailed(src)} style={{ ...box, objectFit: "cover", display: "block" }} />;
}

export function ArtistCard({ artist, releases = [] }) {
  return (
    <Link to={`/artist/${artist.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none", display: "flex", flexDirection: "column" }}>
      <div style={{ minHeight: 200, backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.78)), url(${artist.banner || artist.avatar || "/assets/voidcaller_art_6.png"})`, backgroundSize: "cover", backgroundPosition: "center", padding: 22, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <ArtistAvatar artist={artist} />
        <p className="vc-card-kicker">{artist.verified ? "Verified artist" : "Artist"}</p>
        <h3 className="vc-card-title" style={{ fontSize: 34 }}>{artist.name}</h3>
      </div>
      <div style={{ padding: 22 }}>
        <p className="vc-card-body">{artist.bio}</p>
        <p className="vc-card-meta" style={{ marginTop: 14 }}>
          {releases.length} release{releases.length === 1 ? "" : "s"}
        </p>
      </div>
    </Link>
  );
}

export function EmptyRail({ title, children }) {
  return (
    <div className="vc-empty-rail" role="status">
      <Eyebrow>{title}</Eyebrow>
      <p className="vc-card-body" style={{ marginTop: 10 }}>{children}</p>
    </div>
  );
}
