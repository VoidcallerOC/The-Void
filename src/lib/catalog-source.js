import { useEffect, useMemo, useState } from "react";
import { portfolioImageSrc, profileSocials } from "./artist-profile.js";
import {
  createArtist,
  createCatalog,
  createEdition,
  createExperience,
  createRelease,
  createToken,
  EXPERIENCE_TYPES,
} from "../domain/models.js";
import { VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { ipfsToHttp } from "./web3.js";
import { collapsePublicCatalog } from "./summit-demo.js";
import { isLegacyMainnetEdition } from "./legacy-genesis.js";

export const STUDIO_OVERLAY_KEY = "the-void.studio-overlay.v1";

function emptyCatalog() {
  return createCatalog({ artists: [], releases: [], editions: [], tokens: [], collections: [], experiences: [] });
}

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function baseCatalogs() {
  return [VOIDCALLER_CATALOG];
}

export function readStudioOverlay(store = storage()) {
  if (!store?.getItem) return emptyCatalog();
  try {
    const parsed = JSON.parse(store.getItem(STUDIO_OVERLAY_KEY));
    if (!parsed || typeof parsed !== "object") return emptyCatalog();
    return createCatalog({
      artists: Array.isArray(parsed.artists) ? parsed.artists : [],
      releases: Array.isArray(parsed.releases) ? parsed.releases : [],
      editions: Array.isArray(parsed.editions) ? parsed.editions : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
    });
  } catch {
    return emptyCatalog();
  }
}

export function writeStudioOverlay(catalog, store = storage()) {
  const next = createCatalog(catalog || {});
  store?.setItem?.(STUDIO_OVERLAY_KEY, JSON.stringify(next));
  return next;
}

export function upsertStudioOverlay(partial, store = storage()) {
  const current = readStudioOverlay(store);
  const next = mergeCatalogs([current, createCatalog(partial)]);
  return writeStudioOverlay(next, store);
}

export function mergeCatalogs(list = []) {
  const buckets = { artists: [], releases: [], editions: [], tokens: [], collections: [], experiences: [] };
  const seen = Object.fromEntries(Object.keys(buckets).map((key) => [key, new Set()]));
  for (const catalog of list) {
    if (!catalog) continue;
    for (const key of Object.keys(buckets)) {
      for (const item of catalog[key] || []) {
        if (!item?.id || seen[key].has(item.id)) continue;
        seen[key].add(item.id);
        buckets[key].push(item);
      }
    }
  }
  return createCatalog(buckets);
}

export function resolveCatalog(id, catalogs = baseCatalogs()) {
  return catalogs.find((catalog) => ["artists", "releases", "editions", "experiences", "tokens", "collections"].some((key) => (catalog[key] || []).some((item) => item.id === id))) || catalogs[0] || VOIDCALLER_CATALOG;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function metadataOf(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

// Only the profile fields the database actually holds, so a saved profile can
// replace a built-in artist's details without its placeholder defaults.
function savedProfileOf(row, meta) {
  const saved = {};
  if (row.display_name) saved.name = row.display_name;
  if (typeof row.bio === "string") saved.bio = row.bio;
  // Profile pictures are site files (or older ipfs:// URIs). Either way the
  // browser needs an http(s) URL, never a raw ipfs:// string.
  if (meta.profileArtwork) saved.avatar = portfolioImageSrc(meta.profileArtwork);
  if (meta.banner) saved.banner = portfolioImageSrc(meta.banner);
  if (row.social_links != null || row.website_url != null) saved.socials = profileSocials(row.social_links, row.website_url);
  if (row.verified === true || row.verification_status === "VERIFIED") saved.verified = true;
  return saved;
}

// Built-in catalogs win id collisions in mergeCatalogs, which would hide an
// artist's saved profile (e.g. "voidcaller") forever. Lay the published
// profile over any built-in artist with the same id first.
export function withPublishedArtistProfiles(catalog, published) {
  if (!catalog) return catalog;
  const profiles = new Map(asArray(published?.artists).filter((artist) => artist?.savedProfile).map((artist) => [artist.id, artist.savedProfile]));
  if (!profiles.size) return catalog;
  return createCatalog({
    ...catalog,
    artists: asArray(catalog.artists).map((artist) => (profiles.has(artist?.id) ? { ...artist, ...profiles.get(artist.id) } : artist)),
  });
}

export function mapPublishedCatalog({ artists = [], releases = [], editions = [], experiences = [] } = {}) {
  const mappedArtists = asArray(artists).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "profile_metadata", "application_metadata", "metadata");
    return createArtist({
      id: row.id,
      name: row.display_name || row.name || row.slug || row.id,
      handle: row.slug || row.handle || row.id,
      bio: row.bio || "",
      avatar: portfolioImageSrc(meta.profileArtwork || meta.artwork) || "/assets/voidcaller_art_4.png",
      banner: portfolioImageSrc(meta.banner || meta.profileArtwork) || "/assets/voidcaller_art_6.png",
      socials: profileSocials(row.social_links, row.website_url),
      verified: row.verified === true || row.verification_status === "VERIFIED",
      savedProfile: savedProfileOf(row, meta),
    });
  });
  const mappedReleases = asArray(releases).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "release_metadata", "metadata");
    return createRelease({
      id: row.id,
      artistId: row.artist_id || row.artistId,
      artistName: row.artist_name || row.artistName || "",
      artistSlug: row.artist_slug || row.artistSlug || "",
      title: row.title || row.id,
      subtitle: meta.subtitle || "",
      description: row.description || "",
      story: meta.story || row.description || "",
      status: String(row.status || "published").toLowerCase(),
      publishedAt: row.published_at || row.publishedAt || null,
      updatedAt: row.updated_at || row.updatedAt || null,
      artwork: ipfsToHttp(meta.artwork) || "/assets/voidcaller_art_4.png",
      experiences: asArray(meta.experiences),
      tracks: asArray(meta.tracks),
    });
  });
  const mappedEditions = asArray(editions).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "application_metadata", "metadata");
    const fuji = meta.fuji || {};
    const contractAddress = row.contract_address || fuji.contractAddress || "";
    const chainId = Number(row.chain_id || fuji.chainId || 0);
    const tokenId = fuji.tokenId || meta.tokenId || row.token_id;
    // Legacy mainnet editions (the original Voidcaller collection) are minted
    // out: never "available" for primary collect, and they list every token.
    const legacy = isLegacyMainnetEdition({ chainId, contractAddress });
    const legacyTokenIds = legacy ? asArray(meta.tokenIds).map(String) : [];
    return createEdition({
      id: row.id,
      releaseId: row.release_id || row.releaseId,
      title: row.title || row.name || row.id,
      description: row.description || "",
      includes: asArray(meta.includes),
      tokenIds: legacyTokenIds.length ? legacyTokenIds : tokenId !== undefined && tokenId !== null && tokenId !== "" ? [String(tokenId)] : [],
      contractAddress,
      chainId,
      chain: chainId === FUJI_RELEASE_CONFIG.chainId ? FUJI_RELEASE_CONFIG.networkName : "AVALANCHE",
      supply: row.supply != null ? String(row.supply) : null,
      status: legacy ? "minted" : String(row.status || "available").toLowerCase() === "published" ? "available" : String(row.status || "available").toLowerCase(),
      ...(legacy ? { legacy: true, marketplaces: asArray(meta.marketplaces) } : {}),
      metadataUri: fuji.metadataUri || meta.metadataUri || "",
      previewAudio: typeof meta.previewAudio === "string" ? meta.previewAudio : "",
      experienceIds: asArray(meta.experienceIds),
      tier: row.tier || "standard",
      artwork: ipfsToHttp(meta.artwork) || ipfsToHttp(row.token_metadata?.image || ""),
      tokenMetadata: row.token_metadata && typeof row.token_metadata === "object" ? row.token_metadata : null,
      priceWei: meta.priceWei ?? meta.primaryPriceWei ?? meta.marketplace?.priceWei ?? null,
      ...(row.buyable_sale === true || row.buyableSale === true ? { buyableSale: true } : {}),
    });
  });
  const mappedExperiences = asArray(experiences).filter((row) => row?.id).map((row) => {
    const type = String(row.experience_type || row.experienceType || row.type || "AUDIO").toUpperCase();
    const gated = row.gated === true || asArray(row.requirements).length > 0;
    const declared = metadataOf(row, "media");
    const leaked = metadataOf(row, "media_config");
    const protectedMedia = row.protected === true || declared.protected === true || leaked.protected === true || (Array.isArray(leaked.protectedMedia) && leaked.protectedMedia.length > 0);
    return createExperience({
      id: row.id,
      experienceType: EXPERIENCE_TYPES[type] || EXPERIENCE_TYPES.AUDIO,
      title: row.title || row.id,
      description: row.description || "",
      requirements: gated ? [{ type: "erc1155-balance" }] : [],
      media: protectedMedia ? { protected: true, type } : {},
      editionId: row.edition_id || row.editionId || null,
    });
  });
  const mappedTokens = mappedEditions.flatMap((edition) => (edition.tokenIds || []).map((tokenId) => createToken({
    id: `${edition.id}-token-${tokenId}`,
    editionId: edition.id,
    tokenId,
    name: edition.tokenMetadata?.name || edition.title,
    // Published token metadata (public by definition: it is the tokenURI
    // document). animation_url there is only ever the vetted public preview.
    metadata: edition.tokenMetadata ? { name: edition.tokenMetadata.name || "", description: edition.tokenMetadata.description || "", image: edition.tokenMetadata.image || "", animationUrl: edition.tokenMetadata.animation_url || "" } : null,
  })));
  return createCatalog({
    artists: mappedArtists,
    releases: mappedReleases,
    editions: mappedEditions,
    tokens: mappedTokens,
    experiences: mappedExperiences,
  });
}

// src/data.js already renders the original Voidcaller collection
// (voidcaller-self-titled / voidcaller-chapter-i). When the API also returns
// the seeded legacy release and edition for the same mainnet contract, keep
// the static entry and drop the published duplicate from the storefront.
// Published experiences stay, so /experience/voidcaller-legacy-track-N resolves.
export function withoutShadowedLegacyAlbum(published, base = baseCatalogs()) {
  if (!published) return published;
  const staticLegacy = asArray(base).some((catalog) => asArray(catalog?.editions).some((edition) => isLegacyMainnetEdition(edition)));
  if (!staticLegacy) return published;
  const editions = asArray(published.editions);
  const legacyEditionIds = new Set(editions.filter((edition) => isLegacyMainnetEdition(edition)).map((edition) => edition.id));
  if (!legacyEditionIds.size) return published;
  const shadowedReleaseIds = new Set(
    editions
      .filter((edition) => legacyEditionIds.has(edition.id))
      .map((edition) => edition.releaseId)
      .filter((releaseId) => editions.every((edition) => edition.releaseId !== releaseId || legacyEditionIds.has(edition.id))),
  );
  return createCatalog({
    ...published,
    releases: asArray(published.releases).filter((release) => !shadowedReleaseIds.has(release.id)),
    editions: editions.filter((edition) => !legacyEditionIds.has(edition.id)),
    tokens: asArray(published.tokens).filter((token) => !legacyEditionIds.has(token.editionId)),
  });
}

// Each deployment runs one release network (Fuji or C-Chain). Published
// editions minted on the other network are hidden, with the experiences and
// releases that only they carry. The legacy C-Chain collection always stays.
export function onActiveReleaseNetwork(published, activeChainId = FUJI_RELEASE_CONFIG.chainId) {
  if (!published) return published;
  const editions = asArray(published.editions);
  const offNetwork = new Set(editions
    .filter((edition) => Number(edition.chainId) && Number(edition.chainId) !== Number(activeChainId) && !isLegacyMainnetEdition(edition))
    .map((edition) => edition.id));
  if (!offNetwork.size) return published;
  const hiddenReleaseIds = new Set(
    editions
      .filter((edition) => offNetwork.has(edition.id))
      .map((edition) => edition.releaseId)
      .filter((releaseId) => editions.every((edition) => edition.releaseId !== releaseId || offNetwork.has(edition.id))),
  );
  return createCatalog({
    ...published,
    releases: asArray(published.releases).filter((release) => !hiddenReleaseIds.has(release.id)),
    editions: editions.filter((edition) => !offNetwork.has(edition.id)),
    tokens: asArray(published.tokens).filter((token) => !offNetwork.has(token.editionId)),
    experiences: asArray(published.experiences).filter((experience) => !offNetwork.has(experience.editionId)),
  });
}

function apiBase() {
  const configured = typeof import.meta !== "undefined" ? import.meta.env?.VITE_API_ORIGIN : "";
  return configured ? String(configured).replace(/\/$/, "") : "";
}

async function fetchJson(path, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`${apiBase()}${path}`, { method: "GET", headers: { accept: "application/json" }, signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || "Catalog request failed.");
  return payload.data;
}

export async function fetchPublishedCatalog({ fetchImpl = fetch, signal } = {}) {
  const [artists, releases, editions, experiences] = await Promise.all([
    fetchJson("/api/artists", { fetchImpl, signal }).catch(() => []),
    fetchJson("/api/releases", { fetchImpl, signal }).catch(() => []),
    fetchJson("/api/editions", { fetchImpl, signal }).catch(() => []),
    fetchJson("/api/experiences", { fetchImpl, signal }).catch(() => []),
  ]);
  return collapsePublicCatalog(onActiveReleaseNetwork(mapPublishedCatalog({
    artists: asArray(artists),
    releases: asArray(releases),
    editions: asArray(editions),
    experiences: asArray(experiences),
  })));
}

export function useMarketplaceCatalogs() {
  const [overlay, setOverlay] = useState(() => readStudioOverlay());
  const [published, setPublished] = useState(emptyCatalog());
  const [publishedLoading, setPublishedLoading] = useState(true);

  useEffect(() => {
    const sync = () => setOverlay(readStudioOverlay());
    window.addEventListener("the-void:studio-overlay", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("the-void:studio-overlay", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchPublishedCatalog({ signal: controller.signal })
      .then((catalog) => setPublished(catalog))
      .catch(() => {})
      .finally(() => setPublishedLoading(false));
    return () => controller.abort();
  }, []);

  return useMemo(() => ({
    ...collapsePublicCatalog(mergeCatalogs([...baseCatalogs().map((base) => withPublishedArtistProfiles(base, published)), withPublishedArtistProfiles(overlay, published), withoutShadowedLegacyAlbum(onActiveReleaseNetwork(published))])),
    publishedLoading,
  }), [overlay, published, publishedLoading]);
}

export function notifyStudioOverlay() {
  try { window.dispatchEvent(new Event("the-void:studio-overlay")); } catch { /* ignore */ }
}
