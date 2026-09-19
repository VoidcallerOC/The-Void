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
const SUMMIT_PUBLIC_LABEL = /\bsummit[- ]?(demo|edition|session|collection|token)\b|\bthe void\s*[—-]\s*summit\b/i;

export function isSummitDemoEnabled() {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const value = env?.VITE_SUMMIT_DEMO;
  return value === "true" || value === "1";
}

export function isSummitDemoRecord(item) {
  if (!item) return false;
  const id = String(item.id || "");
  if (SUMMIT_ID_VALUES.has(id)) return true;
  if (id.startsWith("summit-token-")) return true;
  const blob = [id, item.title, item.name, item.subtitle, item.slug, item.handle]
    .filter(Boolean)
    .join(" ");
  return SUMMIT_PUBLIC_LABEL.test(blob);
}

export function stripSummitDemoCatalog(catalog) {
  if (!catalog || isSummitDemoEnabled()) return catalog;
  const next = {};
  for (const key of ["artists", "releases", "editions", "tokens", "collections", "experiences"]) {
    next[key] = (catalog[key] || []).filter((item) => !isSummitDemoRecord(item));
  }
  return { ...catalog, ...next };
}
