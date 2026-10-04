import { isLegacyMainnetCatalogRelease } from "./legacy-genesis.js";
import { isNonPublicTestRecord, isSummitDemoRecord } from "./summit-demo.js";

// Studio's release picker and "Publishing as" list hide the same test and
// certification records the public catalog already hides (test profiles such
// as asdf/qwe, "E2E", "Pinata certification", summit demos). Nothing is
// deleted; if every owned record is a test record the full list is kept.

function isHidden(item) {
  return isNonPublicTestRecord(item) || isSummitDemoRecord(item);
}

export function studioArtistChoices(artists = []) {
  const visible = artists.filter((artist) => !isHidden(artist));
  return visible.length ? visible : artists;
}

/**
 * Releases to offer in Studio: real records only, and one entry per
 * artist + title. Of duplicates, the published one wins, then the one with
 * the most editions, then the first returned (the API lists newest first).
 */
export function studioReleaseChoices({ releases = [], artists = [], editions = [] } = {}) {
  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const editionCount = new Map();
  for (const edition of editions) editionCount.set(edition.releaseId, (editionCount.get(edition.releaseId) || 0) + 1);
  const rank = (release) => (String(release.status || "").trim().toLowerCase() === "published" ? 2 : 0) + Math.min(1, editionCount.get(release.id) || 0);
  // Archived releases are retired from the catalog and are never offered,
  // whatever casing the API used (ARCHIVED or archived). The test-record
  // fallback below only sees this already-filtered list, so an empty live
  // catalog does not bring archived rows back.
  const live = releases.filter((release) => String(release.status || "").trim().toLowerCase() !== "archived");
  const all = live.map((release) => ({ release, artist: artistById.get(release.artistId) || null }));
  const real = all.filter(({ release, artist }) => !isHidden(release) && !isHidden(artist));
  const pool = real.length ? real : all;
  const chosen = new Map();
  for (const record of pool) {
    const key = `${String(record.artist?.name || "").trim().toLowerCase()}::${String(record.release.title || "").trim().toLowerCase()}`;
    const current = chosen.get(key);
    if (!current || rank(record.release) > rank(current.release)) chosen.set(key, record);
  }
  // Keep the API's order for the survivors.
  const keep = new Set([...chosen.values()].map((record) => record.release.id));
  return pool.filter((record) => keep.has(record.release.id));
}

// "Take this off the site" is for a release this artist published on Fuji.
// The original mainnet VOIDCALLER catalog stays on the site.
export function canTakeReleaseOffTheSite(release, editions = []) {
  if (String(release?.status || "").trim().toLowerCase() !== "published") return false;
  return !isLegacyMainnetCatalogRelease(release, editions);
}
