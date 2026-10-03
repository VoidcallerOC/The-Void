/**
 * Summit was an internal Fuji certification/demo fixture.
 * It is not a public release, catalog entry, or collectible.
 *
 * Production default: OFF.
 * Enable only for local certification work: VITE_SUMMIT_DEMO=true
 */

export const SUMMIT_DEMO_IDS = Object.freeze({
  artist: "summit-demo-artist",
  release: "summit-demo-release",
  edition: "summit-demo-edition",
  experience: "summit-session",
  collection: "summit-collection",
});

const SUMMIT_ID_VALUES = new Set(Object.values(SUMMIT_DEMO_IDS));
const SUMMIT_PUBLIC_LABEL = /\bsummit[- ]?(demo|edition|session|collection|token)\b|\bthe void\s*[—-]\s*summit\b|summit demo on avalanche/i;
const THE_VOID_SLUG = /^the-void(-\d+)?$/i;
const VOIDCALLER_ALIAS_SLUG = /^(voidcaller)(-\d+)?$|^voidcaller-certification-artist$/i;
const VOIDCALLER_ALIAS_NAME = /^voidcaller( certification artist)?$/i;

// These records were returned as PUBLISHED by the production API on
// 2026-09-29. Keep accounts and historical commerce intact; never project
// these internal records into public catalog views, even if still published.
const NONPUBLIC_TEST_IDS = new Set([
  "artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3",
  "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e",
  "artist-fa19e2f0-bc20-4b7c-8698-c5f1db59fd6a",
  "artist-454ea216-9ce5-4c9d-b904-08eb7bb18bf3",
  "artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138",
  "artist-f6be711f-c5f1-43de-bba3-a085950ae1d1",
  "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7",
  "release-7f12ecfb-99eb-4b05-9b07-f862480829c5",
  "release-f049bc8c-2ff1-4ebf-8830-ebd92784864a",
  "release-f2ce5be7-969a-4e9f-87fb-be839b9df380",
  "release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3",
  "release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de",
  "edition-b87f40b1-9419-4e90-8e2f-5b8986df043c",
  "edition-8ed9867c-e102-49c5-97a0-54ccf15605d2",
  "edition-ce4230f8-59fd-4cc4-a193-c62a4653f4c3",
  "edition-3de74dd9-8f60-4369-afba-e2d76a1bef9c",
  "edition-fe58c325-131d-4eb6-8af4-544720d5c403",
  "edition-56dbb8af-7da2-46e3-9d59-db255362cd3e",
]);
const TEST_PROFILE_LABELS = new Set(["wer", "sdfg", "qwe", "asdf"]);
const PUBLIC_TEST_MARKER = /\b(?:test(?:ing)?|demo|e2e|certification)\b|fuji[\s_-]*e2e|pinata[\s_-]*(?:json[\s_-]*)?certif/i;

export function isSummitDemoEnabled() {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const value = env?.VITE_SUMMIT_DEMO;
  return value === "true" || value === "1";
}

function recordName(item) {
  return String(item?.name || item?.display_name || "").trim();
}

function recordSlug(item) {
  return String(item?.slug || item?.handle || "").trim().toLowerCase();
}

export function isSummitDemoRecord(item) {
  if (!item) return false;
  const id = String(item.id || "");
  const slug = recordSlug(item);
  const name = recordName(item);
  if (SUMMIT_ID_VALUES.has(id)) return true;
  if (id.startsWith("summit-token-") || id.startsWith("summit-demo-")) return true;
  if (THE_VOID_SLUG.test(slug) || name.toUpperCase() === "THE VOID") return true;
  const blob = [id, item.title, item.name, item.display_name, item.subtitle, item.slug, item.handle, item.bio, item.description]
    .filter(Boolean)
    .join(" ");
  return SUMMIT_PUBLIC_LABEL.test(blob);
}

export function isNonPublicTestRecord(item) {
  if (!item) return false;
  const id = String(item.id || "");
  if (NONPUBLIC_TEST_IDS.has(id)) return true;
  const name = recordName(item).toLowerCase();
  const slug = recordSlug(item);
  if (TEST_PROFILE_LABELS.has(name) || TEST_PROFILE_LABELS.has(slug)) return true;
  const metadata = [item.release_metadata, item.application_metadata, item.metadata]
    .filter((value) => value && typeof value === "object")
    .map((value) => JSON.stringify(value))
    .join(" ");
  const blob = [id, item.title, item.name, item.display_name, item.subtitle, item.slug, item.handle, item.bio, item.description, metadata]
    .filter(Boolean)
    .join(" ");
  return PUBLIC_TEST_MARKER.test(blob);
}

export function isVoidcallerPublicAlias(item) {
  if (!item) return false;
  const id = String(item.id || "");
  if (id === "voidcaller") return false;
  return VOIDCALLER_ALIAS_SLUG.test(recordSlug(item)) || VOIDCALLER_ALIAS_NAME.test(recordName(item));
}

export function isHiddenPublicArtist(item) {
  return isSummitDemoRecord(item) || isNonPublicTestRecord(item) || isVoidcallerPublicAlias(item);
}

function isInternal(item) {
  return isSummitDemoRecord(item) || isNonPublicTestRecord(item);
}

function normalizedReleaseTitle(release) {
  return String(release?.title || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function releaseTimestamp(release, field) {
  const value = Date.parse(release?.[field] || "");
  return Number.isFinite(value) ? value : 0;
}

function releaseWinner(left, right) {
  const published = releaseTimestamp(left, "publishedAt") - releaseTimestamp(right, "publishedAt");
  if (published) return published > 0 ? left : right;
  const updated = releaseTimestamp(left, "updatedAt") - releaseTimestamp(right, "updatedAt");
  if (updated) return updated > 0 ? left : right;
  return String(left?.id || "").localeCompare(String(right?.id || "")) <= 0 ? left : right;
}

export function deduplicatePublicReleases(catalog) {
  const releases = catalog?.releases || [];
  const winners = new Map();
  for (const release of releases) {
    const key = `${String(release?.artistId || "").toLowerCase()}::${normalizedReleaseTitle(release)}`;
    const current = winners.get(key);
    winners.set(key, current ? releaseWinner(current, release) : release);
  }
  const keptReleaseIds = new Set(winners.values().map((release) => release.id));
  const sourceReleaseIds = new Set(releases.map((release) => release.id));
  const editions = (catalog.editions || []).filter((edition) => !sourceReleaseIds.has(edition.releaseId) || keptReleaseIds.has(edition.releaseId));
  const keptEditionIds = new Set(editions.map((edition) => edition.id));
  const sourceEditionIds = new Set((catalog.editions || []).map((edition) => edition.id));
  return {
    ...catalog,
    releases: releases.filter((release) => keptReleaseIds.has(release.id)),
    editions,
    tokens: (catalog.tokens || []).filter((token) => keptEditionIds.has(token.editionId)),
    experiences: (catalog.experiences || []).filter((experience) => !sourceEditionIds.has(experience.editionId) || keptEditionIds.has(experience.editionId)),
    collections: (catalog.collections || []).filter((collection) => (
      !(collection.releaseIds || []).some((id) => !keptReleaseIds.has(id))
      && !(collection.editionIds || []).some((id) => !keptEditionIds.has(id))
    )),
  };
}

/**
 * Remove internal/demo/test rows and their dependent public catalog objects.
 * This is a read projection only: it never deletes or mutates source records.
 */
export function stripSummitDemoCatalog(catalog) {
  if (!catalog) return catalog;
  const artists = catalog.artists || [];
  const releases = catalog.releases || [];
  const editions = catalog.editions || [];
  const experiences = catalog.experiences || [];
  const tokens = catalog.tokens || [];
  const collections = catalog.collections || [];

  const hiddenArtistIds = new Set(artists.filter(isInternal).map((item) => item.id));
  const hiddenReleaseIds = new Set(
    releases
      .filter((item) => isInternal(item) || hiddenArtistIds.has(item.artistId || item.artist_id))
      .map((item) => item.id),
  );
  for (const release of releases) {
    if (hiddenReleaseIds.has(release.id)) {
      const artistId = release.artistId || release.artist_id;
      if (artistId) hiddenArtistIds.add(artistId);
    }
  }
  const hiddenEditionIds = new Set(
    editions
      .filter((item) => isInternal(item) || hiddenReleaseIds.has(item.releaseId || item.release_id))
      .map((item) => item.id),
  );

  return {
    ...catalog,
    artists: artists.filter((item) => !hiddenArtistIds.has(item.id) && !isInternal(item)),
    releases: releases.filter((item) => !hiddenReleaseIds.has(item.id) && !isInternal(item)),
    editions: editions.filter((item) => !hiddenEditionIds.has(item.id) && !isInternal(item)),
    tokens: tokens.filter((item) => !hiddenEditionIds.has(item.editionId || item.edition_id) && !isInternal(item)),
    experiences: experiences.filter((item) => (
      !isInternal(item)
      && !hiddenReleaseIds.has(item.releaseId || item.release_id)
      && !hiddenEditionIds.has(item.editionId || item.edition_id)
    )),
    collections: collections.filter((item) => (
      !isInternal(item)
      && !(item.artistIds || item.artist_ids || []).some((id) => hiddenArtistIds.has(id))
      && !(item.releaseIds || item.release_ids || []).some((id) => hiddenReleaseIds.has(id))
      && !(item.editionIds || item.edition_ids || []).some((id) => hiddenEditionIds.has(id))
    )),
  };
}

export function collapsePublicCatalog(catalog) {
  if (!catalog) return catalog;
  const stripped = stripSummitDemoCatalog(catalog);
  if (isSummitDemoEnabled()) return deduplicatePublicReleases(stripped);
  const hiddenAliasIds = new Set((stripped.artists || []).filter(isVoidcallerPublicAlias).map((artist) => artist.id));
  const artists = [];
  let canonical = null;
  for (const artist of stripped.artists || []) {
    if (artist?.id === "voidcaller") {
      canonical = artist;
      continue;
    }
    if (isHiddenPublicArtist(artist)) continue;
    artists.push(artist);
  }
  if (canonical) artists.unshift(canonical);
  const releases = (stripped.releases || []).map((release) => {
    const alias = hiddenAliasIds.has(release.artistId)
      || isVoidcallerPublicAlias({ id: release.artistId, name: release.artistName, slug: release.artistSlug });
    return canonical && alias ? { ...release, artistId: canonical.id } : release;
  });
  return deduplicatePublicReleases({ ...stripped, artists, releases });
}
