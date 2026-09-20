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

export function isVoidcallerPublicAlias(item) {
  if (!item) return false;
  const id = String(item.id || "");
  if (id === "voidcaller") return false;
  return VOIDCALLER_ALIAS_SLUG.test(recordSlug(item)) || VOIDCALLER_ALIAS_NAME.test(recordName(item));
}

export function isHiddenPublicArtist(item) {
  return isSummitDemoRecord(item) || isVoidcallerPublicAlias(item);
}

export function stripSummitDemoCatalog(catalog) {
  if (!catalog || isSummitDemoEnabled()) return catalog;
  const next = {};
  for (const key of ["artists", "releases", "editions", "tokens", "collections", "experiences"]) {
    next[key] = (catalog[key] || []).filter((item) => !isSummitDemoRecord(item));
  }
  return { ...catalog, ...next };
}

export function collapsePublicCatalog(catalog) {
  if (!catalog) return catalog;
  const stripped = stripSummitDemoCatalog(catalog);
  if (isSummitDemoEnabled()) return stripped;
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
  return { ...stripped, artists };
}
