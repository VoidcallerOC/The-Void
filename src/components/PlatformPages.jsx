import { XAccountLink } from "./XAccountLink.jsx";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useHashScroll } from "../lib/use-hash-scroll.js";
import { ListForSaleLink } from "./AssetActions.jsx";
import { Eyebrow } from "./Atoms.jsx";
import { DISCOVERY, DISCOVERY_CATEGORIES, VC_DATA } from "../data.js";
import { getArtistCatalog, getEditionCatalog, getReleaseCatalog, primaryPlayback } from "../domain/models.js";
import { supportedGatewayMediaType } from "../lib/experience-service.js";
import { useMarketplaceCatalogs, withOwnableDuplicates } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import { canAccessExperience, getCollectorLibrary } from "../lib/collection.js";
import { useWallet } from "../lib/wallet-context.js";
import { ArtistProfileEditor } from "./ArtistProfileEditor.jsx";
import { isCertifiedFujiEdition, readFujiBalance } from "../lib/fuji-release.js";
import { useAudio } from "../lib/audio.js";
import { collectableEditionGroups, editionOwnedByWallet, flattenMarketplaceEditions, marketplaceCatalog, marketplaceStatusLabel, MARKETPLACE_STATE, editionPriceLabel, editionSupplyLabel, editionTypeLabel, primaryCollectForEdition, releaseScopedFirst, resolveSecondaryStatus } from "../lib/marketplace-surface.js";
import { CollectionMarketplaceCallout } from "./MarketplaceRails.jsx";
import { ProtectedExperiencePlayer } from "./ProtectedExperiencePlayer.jsx";
import { CollectPanel } from "./CollectPanel.jsx";
import { PurchasePanel } from "./PurchasePanel.jsx";
import { ListingPanel } from "./ListingPanel.jsx";
import { ArtistAvatar, ArtistCard, EditionCard, EmptyRail, SectionHead } from "./MarketplaceCards.jsx";
import { artworkFor, ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { WalletButton } from "./WalletButton.jsx";
import { NotFoundPage } from "./NotFoundPage.jsx";
import { TokenArtwork } from "./TokenArtwork.jsx";
import { experienceTrackTitle, playableTrackFor, tokenView } from "../lib/token-view.js";
import { PlayTokenButton } from "./PlayTokenButton.jsx";
import { PrimaryPlayButton } from "./PrimaryPlayButton.jsx";
import { releaseBindingFor } from "../lib/claim-state.js";
import { isReleasePerContractCandidate } from "../lib/secondary-listing.js";

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
  const wallet = useWallet();
  const collectGroups = useMemo(() => collectableEditionGroups(collapsePublicCatalog(catalog)), [catalog]);
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Discovery" title="Currently featuring Voidcaller">
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600 }}>The catalog currently features Voidcaller.</p>
      </PlatformHeader>
      <div style={{ margin: "0 0 28px", display: "flex", gap: 10, flexWrap: "wrap" }}><Link to="/collection" style={ghostBtn}>Browse collections</Link><Link to="/marketplace" style={ghostBtn}>Secondary marketplace</Link></div>
      <nav aria-label="Discovery categories" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {DISCOVERY_CATEGORIES.map((item) => (
          <button key={item} onClick={() => setCategory(item)} style={{ ...ghostBtn, background: category === item ? "var(--vc-crimson)" : "transparent", borderColor: category === item ? "var(--vc-crimson)" : "var(--vc-ash)", color: category === item ? "#fff" : "var(--vc-bone)" }}>{item.replace("-", " ")}</button>
        ))}
      </nav>
      <div className={category === "artists" || category === "limited-editions" ? "vc-market-grid" : "vc-release-rail"}>
        {category === "artists" && items.map((artist) => <ArtistCard key={artist.id} artist={artist} releases={catalog.releases.filter((release) => release.artistId === artist.id)} />)}
        {category === "limited-editions" && items.map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />)}
        {category !== "artists" && category !== "limited-editions" && items.map((record) => (
          <Link key={record.release.id} to={`/release/${record.release.id}`} className="vc-featured-release" style={{ color: "inherit", textDecoration: "none" }}>
            <img src={record.release.artwork} alt={`${record.release.title} artwork`} />
            <div className="vc-featured-release-copy">
              <Status>The record</Status>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(40px, 6vw, 72px)", lineHeight: 0.9, margin: "8px 0", textTransform: "uppercase" }}>{record.release.title}</h2>
              <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{record.release.subtitle || record.release.description}</p>
            </div>
          </Link>
        ))}
      </div>
      <section aria-labelledby="official-editions-heading" style={{ marginTop: 56 }}>
        <SectionHead id="official-editions-heading" eyebrow="Collect" title="Official editions available to collect">
          Each official edition appears once, under its collection, and only while its primary sale is open.
        </SectionHead>
        {collectGroups.length > 0 ? collectGroups.map(({ collection, items: groupItems }) => (
          <div key={collection?.id || "more"} aria-label={collection ? `${collection.name} editions` : "More official editions"} style={{ marginBottom: 32 }}>
            {collection
              ? <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "0 0 16px" }}><Link to={`/collection/${collection.id}`} style={{ color: "inherit", textDecoration: "none" }}>{collection.name}</Link></h3>
              : collectGroups.length > 1 && <Eyebrow>More official editions</Eyebrow>}
            <div className="vc-market-grid">
              {groupItems.map((item) => <EditionCard key={item.edition.id} item={item} owned={editionOwnedByWallet(item, wallet)} />)}
            </div>
          </div>
        )) : catalog.publishedLoading ? (
          <p role="status" className="vc-card-meta">Loading official editions…</p>
        ) : (
          <EmptyRail title="Nothing to collect right now">No official edition has an open primary sale. Collections are still open to explore above.</EmptyRail>
        )}
      </section>
    </section>
  );
}

export function ArtistsPage() {
  const catalog = useMarketplaceCatalogs();
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Artists" title="Artists">
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600 }}>The catalog currently features Voidcaller. The verified mark is branded to the wallet that signed. It is not a name anyone can type.</p>
        <div style={{ marginTop: 22 }}>
          <Link to="/verify" style={ghostBtn}>Become verified</Link>
        </div>
      </PlatformHeader>
      <div className="vc-market-grid">
        {catalog.artists.map((artist) => <ArtistCard key={artist.id} artist={artist} releases={catalog.releases.filter((release) => release.artistId === artist.id)} />)}
      </div>
    </section>
  );
}

export function ArtistPage({ children = null } = {}) {
  const catalog = useMarketplaceCatalogs();
  const { artist: artistId } = useParams();
  const [profileOverride, setProfileOverride] = useState(null);
  const result = getArtistCatalog(catalog, artistId);
  const secondary = resolveSecondaryStatus();
  // Like the release and edition pages: an artist that only the published catalog knows must not be
  // declared missing on a direct load or refresh before that catalog has arrived.
  if (!result && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading artist…</p></section>;
  }
  if (!result) return <NotFoundPage kind="artist" backTo="/artists" backLabel="All artists" />;
  const { releases, editions } = result;
  const artist = { ...result.artist, ...(profileOverride || {}) };
  const editionItems = flattenMarketplaceEditions([catalog]).filter((item) => editions.some((edition) => edition.id === item.edition.id));
  return (
    <section style={shell}>
      {children}
      <div style={{ ...card, minHeight: 280, backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.85)), url(${artist.banner})`, backgroundSize: "cover", backgroundPosition: "center", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <ArtistAvatar artist={artist} size={104} />
        <Status>{artist.verified ? "Verified artist" : "Artist"}</Status>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(52px, 10vw, 100px)", margin: "12px 0 4px", textTransform: "uppercase" }}>{artist.name}</h1>
        <p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-bone-dim)", margin: 0 }}>@{artist.handle}</p>
      </div>
      <div style={{ maxWidth: 650, margin: "28px 0 56px", color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
        <p>{artist.bio}</p>
        {(artist.socials || []).map((social) => <a key={social.name} href={social.href} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)", marginRight: 18 }}>{social.name}</a>)}
        <ArtistProfileEditor artistId={result.artist.id} onSaved={(saved) => setProfileOverride((prior) => ({ ...(prior || {}), ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => !(key === "banner" && !value))) }))} />
      </div>
      {/* One section: each release appears once, as its collectible edition card
          (which names and links the release); a release with no edition yet
          keeps a plain release card. */}
      <Eyebrow>Releases</Eyebrow>
      <div className="vc-market-grid" style={{ marginTop: 16 }}>
        {releases.flatMap((release) => {
          const items = editionItems.filter((item) => item.edition.releaseId === release.id);
          if (items.length) return items.map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />);
          return [(
            <Link key={release.id} to={`/release/${release.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
              <img src={release.artwork} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              <div style={{ padding: 20 }}>
                <Status>{release.status}</Status>
                <h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{release.title}</h2>
                <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{release.subtitle}</p>
              </div>
            </Link>
          )];
        })}
        {editionItems.filter((item) => !releases.some((release) => release.id === item.edition.releaseId)).map((item) => <EditionCard key={item.edition.id} item={item} secondaryStatus={secondary} />)}
      </div>
    </section>
  );
}

export function ReleasePage({ children = null } = {}) {
  const catalog = useMarketplaceCatalogs();
  const { release: releaseId } = useParams();
  const result = getReleaseCatalog(catalog, releaseId);
  const secondary = resolveSecondaryStatus();
  if (!result && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading release…</p></section>;
  }
  if (!result) return <NotFoundPage kind="release" backTo="/discover" backLabel="Discover releases" />;
  const { release, artist } = result;
  // A release's own (factory) edition leads; a shared-contract edition never takes its place.
  const editionItems = releaseScopedFirst(flattenMarketplaceEditions([catalog]).filter((item) => item.release?.id === release.id));
  return (
    <section style={shell}>
      {children}
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
          {editionItems.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <Link to={`/marketplace?release=${release.id}`} style={primaryBtn}>View on marketplace</Link>
            </div>
          )}
        </div>
      </div>
      {release.id === "voidcaller-self-titled" && (
        <>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", marginTop: 64, textTransform: "uppercase" }}>Songs / tokens</h2>
          <div className="vc-market-grid">
            {release.tracks.map((track) => {
              const view = tokenView(catalog, { edition: editionItems[0]?.edition, release, tokenId: track.tokenId });
              const tokenExperiences = catalog.experiences.filter((item) => (view.token?.experiences || []).includes(item.id));
              // A track that names its experience keeps it; otherwise the token's primary resolves by the shared rules.
              const explicit = track.experienceId ? catalog.experiences.find((item) => item.id === track.experienceId) : null;
              const playback = track.experienceId ? { state: "explicit", experience: explicit, unavailable: false } : primaryPlayback(tokenExperiences);
              const experience = playback.experience;
              const experienceId = experience?.id || track.experienceId;
              const to = experienceId ? `/experience/${experienceId}` : `/edition/${editionItems[0]?.edition.id || "voidcaller-chapter-i"}`;
              return <article key={track.tokenId} className="vc-market-card">
                <Link to={to} style={{ color: "inherit", textDecoration: "none", display: "block" }}>
                  <TokenArtwork sources={view.artworkSources} alt={`${track.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                </Link>
                <div style={{ padding: 18 }}>
                  <Status>Token #{track.tokenId}</Status>
                  <h3 style={{ fontFamily: "var(--font-display)", fontSize: 26, margin: "10px 0 6px" }}><Link to={to} style={{ color: "inherit", textDecoration: "none" }}>{track.title}</Link></h3>
                  <p style={{ color: "var(--vc-bone-dim)", margin: "0 0 14px" }}>{track.time}</p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <PrimaryPlayButton token={view.token} playback={playback} queueId={`token:${view.token?.id || track.tokenId}`} collection={release.title} primary />
                    <Link to={to} style={ghostBtn}>Song experience</Link>
                  </div>
                </div>
              </article>;
            })}
          </div>
        </>
      )}
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
  const requestedListing = new URLSearchParams(useLocation().search).get("listing");
  const result = getEditionCatalog(catalog, editionId);
  // "List for sale" links here with #secondary-listing; scroll there once the edition (and its ListingPanel) renders.
  useHashScroll("secondary-listing", Boolean(result));
  if (!result && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading edition…</p></section>;
  }
  if (!result) return <NotFoundPage kind="edition" backTo="/marketplace" backLabel="Marketplace" />;
  const { edition, release, artist, experiences } = result;
  const releaseMarketplaceAsset = isReleasePerContractCandidate(edition);
  const secondary = resolveSecondaryStatus();
  const price = editionPriceLabel(edition);
  // Non-holders retain the tokenURI preview; entitled holders are upgraded
  // through the same protected experience grant used by the player.
  // The edition's designated primary experience (the full track), never just whichever sorts first.
  // When an edition designates a primary that is missing, invalid or ambiguous, the gated main Play is
  // withheld; the public preview stays available as its own labelled control.
  const playback = primaryPlayback(experiences);
  const previewToken = tokenView(catalog, { edition, release }).token;
  const hasPreview = Boolean(playableTrackFor(previewToken));
  const chainId = String(edition.chainId || "");
  const objectLabel = chainId === "43114" ? "The relic" : chainId === "43113" ? "Rehearsal · Fuji test pressing" : "Pressing";
  // Release-scoped editions follow their own sale: supply 0 is an open edition.
  const primary = primaryCollectForEdition(edition);
  const supplyLabel = editionSupplyLabel(edition, primary);
  const supplyClosed = !primary.releaseScoped && supplyLabel === "No pressings remain";
  return (
    <section style={shell}>
      <Eyebrow red>† {objectLabel}</Eyebrow>
      <div className="vc-edition-plate" style={{ marginTop: 18 }}>
        <img src={artworkFor(edition, release)} alt={`${edition.title} artwork`} />
        <div>
          <p className="vc-card-kicker">{artist.name}</p>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 8vw, 88px)", lineHeight: 0.9, textTransform: "uppercase", margin: "8px 0 12px" }}>{release.title}</h1>
          <p className="vc-card-release"><Link to={`/release/${release.id}`} style={{ color: "inherit", textDecoration: "none" }}>{edition.title}</Link></p>
          {edition.description && <p style={{ color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>{edition.description}</p>}
          <p className="vc-card-meta">{editionTypeLabel(edition)} · {supplyLabel}{price ? ` · ${price}` : ""}</p>
          <div style={{ margin: "18px 0" }}>
            <Eyebrow>Listen</Eyebrow>
            {hasPreview ? (
              playback.unavailable
                ? <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}><PrimaryPlayButton token={previewToken} playback={playback} queueId={`public-preview:${edition.id}`} collection={release.title} /></div>
                : <PrimaryPlayButton token={previewToken} playback={playback} queueId={`preview:${edition.id}`} collection={release.title} label="Play preview" />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p className="vc-card-meta">Public track previews for this release are available on the record page.</p>
                <Link to={`/release/${release.id}`} style={ghostBtn}>Hear previews on the release →</Link>
              </div>
            )}
          </div>
          <Eyebrow>Collector receives</Eyebrow>
          <ul style={{ color: "var(--vc-bone-dim)", lineHeight: 1.8 }}>
            {(edition.includes || []).map((item) => <li key={item}>{item}</li>)}
          </ul>
          {supplyClosed && <p className="vc-card-meta" style={{ marginTop: 12 }}>No pressings remain. This object cannot be collected.</p>}
          <CollectPanel edition={edition} release={release} artist={artist} experiences={experiences} catalog={catalog} variant="hero" />
          {secondary === MARKETPLACE_STATE.LIVE && releaseMarketplaceAsset && <PurchasePanel edition={edition} listingId={requestedListing} />}
          {isCertifiedFujiEdition(edition) && edition.tokenIds?.[0] !== undefined && (
            <div style={{ marginTop: 12 }}>
              <Link to={`/studio?release=${encodeURIComponent(release.id)}`} style={ghostBtn}>Artist: configure primary sale →</Link>
            </div>
          )}
          {releaseBindingFor(edition).valid && (
            <div style={{ marginTop: 12 }}>
              <Link to={`/claim/${edition.id}`} style={ghostBtn}>Open claim page</Link>
            </div>
          )}
        </div>
      </div>
      {experiences.length > 0 && (
        <>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(32px, 5vw, 48px)", marginTop: 56, textTransform: "uppercase" }}>What this unlocks</h2>
          <ExperienceList experiences={experiences} />
        </>
      )}
      <details className="vc-colophon" style={{ marginTop: 36 }}>
        <summary>Provenance · colophon</summary>
        <p>Secondary market · {marketplaceStatusLabel(secondary)}</p>
        <p>{release.productType || "Collectible release"} · <Link to={`/artist/${artist.id}`} style={{ color: "inherit" }}>{artist.name}</Link></p>
      </details>
      <ListingPanel edition={edition} />
    </section>
  );
}

function tracksForRelease(release, experience) {
  if (release?.id === "voidcaller-self-titled") {
    const track = experience?.media?.tokenId === undefined ? null : VC_DATA.firstEPTracks.find((item) => Number(item.tokenId) === Number(experience.media.tokenId));
    return track ? [track] : VC_DATA.firstEPTracks;
  }
  return (release?.tracks || []).filter((track) => track.previewSrc || track.src);
}

export function ExperiencePage() {
  const catalog = useMarketplaceCatalogs();
  const { experience: experienceId } = useParams();
  const experience = catalog.experiences.find((item) => item.id === experienceId);
  const audio = useAudio();
  const wallet = useWallet();
  const [playbackError, setPlaybackError] = useState("");
  if (!experience && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading experience…</p></section>;
  }
  if (!experience) return <NotFoundPage kind="experience" backTo="/discover" backLabel="Discover releases" />;
  const edition = catalog.editions.find((item) => (item.experienceIds || []).includes(experience.id) || experience.editionId === item.id);
  const release = catalog.releases.find((item) => item.id === edition?.releaseId || (item.experiences || []).includes(experience.id));
  const artist = catalog.artists.find((item) => item.id === release?.artistId);
  const protectedMedia = experience.media?.protected && supportedGatewayMediaType(experience.media?.type?.toUpperCase());
  const library = getCollectorLibrary(catalog, wallet.ownershipRecords || []);
  const owned = Boolean((experience.requirements?.length && canAccessExperience(experience, wallet.ownershipRecords || [])) || library.editions.some((item) => item.edition.id === edition?.id) || (edition && String(edition.status).toLowerCase() === "minted" && !isCertifiedFujiEdition(edition)));
  const tracks = tracksForRelease(release, experience);
  const view = tokenView(catalog, { edition, release, experience });
  // A one-token experience plays that token's song; the full-EP experience keeps the queue below.
  // A protected experience with its own audio (e.g. a demo attached to the token) is named after
  // the experience while its bearer stream plays; the public preview keeps the token's name.
  const baseTrack = playableTrackFor(view.token, { protectedExperience: protectedMedia ? experience : null });
  const tokenTrack = baseTrack && protectedMedia && baseTrack.protectedMedia ? { ...baseTrack, protectedTitle: experienceTrackTitle({ experience, tokenTrack: baseTrack, view }) } : baseTrack;
  const access = experience.requirements?.length ? (owned ? "Unlocked for this collector" : "Collector authorization required") : "Open experience";
  const queueId = release?.id || experience.id;
  const isPlaying = audio.queueId === queueId && audio.playing;
  const hear = async () => {
    if (!tracks.length) {
      setPlaybackError("No playable tracks are attached to this experience yet.");
      return;
    }
    setPlaybackError("");
    if (isPlaying) {
      audio.pause();
      return;
    }
    audio.setQueue(tracks, queueId, release?.title || experience.title);
    try {
      await audio.play(0);
    } catch {
      setPlaybackError("Playback could not start. Check the browser’s audio permission and try again.");
    }
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
        <TokenArtwork sources={view.artworkSources} alt={`${view.name} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", border: "1px solid var(--vc-ash)" }} />
        <div style={card}>
          <Status>{access}</Status>
          {view.token && <p className="vc-card-meta" style={{ margin: "10px 0 0" }}>{view.name} · Token #{view.tokenId}{edition ? ` · ${edition.title}` : ""}</p>}
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
            {tokenTrack && <PlayTokenButton track={tokenTrack} protectedExperience={protectedMedia ? experience : null} protectedOnly={Boolean(protectedMedia)} queueId={`token:${view.token.id}`} collection={release?.title || edition?.title} primary label={owned || !experience.requirements?.length ? `Play ${tokenTrack.protectedTitle || tokenTrack.title}` : `Play ${tokenTrack.title} preview`} />}
            {!tokenTrack && tracks.length > 0 && (
              <button type="button" style={primaryBtn} onClick={hear}>
                {isPlaying ? "Pause experience" : owned || !experience.requirements?.length ? "Open experience" : "Hear the preview"}
              </button>
            )}
            {edition && !owned && <Link to={`/edition/${edition.id}`} style={tracks.length || tokenTrack ? ghostBtn : primaryBtn}>Collect</Link>}
            {edition && owned && <Link to={`/edition/${edition.id}`} style={ghostBtn}>Owned</Link>}
            <Link to="/my-collection" style={ghostBtn}>My collection</Link>
          </div>
          {playbackError && <p role="status" style={{ color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6 }}>{playbackError}</p>}
          {experience.media?.protected && edition && isCertifiedFujiEdition(edition) && <ProtectedExperiencePlayer experience={experience} title={experienceTrackTitle({ experience, tokenTrack, view })} art={view.artworkSources?.[0]} collection={release?.title || edition?.title} />}
        </div>
      </div>
    </section>
  );
}

export function CollectionDetailPage() {
  const catalog = useMarketplaceCatalogs();
  const { collection: collectionId } = useParams();
  const collection = catalog.collections.find((item) => item.id === collectionId);
  if (!collection && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading collection…</p></section>;
  }
  if (!collection) return <NotFoundPage kind="collection" backTo="/collection" backLabel="All collections" />;
  const artist = catalog.artists.find((item) => collection.artistIds.includes(item.id));
  const releases = catalog.releases.filter((item) => collection.releaseIds.includes(item.id));
  // Published releases by the collection's artist that the collection does not list stay reachable.
  const moreReleases = catalog.releases.filter((item) => collection.artistIds.includes(item.artistId) && !collection.releaseIds.includes(item.id));
  const releaseCard = (release) => (
    <Link key={release.id} to={`/release/${release.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
      <img src={release.artwork} alt={`${release.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
      <div style={{ padding: 20 }}><Status>{release.status}</Status><h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{release.title}</h2><p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{release.subtitle}</p></div>
    </Link>
  );
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Collection" title={collection.name}>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>{collection.description}</p>
      </PlatformHeader>
      {artist && <p><Link to={`/artist/${artist.id}`} style={{ color: "var(--vc-bone)" }}>Artist · {artist.name}</Link></p>}
      <div className="vc-market-grid" style={{ marginTop: 28 }}>
        {releases.map(releaseCard)}
      </div>
      {moreReleases.length > 0 && (
        <>
          <Eyebrow>More from {artist?.name || "this artist"}</Eyebrow>
          <div className="vc-market-grid" style={{ marginTop: 16 }}>
            {moreReleases.map(releaseCard)}
          </div>
        </>
      )}
    </section>
  );
}

export function CollectionPage() {
  const catalog = useMarketplaceCatalogs();
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Catalog" title="The Void">
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>Collections as records. Open one to see the pressing.</p>
      </PlatformHeader>
      <div className="vc-market-grid">
        {catalog.collections.map((collection) => {
          const artist = catalog.artists.find((item) => collection.artistIds.includes(item.id));
          const release = catalog.releases.find((item) => collection.releaseIds.includes(item.id));
          return <Link key={collection.id} to={`/collection/${collection.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
            <img src={release?.artwork || artist?.banner} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
            <div style={{ padding: 20 }}><Status>{artist?.name || "Collection"}</Status><h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{collection.name}</h2><p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{collection.description}</p><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase" }}>Open collection</p></div>
          </Link>;
        })}
      </div>
      <div style={{ marginTop: 28 }}><Link to="/my-collection" style={ghostBtn}>My collection</Link></div>
    </section>
  );
}

export function MyCollectionPage() {
  // Same-title releases are collapsed for discovery only; a held edition must still resolve here.
  const published = useMarketplaceCatalogs();
  const catalog = useMemo(() => withOwnableDuplicates(published), [published]);
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
  // One card per owned token: each track is its own token with its own art.
  const owned = library.editions.flatMap((item) => item.holdings.map((holding) => ({ ...item, tokenId: holding.tokenId, quantity: Number(holding.amount) })));
  for (const item of fujiItems) {
    if (!owned.some((row) => row.edition.id === item.edition.id)) owned.push({ ...item, tokenId: item.edition.tokenIds?.[0] ?? null });
  }

  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Collection" title="My collection">
        <p style={{ color: "var(--vc-bone-dim)" }}>Owned editions and the experiences they unlock.</p>
      </PlatformHeader>
      <div style={{ marginBottom: 32 }}><XAccountLink /></div>
      {!wallet.connected ? (
        <div style={{ ...card, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>Connect a wallet to reveal your collection.</p>
          <WalletButton />
        </div>
      ) : owned.length === 0 ? (
        <div style={card}>
          <div className="vc-reliquary-empty"><Eyebrow red>† Reliquary</Eyebrow><h2>{wallet.loadingOwnership ? "Reading the chain…" : "Nothing held"}</h2><p style={{ color: "var(--vc-bone-dim)", maxWidth: 460 }}>{wallet.loadingOwnership ? "Reading the chain…" : "The reliquary is empty. Connect a wallet that holds a pressing, or leave it closed."}</p></div>
          <Link to="/marketplace" style={primaryBtn}>Enter marketplace</Link>
        </div>
      ) : (
        <div className="vc-market-grid">
          {owned.map(({ edition, release, artist, quantity, experiences, tokenId }) => {
            const view = tokenView(catalog, { edition, release, tokenId });
            const ofToken = (list) => list.filter((item) => (view.token?.experiences || []).includes(item.id));
            // Fall back to a wider pool only when this one has nothing for the token; an edition that
            // designates a primary never falls back to another experience.
            const pool = ofToken(experiences).length ? ofToken(experiences) : ofToken(catalog.experiences).length ? ofToken(catalog.experiences) : experiences;
            const playback = primaryPlayback(pool);
            const experience = playback.experience;
            return (
            <article key={`${edition.id}:${tokenId ?? ""}`} className="vc-market-card">
              <TokenArtwork sources={view.artworkSources} alt={`${view.name} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              <div style={{ padding: 20 }}>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase", margin: 0 }}>{artist?.name}</p>
                <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "8px 0" }}>{view.token ? view.name : release?.title || edition.title}</h3>
                <p style={{ color: "var(--vc-bone-dim)" }}>{release?.title && view.token ? `${release.title} · ` : ""}{edition.title}{view.token ? ` · Token #${view.tokenId}` : ""} · {quantity} owned</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                  <PrimaryPlayButton token={view.token} playback={playback} queueId={`token:${view.token?.id}`} collection={release?.title || edition.title} primary />
                  <ListForSaleLink edition={edition} tokenId={tokenId} owned style={ghostBtn} />
                  <Link to={`/edition/${edition.id}`} style={ghostBtn}>Owned</Link>
                  {experience && <Link to={`/experience/${experience.id}`} style={ghostBtn}>Open experience</Link>}
                </div>
              </div>
            </article>
            );
          })}
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
      <Link style={primaryBtn} to="/my-collection">View my collection</Link>
    </section>
  );
}
