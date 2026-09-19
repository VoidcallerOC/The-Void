import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { DISCOVERY, DISCOVERY_CATEGORIES, VC_DATA } from "../data.js";
import { getArtistCatalog, getEditionCatalog, getReleaseCatalog } from "../domain/models.js";
import { supportedGatewayMediaType } from "../lib/experience-service.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { getCollectorLibrary } from "../lib/collection.js";
import { useWallet } from "../lib/wallet-context.js";
import { isCertifiedFujiEdition, readFujiBalance } from "../lib/fuji-release.js";
import { useAudio } from "../lib/audio.js";
import { flattenMarketplaceEditions, marketplaceCatalog, marketplaceStatusLabel, MARKETPLACE_STATE, editionPriceLabel, editionTypeLabel, resolveSecondaryStatus } from "../lib/marketplace-surface.js";
import { CollectionMarketplaceCallout, DiscoveryMarketplaceCallout } from "./MarketplaceRails.jsx";
import { CollectPanel } from "./CollectPanel.jsx";
import { PurchasePanel } from "./PurchasePanel.jsx";
import { ListingPanel } from "./ListingPanel.jsx";
import { ArtistCard, EditionCard } from "./MarketplaceCards.jsx";
import { artworkFor, ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { WalletButton } from "./WalletButton.jsx";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: "24px" };
function PlatformHeader({ eyebrow, title, children }) {
  return (
    <header style={{ marginBottom: 40 }}>
      <Eyebrow red>{eyebrow}</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", lineHeight: 0.92, textTransform: "uppercase", margin: "16px 0" }}>{title}</h1>
      {children}
    </header>
  );
}
function Status({ children }) {
  return <span style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase" }}>{children}</span>;
}
function ExperienceList({ experiences = [] }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {experiences.map((experience) => (
        <Link key={experience.id} to={`/experience/${experience.id}`} style={{ ...card, padding: 18, color: "inherit", textDecoration: "none" }}>
          <Status>{experience.experienceType} · {experience.requirements?.length ? "Ownership gated" : "Open access"}</Status>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 24, margin: "10px 0 6px" }}>{experience.title}</h3>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{experience.description}</p>
          {experience.media?.protected && <p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".1em", marginBottom: 0 }}>Protected media · collector authorization required</p>}
        </Link>
      ))}
    </div>
  );
}

export function DiscoverPage() {
  const catalog = useMarketplaceCatalogs();
  const [category, setCategory] = useState("featured");
  const ids = DISCOVERY[category] || [];
  const records = marketplaceCatalog([catalog]);
  const items = category === "artists"
    ? catalog.artists.filter((artist) => !ids.length || ids.includes(artist.id))
    : category === "limited-editions"
      ? flattenMarketplaceEditions([catalog]).filter((item) => !ids.length || ids.includes(item.edition.id))
      : records.filter((record) => !ids.length || ids.includes(record.release.id));
  const secondary = resolveSecondaryStatus();
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Discovery" title="Find the next record">
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600 }}>Artists, releases, and editions. Marketplace is where you collect them.</p>
      </PlatformHeader>
      <DiscoveryMarketplaceCallout />
      <nav aria-label="Discovery categories" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {DISCOVERY_CATEGORIES.map((item) => (
          <button key={item} onClick={() => setCategory(item)} style={{ ...ghostBtn, background: category === item ? "var(--vc-crimson)" : "transparent", borderColor: category === item ? "var(--vc-crimson)" : "var(--vc-ash)", color: category === item ? "#fff" : "var(--vc-bone)" }}>{item.replace("-", " ")}</button>
        ))}
      </nav>
      <div className="vc-market-grid">
        {category === "artists" && items.map((artist) => <ArtistCard key={artist.id} artist={artist} releases={catalog.releases.filter((release) => release.artistId === artist.id)} />)}
        {category === "limited-editions" && items.map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />)}
        {category !== "artists" && category !== "limited-editions" && items.map((record) => (
          <Link key={record.release.id} to={`/release/${record.release.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
            <img src={record.release.artwork} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
            <div style={{ padding: 20 }}>
              <Status>{record.release.status}</Status>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{record.release.title}</h2>
              <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{record.release.subtitle}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function ArtistsPage() {
  const catalog = useMarketplaceCatalogs();
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Artists" title="Artists">
        <p style={{ color: "var(--vc-bone-dim)" }}>Artists are the roots of every release and experience.</p>
      </PlatformHeader>
      <div className="vc-market-grid">
        {catalog.artists.map((artist) => <ArtistCard key={artist.id} artist={artist} releases={catalog.releases.filter((release) => release.artistId === artist.id)} />)}
      </div>
    </section>
  );
}

export function ArtistPage() {
  const catalog = useMarketplaceCatalogs();
  const { artist: artistId } = useParams();
  const result = getArtistCatalog(catalog, artistId);
  const secondary = resolveSecondaryStatus();
  if (!result) return <Navigate to="/artists" replace />;
  const { artist, releases, editions } = result;
  const editionItems = flattenMarketplaceEditions([catalog]).filter((item) => editions.some((edition) => edition.id === item.edition.id));
  return (
    <section style={shell}>
      <div style={{ ...card, minHeight: 280, backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.85)), url(${artist.banner})`, backgroundSize: "cover", backgroundPosition: "center", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <Status>{artist.verified ? "Verified artist" : "Artist"}</Status>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(52px, 10vw, 100px)", margin: "12px 0 4px", textTransform: "uppercase" }}>{artist.name}</h1>
        <p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-bone-dim)", margin: 0 }}>@{artist.handle}</p>
      </div>
      <div style={{ maxWidth: 650, margin: "28px 0 56px", color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
        <p>{artist.bio}</p>
        {(artist.socials || []).map((social) => <a key={social.name} href={social.href} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)", marginRight: 18 }}>{social.name}</a>)}
      </div>
      <Eyebrow>Releases</Eyebrow>
      <div className="vc-market-grid" style={{ margin: "16px 0 48px" }}>
        {releases.map((release) => (
          <Link key={release.id} to={`/release/${release.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
            <img src={release.artwork} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
            <div style={{ padding: 20 }}>
              <Status>{release.status}</Status>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{release.title}</h2>
              <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{release.subtitle}</p>
            </div>
          </Link>
        ))}
      </div>
      <Eyebrow>Editions</Eyebrow>
      <div className="vc-market-grid" style={{ marginTop: 16 }}>
        {editionItems.map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />)}
      </div>
    </section>
  );
}

export function ReleasePage() {
  const catalog = useMarketplaceCatalogs();
  const { release: releaseId } = useParams();
  const result = getReleaseCatalog(catalog, releaseId);
  const secondary = resolveSecondaryStatus();
  if (!result) return <Navigate to="/discover" replace />;
  const { release, artist } = result;
  const editionItems = flattenMarketplaceEditions([catalog]).filter((item) => item.release?.id === release.id);
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Release" title={release.title}>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>{release.description}</p>
        <p><Link to={`/artist/${artist.id}`} style={{ color: "var(--vc-bone)" }}>{artist.name}</Link> · <Status>{release.status}</Status></p>
      </PlatformHeader>
      <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1.15fr)", gap: 32, alignItems: "start" }}>
        <img src={release.artwork} alt={`${release.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", border: "1px solid var(--vc-ash)" }} />
        <div>
          <Eyebrow>The story</Eyebrow>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>{release.story}</p>
          {release.tracks?.length > 0 && (
            <>
              <Eyebrow>Tracks</Eyebrow>
              <ol style={{ color: "var(--vc-bone-dim)", lineHeight: 2 }}>{release.tracks.map((track) => <li key={track.n}>{track.title} <span style={{ opacity: 0.6 }}>· {track.time}</span></li>)}</ol>
            </>
          )}
          {editionItems[0] && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <Link to={editionItems[0].primary.href} style={primaryBtn}>{editionItems[0].primary.label}</Link>
              <Link to={`/marketplace?release=${release.id}`} style={ghostBtn}>View on marketplace</Link>
            </div>
          )}
        </div>
      </div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", marginTop: 64, textTransform: "uppercase" }}>Collectible releases</h2>
      <div className="vc-market-grid">
        {editionItems.length ? editionItems.map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />) : <div style={card}><Status>Forthcoming</Status><p style={{ color: "var(--vc-bone-dim)" }}>Editions will appear here when this release is collectible.</p></div>}
      </div>
      {result.experiences?.length > 0 && (
        <>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", marginTop: 64, textTransform: "uppercase" }}>Experiences</h2>
          <ExperienceList experiences={result.experiences} />
        </>
      )}
    </section>
  );
}

export function EditionPage() {
  const catalog = useMarketplaceCatalogs();
  const { edition: editionId } = useParams();
  const result = getEditionCatalog(catalog, editionId);
  if (!result) return <Navigate to="/marketplace" replace />;
  const { edition, release, artist, experiences } = result;
  const secondary = resolveSecondaryStatus();
  const price = editionPriceLabel(edition);
  return (
    <section style={shell}>
      <PlatformHeader eyebrow={`† ${release.productType || "Collectible release"}`} title={release.title}>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>{edition.description}</p>
        <p>
          <Link to={`/artist/${artist.id}`} style={{ color: "var(--vc-bone)" }}>{artist.name}</Link>
          {" · "}
          <Link to={`/release/${release.id}`} style={{ color: "var(--vc-bone)" }}>{release.title}</Link>
        </p>
      </PlatformHeader>
      <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1.1fr)", gap: 28, alignItems: "start" }}>
        <img src={artworkFor(edition, release)} alt={`${edition.title} artwork`} style={{ width: "100%", minHeight: 320, aspectRatio: "1", objectFit: "cover", border: "1px solid var(--vc-ash)", display: "block" }} />
        <div style={card}>
          <Eyebrow>Collector receives</Eyebrow>
          <ul style={{ color: "var(--vc-bone-dim)", lineHeight: 2 }}>
            {(edition.includes || []).map((item) => <li key={item}>{item}</li>)}
          </ul>
          <Eyebrow>Experience</Eyebrow>
          <ul style={{ color: "var(--vc-bone-dim)", lineHeight: 2 }}>
            {experiences.length ? experiences.map((experience) => <li key={experience.id}>{experience.title}</li>) : <li>No attached experiences.</li>}
          </ul>
          <p className="vc-card-meta" style={{ marginTop: 16 }}>
            {editionTypeLabel(edition)} · Supply {edition.supply || "Open"}
            {price ? ` · ${price}` : ""}
          </p>
          <p className="vc-card-meta" style={{ marginTop: 10 }}>
            Secondary market · {marketplaceStatusLabel(secondary)}
          </p>
          <CollectPanel edition={edition} release={release} artist={artist} experiences={experiences} catalog={catalog} variant="hero" />
        </div>
      </div>
      {secondary === MARKETPLACE_STATE.LIVE && (
        <>
          <PurchasePanel edition={edition} />
          <ListingPanel edition={edition} />
        </>
      )}
      {secondary !== MARKETPLACE_STATE.LIVE && (
        <p className="vc-card-meta" style={{ marginTop: 28 }}>Secondary market · not yet live. No listings are shown or invented.</p>
      )}
      {experiences.length > 0 && (
        <>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", marginTop: 64, textTransform: "uppercase" }}>What this unlocks</h2>
          <ExperienceList experiences={experiences} />
        </>
      )}
    </section>
  );
}

function tracksForRelease(release) {
  if (release?.id === "voidcaller-self-titled") return VC_DATA.firstEPTracks;
  return (release?.tracks || []).filter((track) => track.previewSrc || track.src);
}

export function ExperiencePage() {
  const catalog = useMarketplaceCatalogs();
  const { experience: experienceId } = useParams();
  const experience = catalog.experiences.find((item) => item.id === experienceId);
  const audio = useAudio();
  const wallet = useWallet();
  if (!experience) return <Navigate to="/discover" replace />;
  const edition = catalog.editions.find((item) => (item.experienceIds || []).includes(experience.id) || experience.editionId === item.id);
  const release = catalog.releases.find((item) => item.id === edition?.releaseId || (item.experiences || []).includes(experience.id));
  const artist = catalog.artists.find((item) => item.id === release?.artistId);
  const protectedMedia = experience.media?.protected && supportedGatewayMediaType(experience.media?.type?.toUpperCase());
  const library = getCollectorLibrary(catalog, wallet.ownershipRecords || []);
  const owned = Boolean(library.editions.some((item) => item.edition.id === edition?.id) || (edition && String(edition.status).toLowerCase() === "minted" && !isCertifiedFujiEdition(edition)));
  const tracks = tracksForRelease(release);
  const access = experience.requirements?.length ? (owned ? "Unlocked for this collector" : "Collector authorization required") : "Open experience";
  const hear = () => {
    if (!tracks.length) return;
    audio.setQueue(tracks, release?.id || experience.id);
    audio.play(0);
  };
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Experience" title={experience.title}>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>{experience.description}</p>
        {(artist || release) && (
          <p>
            {artist && <Link to={`/artist/${artist.id}`} style={{ color: "var(--vc-bone)" }}>{artist.name}</Link>}
            {artist && release ? " · " : ""}
            {release && <Link to={`/release/${release.id}`} style={{ color: "var(--vc-bone)" }}>{release.title}</Link>}
          </p>
        )}
      </PlatformHeader>
      <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.9fr) minmax(280px, 1.2fr)", gap: 28, alignItems: "start" }}>
        <img src={artworkFor(edition, release)} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", border: "1px solid var(--vc-ash)" }} />
        <div style={card}>
          <Status>{access}</Status>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 38, margin: "14px 0" }}>{owned ? "Unlocked" : "The session"}</h2>
          <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
            {protectedMedia
              ? owned
                ? "This experience is delivered by the production media gateway. Connect an authenticated wallet that currently holds the edition."
                : "Hold the edition to unlock the full session. Connect a wallet, collect, then return here."
              : "This experience is available without protected media authorization."}
          </p>
          {tracks.length > 0 && (
            <ol style={{ color: "var(--vc-bone-dim)", lineHeight: 2 }}>
              {tracks.map((track) => <li key={track.n || track.title}>{track.title}{track.time ? ` · ${track.time}` : ""}</li>)}
            </ol>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
            {tracks.length > 0 && (
              <button type="button" style={primaryBtn} onClick={hear}>
                {owned || !experience.requirements?.length ? "Open experience" : "Hear the preview"}
              </button>
            )}
            {edition && !owned && <Link to={`/edition/${edition.id}`} style={tracks.length ? ghostBtn : primaryBtn}>Collect</Link>}
            {edition && owned && <Link to={`/edition/${edition.id}`} style={ghostBtn}>Owned</Link>}
            <Link to="/collection" style={ghostBtn}>My collection</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CollectionPage() {
  const catalog = useMarketplaceCatalogs();
  const wallet = useWallet();
  const library = useMemo(() => getCollectorLibrary(catalog, wallet.ownershipRecords || []), [catalog, wallet.ownershipRecords]);
  const [fujiOwned, setFujiOwned] = useState([]);

  useEffect(() => {
    if (!wallet.connected || !wallet.account) return undefined;
    let live = true;
    const editions = catalog.editions.filter((edition) => isCertifiedFujiEdition(edition) && edition.tokenIds?.length);
    Promise.all(editions.map(async (edition) => {
      try {
        const amount = await readFujiBalance(wallet.getProvider(), wallet.account, edition.tokenIds[0]);
        return amount > 0n ? { edition, amount } : null;
      } catch {
        return null;
      }
    })).then((rows) => { if (live) setFujiOwned(rows.filter(Boolean)); });
    return () => { live = false; };
  }, [catalog, wallet]);

  const fujiItems = (wallet.connected && wallet.account ? fujiOwned : []).map(({ edition, amount }) => {
    const release = catalog.releases.find((item) => item.id === edition.releaseId);
    const artist = catalog.artists.find((item) => item.id === release?.artistId);
    const experiences = catalog.experiences.filter((experience) => (edition.experienceIds || []).includes(experience.id) || experience.editionId === edition.id);
    return { edition, release, artist, quantity: Number(amount), experiences };
  });
  const owned = [...library.editions];
  for (const item of fujiItems) {
    if (!owned.some((row) => row.edition.id === item.edition.id)) owned.push(item);
  }

  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Collection" title="My collection">
        <p style={{ color: "var(--vc-bone-dim)" }}>Owned editions and the experiences they unlock.</p>
      </PlatformHeader>
      {!wallet.connected ? (
        <div style={{ ...card, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Connect a wallet to reveal your collection.</p>
          <WalletButton />
        </div>
      ) : owned.length === 0 ? (
        <div style={card}>
          <p style={{ color: "var(--vc-bone-dim)" }}>{wallet.loadingOwnership ? "Reading the chain…" : "No supported editions found for this wallet yet."}</p>
          <Link to="/marketplace" style={primaryBtn}>Enter marketplace</Link>
        </div>
      ) : (
        <div className="vc-market-grid">
          {owned.map(({ edition, release, artist, quantity, experiences }) => (
            <article key={edition.id} className="vc-market-card">
              <img src={artworkFor(edition, release)} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              <div style={{ padding: 20 }}>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase", margin: 0 }}>{artist?.name}</p>
                <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "8px 0" }}>{release?.title || edition.title}</h3>
                <p style={{ color: "var(--vc-bone-dim)" }}>{edition.title} · {quantity} owned</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                  <Link to={`/edition/${edition.id}`} style={primaryBtn}>Owned</Link>
                  {experiences[0] && <Link to={`/experience/${experiences[0].id}`} style={ghostBtn}>Open experience</Link>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <div style={{ marginTop: 28, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link style={ghostBtn} to="/reliquary">Open reliquary</Link>
        <Link style={ghostBtn} to="/studio">Artist studio</Link>
      </div>
      <CollectionMarketplaceCallout />
    </section>
  );
}

export function CollectorsPage() {
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Collectors" title="Collectors">
        <p style={{ color: "var(--vc-bone-dim)" }}>A home for collector identity and earned experiences.</p>
      </PlatformHeader>
      <Link style={primaryBtn} to="/collection">View my collection</Link>
    </section>
  );
}
