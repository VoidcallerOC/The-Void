// One document title per route. Every page used to share the static <title> from index.html, so the
// browser tab, the history list and bookmarks read the same on every page and a collector clicking
// through the single-artist catalog had no page-level signal that the route had changed.
export const SITE_TITLE = "The Void — Music-native platform · Featured: Voidcaller";
const SITE = "The Void";
export const NOT_FOUND_TITLE = `Not found · ${SITE}`;

const STATIC_TITLES = Object.freeze({
  "/discover": "Discover",
  "/marketplace": "Marketplace",
  "/claim": "Genesis claim",
  "/bridge": "Bridge",
  "/artists": "Artists",
  "/verify": "Become verified",
  "/verify/apply": "Artist verification",
  "/verify/received": "Application received",
  "/verify/dashboard": "Verification dashboard",
  "/verify/review": "Review applications",
  "/collection": "Catalog",
  "/my-collection": "My collection",
  "/collectors": "Collectors",
  "/studio": "Artist studio",
  "/admin/roles": "Publishing roles",
  "/chronicle": "The chronicle",
  "/the-call": "The call",
  "/the-bleed": "The bleed",
  "/choir": "The choir",
  "/reliquary": "Reliquary",
});
// Routes that exist only behind a build flag (see App.jsx); off, they are not-found pages.
const FLAGGED_TITLES = Object.freeze({
  "/covenant": ["voidLive", "Covenant"],
  "/fuji-integration": ["summitDemo", "Fuji integration"],
});

export function normalizePathname(pathname) {
  const trimmed = String(pathname || "/").replace(/\/+$/, "");
  return trimmed || "/";
}

const find = (list, id) => (list || []).find((item) => item?.id === id) || null;

/** The page-specific part of the title (no site suffix), or null when the route is unknown. */
export function pageLabel(pathname, catalog = {}, flags = {}) {
  const path = normalizePathname(pathname);
  if (path === "/") return null;
  if (STATIC_TITLES[path]) return STATIC_TITLES[path];
  if (FLAGGED_TITLES[path]) { const [flag, label] = FLAGGED_TITLES[path]; return flags[flag] ? label : null; }
  const [, kind, ...rest] = path.split("/");
  const id = rest.map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join("/");
  if (!id) return null;
  switch (kind) {
    case "artist": { const artist = find(catalog.artists, id); return artist ? `${artist.name} · Artist` : "Artist"; }
    case "release": { const release = find(catalog.releases, id); return release ? `${release.title} · Release` : "Release"; }
    case "edition": {
      const edition = find(catalog.editions, id);
      if (!edition) return "Edition";
      const release = find(catalog.releases, edition.releaseId);
      const releaseTitle = release?.title && release.title !== edition.title ? ` · ${release.title}` : "";
      return `${edition.title}${releaseTitle} · Edition`;
    }
    case "experience": { const experience = find(catalog.experiences, id); return experience ? `${experience.title} · Experience` : "Experience"; }
    case "collection": { const collection = find(catalog.collections, id); return collection ? `${collection.name} · Collection` : "Collection"; }
    case "claim": { const edition = find(catalog.editions, id); return edition ? `Genesis claim · ${edition.title}` : "Genesis claim"; }
    case "studio": return rest[0] === "profile" ? "Edit artist profile" : null;
    case "verify": return rest[0] === "review" ? "Review application" : null;
    default: return null;
  }
}

/** The full document title for a route. Unknown routes are titled as not found. */
export function pageTitle(pathname, catalog = {}, flags = {}) {
  if (normalizePathname(pathname) === "/") return SITE_TITLE;
  const label = pageLabel(pathname, catalog, flags);
  return label ? `${label} · ${SITE}` : NOT_FOUND_TITLE;
}

// A page that knows it is a not-found state overrides the route-derived title for as long as it is
// mounted. Module-level so the shell's title effect and the page need no shared provider.
let titleOverride = null;
const titleListeners = new Set();
export function setPageTitleOverride(title) {
  titleOverride = title || null;
  for (const listener of titleListeners) listener();
}
export function getPageTitleOverride() {
  return titleOverride;
}
export function subscribePageTitleOverride(listener) {
  titleListeners.add(listener);
  return () => titleListeners.delete(listener);
}
