import { isLegacyMainnetCatalogRelease, isLegacyMainnetEdition } from "./legacy-genesis.js";
import { isNonPublicTestRecord, isSummitDemoRecord, isWithdrawnPublicListing } from "./summit-demo.js";

// Studio's release picker and "Publishing as" list hide the same test and
// certification records the public catalog already hides (test profiles such
// as asdf/qwe, "E2E", "Pinata certification", summit demos). Nothing is
// deleted; if every owned record is a test record the full list is kept.

function isHidden(item) {
  return isNonPublicTestRecord(item) || isSummitDemoRecord(item);
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function rememberTitle(index, key, title) {
  if (!key || !title) return;
  const titles = index.get(key) || new Set();
  titles.add(title);
  index.set(key, titles);
}

// Unpublished copies of a title this artist already retired. A published
// release with that title is the live card and stays. Matching is by artist
// id or artist name, and by title, all case-insensitive.
function retiredByArchivedTitle(release, artist, retiredByArtistId, retiredByArtistName) {
  if (normalizedText(release?.status) === "published") return false;
  const title = normalizedText(release?.title);
  if (!title) return false;
  const artistId = normalizedText(release?.artistId);
  const artistName = normalizedText(artist?.name);
  return Boolean(
    (artistId && retiredByArtistId.get(artistId)?.has(title))
    || (artistName && retiredByArtistName.get(artistName)?.has(title)),
  );
}

export function studioArtistChoices(artists = []) {
  const visible = artists.filter((artist) => !isHidden(artist));
  return visible.length ? visible : artists;
}

/**
 * Releases to offer in Studio: real records only, and one entry per
 * artist + title. Of duplicates, the published one wins, then the one with
 * the most editions, then the first returned (the API lists newest first).
 * A draft whose title matches an archived release for the same artist is
 * left out. The published release of that title, if there is one, stays.
 */
export function studioReleaseChoices({ releases = [], artists = [], editions = [] } = {}) {
  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const editionCount = new Map();
  for (const edition of editions) editionCount.set(edition.releaseId, (editionCount.get(edition.releaseId) || 0) + 1);
  const rank = (release) => (normalizedText(release.status) === "published" ? 2 : 0) + Math.min(1, editionCount.get(release.id) || 0);
  // Archived releases are retired from the catalog and are never offered,
  // whatever casing the API used (ARCHIVED or archived). An unpublished
  // release with the same title for that artist is the leftover card and is
  // not offered either. The test-record fallback below only sees this
  // already-filtered list, so an empty live catalog does not bring those
  // rows back. A published release of the same title stays.
  const artistByNormalizedId = new Map();
  for (const artist of artists) {
    const id = normalizedText(artist?.id);
    if (id && !artistByNormalizedId.has(id)) artistByNormalizedId.set(id, artist);
  }
  const artistFor = (release) => artistById.get(release.artistId) || artistByNormalizedId.get(normalizedText(release.artistId)) || null;
  const retiredByArtistId = new Map();
  const retiredByArtistName = new Map();
  for (const release of releases) {
    if (normalizedText(release.status) !== "archived") continue;
    const title = normalizedText(release.title);
    const artist = artistFor(release);
    rememberTitle(retiredByArtistId, normalizedText(release.artistId), title);
    rememberTitle(retiredByArtistName, normalizedText(artist?.name), title);
  }
  const live = releases.filter((release) => {
    if (isWithdrawnPublicListing(release)) return false;
    if (normalizedText(release.status) === "archived") return false;
    return !retiredByArchivedTitle(release, artistFor(release), retiredByArtistId, retiredByArtistName);
  });
  const all = live.map((release) => ({ release, artist: artistById.get(release.artistId) || null }));
  const real = all.filter(({ release, artist }) => !isHidden(release) && !isHidden(artist));
  const pool = real.length ? real : all;
  const chosen = new Map();
  for (const record of pool) {
    const key = `${normalizedText(record.artist?.name)}::${normalizedText(record.release.title)}`;
    const current = chosen.get(key);
    if (!current || rank(record.release) > rank(current.release)) chosen.set(key, record);
  }
  // Keep the API's order for the survivors.
  const keep = new Set([...chosen.values()].map((record) => record.release.id));
  return pool.filter((record) => keep.has(record.release.id));
}

function editionMetadata(edition) {
  const meta = edition.application_metadata ?? edition.applicationMetadata;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

// On-chain token: the catalog only exposes a token id once the edition is
// published (a draft row is not on chain yet). "available" and "minted" are
// the mapped forms of that published state.
function hasPublishedOnChainToken(edition) {
  const status = String(edition.status || "").trim().toLowerCase();
  if (status !== "published" && status !== "available" && status !== "minted") return false;
  const meta = editionMetadata(edition);
  const ids = [
    ...(Array.isArray(edition.tokenIds) ? edition.tokenIds : []),
    ...(Array.isArray(meta.tokenIds) ? meta.tokenIds : []),
    edition.tokenId,
    edition.token_id,
    meta.tokenId,
  ];
  return ids.some((id) => id !== undefined && id !== null && String(id).trim() !== "");
}

// A primary sale collectors can still buy. An intended price is not a sale,
// and a finished mint (saleStatus "minted") is not an open sale by itself.
function hasBuyablePrimarySale(edition) {
  if (edition.buyableSale === true || edition.buyable_sale === true) return true;
  const meta = editionMetadata(edition);
  if (meta.primarySale === true || meta.collectable === true || edition.primarySale === true) return true;
  const saleStatus = String(edition.saleStatus ?? meta.saleStatus ?? "").trim().toLowerCase();
  return saleStatus === "live" || saleStatus === "open" || saleStatus === "active";
}

// Mintable: an on-chain token, a primary sale collectors can buy, or the
// original mainnet VOIDCALLER catalog (already minted). Title is not used.
export function editionIsMintable(edition) {
  if (!edition || typeof edition !== "object") return false;
  return isLegacyMainnetEdition(edition) || hasPublishedOnChainToken(edition) || hasBuyablePrimarySale(edition);
}

export function releaseIsMintable(release, editions = [], { editionsAreScoped = false } = {}) {
  if (!release || typeof release !== "object") return false;
  if (isLegacyMainnetCatalogRelease(release, editions)) return true;
  const id = String(release.id ?? "").trim();
  return editions.some((edition) => {
    const editionReleaseId = String(edition?.releaseId ?? edition?.release_id ?? "").trim();
    const belongs = editionReleaseId ? editionReleaseId === id : editionsAreScoped;
    return belongs && editionIsMintable(edition);
  });
}

// The only release that can leave the site is one that is already published
// and not mintable yet. A published mintable release stays, so an artist
// cannot pull something collectors can still buy.
export function canTakeReleaseOffTheSite(release, editions = []) {
  if (String(release?.status || "").trim().toLowerCase() !== "published") return false;
  return !releaseIsMintable(release, editions);
}
