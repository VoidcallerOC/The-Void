import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import {
  editionPriceLabel,
  editionTypeLabel,
  MARKETPLACE_STATE,
} from "../lib/marketplace-surface.js";
import { artworkFor, ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

export function SectionHead({ eyebrow, title, children, action }) {
  return (
    <div className="vc-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, margin: "64px 0 22px", flexWrap: "wrap" }}>
      <div>
        {eyebrow && <Eyebrow red>{eyebrow}</Eyebrow>}
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 52px)", lineHeight: 0.95, textTransform: "uppercase", margin: "10px 0 0" }}>{title}</h2>
        {children && <p style={{ color: "var(--vc-bone-dim)", maxWidth: 640, lineHeight: 1.65, margin: "12px 0 0" }}>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function QuietStatus({ primary, secondary }) {
  return (
    <p className="vc-quiet-status" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", margin: 0 }}>
      Primary collect · {primary} · Secondary · {secondary}
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

function CollectCta({ primary, owned }) {
  const collectable = primary.availability === "available";
  return (
    <Link to={primary.href} style={collectable || owned ? primaryBtn : ghostBtn}>
      {owned ? "Open experience" : collectable ? "Collect" : "View edition"}
    </Link>
  );
}

export function EditionCard({ item, listings = [], secondaryStatus }) {
  const { edition, artist, release, experiences, primary } = item;
  const image = artworkFor(edition, release);
  const owned = primary.availability === "minted";
  const liveSecondary = secondaryStatus === MARKETPLACE_STATE.LIVE && listings.length > 0;
  const price = editionPriceLabel(edition);
  return (
    <article className="vc-market-card">
      <Link to={`/edition/${edition.id}`} style={{ display: "block", color: "inherit", textDecoration: "none" }}>
        <img src={image} alt={`${edition.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", borderBottom: "1px solid var(--vc-ash)" }} />
      </Link>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        <p className="vc-card-kicker">{artist?.name}</p>
        <p className="vc-card-release">{release?.title}</p>
        <h3 className="vc-card-title">{edition.title}</h3>
        <p className="vc-card-body">{edition.description}</p>
        <p className="vc-card-meta">
          {editionTypeLabel(edition)} · {edition.supply || "Open supply"} · {owned ? "Minted" : edition.status}
          {price ? ` · ${price}` : ""}
        </p>
        <Includes items={edition.includes} />
        <div>
          <Eyebrow>Experience</Eyebrow>
          <p className="vc-card-body" style={{ marginTop: 8 }}>
            {experiences.length ? experiences.map((experience) => experience.title).join(" · ") : "No attached experiences."}
          </p>
        </div>
        <p className="vc-card-meta">
          {owned ? "Owned" : primary.availability === "available" ? "Available to collect" : "Unavailable"}
          {liveSecondary ? ` · ${listings.length} secondary listing${listings.length === 1 ? "" : "s"}` : ""}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "auto", paddingTop: 8 }}>
          <CollectCta primary={primary} owned={owned} />
          <Link to={`/release/${release?.id}`} style={ghostBtn}>Release</Link>
        </div>
      </div>
    </article>
  );
}

export function FeaturedReleaseCard({ record }) {
  const { release, artist, editions } = record;
  const featured = editions.find((item) => item.primary.availability === "available") || editions[0];
  if (!featured) return null;
  const { edition, experiences, primary } = featured;
  const owned = primary.availability === "minted";
  const price = editionPriceLabel(edition);
  return (
    <article className="vc-featured-release">
      <Link to={`/release/${release.id}`} style={{ display: "block", minHeight: 280 }}>
        <img src={artworkFor(edition, release)} alt={`${release.title} artwork`} />
      </Link>
      <div className="vc-featured-release-copy">
        <p className="vc-card-kicker">{artist?.name}</p>
        <h3 className="vc-card-title" style={{ fontSize: "clamp(32px, 4vw, 48px)" }}>{release.title}</h3>
        <p className="vc-card-release">{edition.title}</p>
        <p className="vc-card-body">{edition.description || release.description}</p>
        <p className="vc-card-meta">
          {editionTypeLabel(edition)} · {edition.supply || "Open supply"} · {owned ? "Minted" : edition.status}
          {price ? ` · ${price}` : ""}
        </p>
        <Includes items={edition.includes} />
        <p className="vc-card-body">
          Experience · {experiences.length ? experiences.map((experience) => experience.title).join(" · ") : "No attached experiences."}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <CollectCta primary={primary} owned={owned} />
          <Link to={`/release/${release.id}`} style={ghostBtn}>Open release</Link>
        </div>
      </div>
    </article>
  );
}

export function ReleaseCard({ record }) {
  const { release, artist, editions } = record;
  const available = editions.filter((item) => item.primary.availability === "available").length;
  const featured = editions.find((item) => item.primary.availability === "available") || editions[0];
  return (
    <article className="vc-market-card">
      <Link to={`/release/${release.id}`} style={{ color: "inherit", textDecoration: "none", display: "flex", flexDirection: "column", flex: 1 }}>
        <img src={release.artwork} alt={`${release.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", borderBottom: "1px solid var(--vc-ash)" }} />
        <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          <p className="vc-card-kicker">{artist?.name}</p>
          <h3 className="vc-card-title">{release.title}</h3>
          <p className="vc-card-release">{featured?.edition?.title || release.subtitle}</p>
          <p className="vc-card-body">{release.description}</p>
          <p className="vc-card-meta">
            {editions.length} edition{editions.length === 1 ? "" : "s"} · {available ? `${available} available` : release.status}
          </p>
        </div>
      </Link>
      {featured && (
        <div style={{ padding: "0 22px 22px", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <CollectCta primary={featured.primary} owned={featured.primary.availability === "minted"} />
          <Link to={`/release/${release.id}`} style={ghostBtn}>Release</Link>
        </div>
      )}
    </article>
  );
}

export function ArtistCard({ artist, releases = [] }) {
  return (
    <Link to={`/artist/${artist.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none", display: "flex", flexDirection: "column" }}>
      <div style={{ minHeight: 200, backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.78)), url(${artist.banner || artist.avatar || "/assets/voidcaller_art_6.png"})`, backgroundSize: "cover", backgroundPosition: "center", padding: 22, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <p className="vc-card-kicker">Artist</p>
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
    <div className="vc-empty-rail">
      <Eyebrow>{title}</Eyebrow>
      <p className="vc-card-body" style={{ marginTop: 10 }}>{children}</p>
    </div>
  );
}
