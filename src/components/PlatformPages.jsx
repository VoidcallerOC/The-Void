import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { DISCOVERY, DISCOVERY_CATEGORIES, VC_DATA } from "../data.js";
import { getArtistCatalog, getEditionCatalog, getReleaseCatalog } from "../domain/models.js";
import { supportedGatewayMediaType } from "../lib/experience-service.js";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { canAccessExperience, getCollectorLibrary } from "../lib/collection.js";
import { useWallet } from "../lib/wallet-context.js";
import { ArtistProfileEditor } from "./ArtistProfileEditor.jsx";
import { isCertifiedFujiEdition, readFujiBalance } from "../lib/fuji-release.js";
import { useAudio } from "../lib/audio.js";
import { flattenMarketplaceEditions, marketplaceCatalog, marketplaceStatusLabel, MARKETPLACE_STATE, editionPriceLabel, editionTypeLabel, resolveSecondaryStatus } from "../lib/marketplace-surface.js";
import { CollectionMarketplaceCallout, DiscoveryMarketplaceCallout } from "./MarketplaceRails.jsx";
import { ProtectedExperiencePlayer } from "./ProtectedExperiencePlayer.jsx";
import { CollectPanel } from "./CollectPanel.jsx";
import { PurchasePanel } from "./PurchasePanel.jsx";
import { ListingPanel } from "./ListingPanel.jsx";
import { ArtistCard, EditionCard } from "./MarketplaceCards.jsx";
import { artworkFor, ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { WalletButton } from "./WalletButton.jsx";
import { TokenArtwork } from "./TokenArtwork.jsx";
import { experienceTrackTitle, playableTrackFor, tokenView } from "../lib/token-view.js";
import { PlayTokenButton } from "./PlayTokenButton.jsx";
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
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600 }}>Artists are the roots of every release and experience. The verified mark is branded on-chain to the artist wallet that signed — it is not assigned by the catalog.</p>
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
  if (!result) return <Navigate to="/artists" replace />;
  const { releases, editions } = result;
  const artist = { ...result.artist, ...(profileOverride || {}) };
  const editionItems = flattenMarketplaceEditions([catalog]).filter((item) => editions.some((edition) => edition.id === item.edition.id));
  return (
    <section style={shell}>
      {children}
      <div style={{ ...card, minHeight: 280, backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.85)), url(${artist.banner})`, backgroundSize: "cover", backgroundPosition: "center", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <Status>{artist.verified ? "Verified artist" : "Artist"}</Status>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(52px, 10vw, 100px)", margin: "12px 0 4px", textTransform: "uppercase" }}>{artist.name}</h1>
        <p style={{ fontFamily: "var(--font-mono)", color: "var(--vc-bone-dim)", margin: 0 }}>@{artist.handle}</p>
      </div>
      <div style={{ maxWidth: 650, margin: "28px 0 56px", color: "var(--vc-bone-dim)", lineHeight: 1.7 }}>
        <p>{artist.bio}</p>
        {(artist.socials || []).map((social) => <a key={social.name} href={social.href} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)", marginRight: 18 }}>{social.name}</a>)}
        <ArtistProfileEditor artistId={result.artist.id} onSaved={(saved) => setProfileOverride((prior) => ({ ...(prior || {}), ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => !((key === "avatar" || key === "banner") && !value))) }))} />
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
  if (!result) return <Navigate to="/discover" replace />;
  const { release, artist } = result;
  const editionItems = flattenMarketplaceEditions([catalog]).filter((item) => item.release?.id === release.id);
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
          {editionItems[0] && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <Link to={editionItems[0].primary.href} style={primaryBtn}>{editionItems[0].primary.label}</Link>
              <Link to={`/marketplace?release=${release.id}`} style={ghostBtn}>View on marketplace</Link>
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
              const experienceId = track.experienceId || view.token?.experiences?.[0];
              const experience = catalog.experiences.find((item) => item.id === experienceId);
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
                    <PlayTokenButton track={playableTrackFor(view.token, { protectedExperience: experience })} protectedExperience={experience} queueId={`token:${view.token?.id || track.tokenId}`} collection={release.title} primary />
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
  const result = getEditionCatalog(catalog, editionId);
  if (!result && catalog.publishedLoading) {
    return <section style={shell}><p style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)" }}>Loading edition…</p></section>;
  }
  if (!result) return <Navigate to="/marketplace" replace />;
  const { edition, release, artist, experiences } = result;
  const releaseMarketplaceAsset = isReleasePerContractCandidate(edition);
  const secondary = resolveSecondaryStatus();
  const price = editionPriceLabel(edition);
  // Non-holders retain the tokenURI preview; entitled holders are upgraded
  // through the same protected experience grant used by the player.
  const previewExperience = experiences[0] || null;
  const previewTrack = playableTrackFor(tokenView(catalog, { edition, release }).token, { protectedExperience: previewExperience });
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
          {previewTrack && (
            <div style={{ marginTop: 16 }}>
              <PlayTokenButton track={previewTrack} protectedExperience={previewExperience} queueId={`preview:${edition.id}`} collection={release.title} label="Play preview" />
            </div>
          )}
          {isCertifiedFujiEdition(edition) && edition.tokenIds?.[0] !== undefined && (
            <div style={{ marginTop: 18 }}>
              <Link to={`/studio?release=${encodeURIComponent(release.id)}`} style={ghostBtn}>Artist: configure primary sale →</Link>
            </div>
          )}
          {releaseBindingFor(edition).valid && (
            <div style={{ marginTop: 18 }}>
              <Link to={`/claim/${edition.id}`} style={ghostBtn}>Open claim page</Link>
            </div>
          )}
          <CollectPanel edition={edition} release={release} artist={artist} experiences={experiences} catalog={catalog} variant="hero" />
        </div>
      </div>
      {secondary === MARKETPLACE_STATE.LIVE && releaseMarketplaceAsset && <PurchasePanel edition={edition} />}
      {releaseMarketplaceAsset && <ListingPanel edition={edition} />}
      {secondary !== MARKETPLACE_STATE.LIVE && !releaseMarketplaceAsset && (
        <p className="vc-card-meta" style={{ marginTop: 28 }}>Secondary market · not yet live. No listings are shown or invented.</p>
      )}
      {secondary === MARKETPLACE_STATE.LIVE && !releaseMarketplaceAsset && (
        <p className="vc-card-meta" style={{ marginTop: 28 }}>Secondary market · ReleaseMarketplaceV3 accepts only editions registered by the per-release factory. This edition is not offered through that market.</p>
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
  if (!experience) return <Navigate to="/discover" replace />;
  const edition = catalog.editions.find((item) => (item.experienceIds || []).includes(experience.id) || experience.editionId === item.id);
  const release = catalog.releases.find((item) => item.id === edition?.releaseId || (item.experiences || []).includes(experience.id));
  const artist = catalog.artists.find((item) => item.id === release?.artistId);
  const protectedMedia = experience.media?.protected && supportedGatewayMediaType(experience.media?.type?.toUpperCase());
  const library = getCollectorLibrary(catalog, wallet.ownershipRecords || []);
  const owned = Boolean((experience.requirements?.length && canAccessExperience(experience, wallet.ownershipRecords || [])) || library.editions.some((item) => item.edition.id === edition?.id) || (edition && String(edition.status).toLowerCase() === "minted" && !isCertifiedFujiEdition(edition)));
  const tracks = tracksForRelease(release, experience);
  const view = tokenView(catalog, { edition, release, experience });
  // A one-token experience plays that token's song; the full-EP experience keeps the queue below.
  const tokenTrack = playableTrackFor(view.token, { protectedExperience: protectedMedia ? experience : null });
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
            {tokenTrack && <PlayTokenButton track={tokenTrack} protectedExperience={protectedMedia ? experience : null} protectedOnly={Boolean(protectedMedia)} queueId={`token:${view.token.id}`} collection={release?.title || edition?.title} primary label={owned || !experience.requirements?.length ? `Play ${tokenTrack.title}` : `Play ${tokenTrack.title} preview`} />}
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
  if (!collection) return <Navigate to="/collection" replace />;
  const artist = catalog.artists.find((item) => collection.artistIds.includes(item.id));
  const releases = catalog.releases.filter((item) => collection.releaseIds.includes(item.id));
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Collection" title={collection.name}>
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>{collection.description}</p>
      </PlatformHeader>
      {artist && <p><Link to={`/artist/${artist.id}`} style={{ color: "var(--vc-bone)" }}>Artist · {artist.name}</Link></p>}
      <div className="vc-market-grid" style={{ marginTop: 28 }}>
        {releases.map((release) => (
          <Link key={release.id} to={`/release/${release.id}`} className="vc-market-card" style={{ color: "inherit", textDecoration: "none" }}>
            <img src={release.artwork} alt={`${release.title} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
            <div style={{ padding: 20 }}><Status>{release.status}</Status><h2 style={{ fontFamily: "var(--font-display)", fontSize: 30, margin: "12px 0 8px" }}>{release.title}</h2><p style={{ color: "var(--vc-bone-dim)", margin: 0 }}>{release.subtitle}</p></div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function CollectionPage() {
  const catalog = useMarketplaceCatalogs();
  return (
    <section style={shell}>
      <PlatformHeader eyebrow="† Catalog" title="The Void">
        <p style={{ color: "var(--vc-bone-dim)", maxWidth: 650 }}>A music catalog of collections, releases, songs, and the experiences attached to each token.</p>
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
          {owned.map(({ edition, release, artist, quantity, experiences, tokenId }) => {
            const view = tokenView(catalog, { edition, release, tokenId });
            const experience = experiences.find((item) => (view.token?.experiences || []).includes(item.id)) || catalog.experiences.find((item) => (view.token?.experiences || []).includes(item.id)) || experiences[0];
            return (
            <article key={`${edition.id}:${tokenId ?? ""}`} className="vc-market-card">
              <TokenArtwork sources={view.artworkSources} alt={`${view.name} artwork`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              <div style={{ padding: 20 }}>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--vc-crimson)", textTransform: "uppercase", margin: 0 }}>{artist?.name}</p>
                <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "8px 0" }}>{view.token ? view.name : release?.title || edition.title}</h3>
                <p style={{ color: "var(--vc-bone-dim)" }}>{release?.title && view.token ? `${release.title} · ` : ""}{edition.title}{view.token ? ` · Token #${view.tokenId}` : ""} · {quantity} owned</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                  <PlayTokenButton track={playableTrackFor(view.token, { protectedExperience: experience })} protectedExperience={experience} queueId={`token:${view.token?.id}`} collection={release?.title || edition.title} primary />
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
