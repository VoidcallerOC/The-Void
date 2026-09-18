import { useEffect, useMemo, useState } from "react";
import {
  createArtist,
  createCatalog,
  createEdition,
  createExperience,
  createRelease,
  createToken,
  EXPERIENCE_TYPES,
} from "../domain/models.js";
import { VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG } from "../data.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";

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
  return [VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG];
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

export function mapPublishedCatalog({ artists = [], releases = [], editions = [], experiences = [] } = {}) {
  const mappedArtists = asArray(artists).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "profile_metadata", "application_metadata", "metadata");
    return createArtist({
      id: row.id,
      name: row.display_name || row.name || row.slug || row.id,
      handle: row.slug || row.handle || row.id,
      bio: row.bio || "",
      avatar: meta.profileArtwork || meta.artwork || "/assets/voidcaller_art_4.png",
      banner: meta.banner || meta.profileArtwork || "/assets/voidcaller_art_6.png",
      verified: true,
    });
  });
  const mappedReleases = asArray(releases).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "release_metadata", "metadata");
    return createRelease({
      id: row.id,
      artistId: row.artist_id || row.artistId,
      title: row.title || row.id,
      subtitle: meta.subtitle || "",
      description: row.description || "",
      story: meta.story || row.description || "",
      status: String(row.status || "published").toLowerCase(),
      artwork: meta.artwork || "/assets/voidcaller_art_4.png",
      experiences: asArray(meta.experiences),
      tracks: asArray(meta.tracks),
    });
  });
  const mappedEditions = asArray(editions).filter((row) => row?.id).map((row) => {
    const meta = metadataOf(row, "application_metadata", "metadata");
    const fuji = meta.fuji || {};
    const contractAddress = row.contract_address || fuji.contractAddress || FUJI_RELEASE_CONFIG.contractAddress;
    const chainId = Number(row.chain_id || fuji.chainId || FUJI_RELEASE_CONFIG.chainId);
    const tokenId = fuji.tokenId || meta.tokenId || row.token_id;
    return createEdition({
      id: row.id,
      releaseId: row.release_id || row.releaseId,
      title: row.title || row.name || row.id,
      description: row.description || "",
      includes: asArray(meta.includes),
      tokenIds: tokenId !== undefined && tokenId !== null && tokenId !== "" ? [String(tokenId)] : [],
      contractAddress,
      chainId,
      chain: chainId === FUJI_RELEASE_CONFIG.chainId ? FUJI_RELEASE_CONFIG.networkName : "AVALANCHE",
      supply: row.supply != null ? String(row.supply) : null,
      status: String(row.status || "available").toLowerCase() === "published" ? "available" : String(row.status || "available").toLowerCase(),
      metadataUri: fuji.metadataUri || meta.metadataUri || "",
      experienceIds: asArray(meta.experienceIds),
      tier: row.tier || "standard",
      artwork: meta.artwork || "",
    });
  });
  const mappedExperiences = asArray(experiences).filter((row) => row?.id).map((row) => {
    const type = String(row.experience_type || row.experienceType || row.type || "AUDIO").toUpperCase();
    return createExperience({
      id: row.id,
      experienceType: EXPERIENCE_TYPES[type] || EXPERIENCE_TYPES.AUDIO,
      title: row.title || row.id,
      description: row.description || "",
      requirements: asArray(row.requirements),
      media: metadataOf(row, "media_config", "media"),
      editionId: row.edition_id || row.editionId || null,
    });
  });
  const mappedTokens = mappedEditions.flatMap((edition) => (edition.tokenIds || []).map((tokenId) => createToken({
    id: `${edition.id}-token-${tokenId}`,
    editionId: edition.id,
    tokenId,
    name: edition.title,
  })));
  return createCatalog({
    artists: mappedArtists,
    releases: mappedReleases,
    editions: mappedEditions,
    tokens: mappedTokens,
    experiences: mappedExperiences,
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
  return mapPublishedCatalog({
    artists: asArray(artists),
    releases: asArray(releases),
    editions: asArray(editions),
    experiences: asArray(experiences),
  });
}

export function useMarketplaceCatalogs() {
  const [overlay, setOverlay] = useState(() => readStudioOverlay());
  const [published, setPublished] = useState(emptyCatalog());

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
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return useMemo(
    () => mergeCatalogs([VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG, overlay, published]),
    [overlay, published],
  );
}

export function notifyStudioOverlay() {
  try { window.dispatchEvent(new Event("the-void:studio-overlay")); } catch { /* ignore */ }
}
