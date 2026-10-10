import { FUJI_E2E_MINT, FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { isVoidcallerPublicAlias } from "./summit-demo.js";

// Fuji contract admin/deployer (roles, E2E). Studio must not treat this wallet
// as the Voidcaller artist identity — that belongs to the platform artist wallet.
export const STUDIO_ADMIN_DEPLOYER_WALLET = String(FUJI_E2E_MINT.wallet).toLowerCase();
export const STUDIO_PLATFORM_ARTIST_WALLET = String(FUJI_RELEASE_CONFIG.platformFeeRecipient).toLowerCase();

export function isStudioAdminDeployerWallet(wallet) {
  return String(wallet || "").trim().toLowerCase() === STUDIO_ADMIN_DEPLOYER_WALLET;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artistIdOf(item) {
  return String(item?.artistId ?? item?.artist_id ?? "").trim();
}

// Voidcaller (canonical or numbered aliases such as voidcaller-5) is the
// platform artist's catalog, not the contract admin/deployer's.
export function isVoidcallerArtistProfile(artist) {
  if (!artist) return false;
  if (String(artist.id || "").trim() === "voidcaller") return true;
  return isVoidcallerPublicAlias(artist);
}

/**
 * Studio lists releases only for artists the connected wallet owns
 * (GET /studio/catalog → artist_owners). When that wallet is the Fuji
 * admin/deployer, Voidcaller artist profiles are still omitted so Forgive &
 * Forget and other Voidcaller drafts/releases surface only for the platform
 * artist wallet that owns them.
 */
export function studioCatalogForConnectedWallet(catalog = {}, wallet = "") {
  if (!isStudioAdminDeployerWallet(wallet)) return catalog;
  const artists = asArray(catalog.artists).filter((artist) => !isVoidcallerArtistProfile(artist));
  const keepArtistIds = new Set(artists.map((artist) => String(artist.id || "").trim()).filter(Boolean));
  const releases = asArray(catalog.releases).filter((release) => keepArtistIds.has(artistIdOf(release)));
  const keepReleaseIds = new Set(releases.map((release) => String(release.id || "").trim()).filter(Boolean));
  const editions = asArray(catalog.editions).filter((edition) => {
    const releaseId = String(edition.releaseId ?? edition.release_id ?? "").trim();
    if (releaseId && keepReleaseIds.has(releaseId)) return true;
    const artistId = artistIdOf(edition);
    return artistId ? keepArtistIds.has(artistId) : false;
  });
  const keepEditionIds = new Set(editions.map((edition) => String(edition.id || "").trim()).filter(Boolean));
  const experiences = asArray(catalog.experiences).filter((experience) => {
    const artistId = artistIdOf(experience);
    if (artistId && keepArtistIds.has(artistId)) return true;
    const releaseId = String(experience.releaseId ?? experience.release_id ?? "").trim();
    if (releaseId && keepReleaseIds.has(releaseId)) return true;
    const editionId = String(experience.editionId ?? experience.edition_id ?? "").trim();
    return editionId ? keepEditionIds.has(editionId) : false;
  });
  const tokens = asArray(catalog.tokens).filter((token) => keepEditionIds.has(String(token.editionId || token.edition_id || "").trim()));
  const albumSingles = catalog.albumSingles === undefined ? {} : { albumSingles: asArray(catalog.albumSingles).filter((link) => keepReleaseIds.has(String(link.album_release_id ?? link.albumReleaseId ?? "").trim())) };
  return { ...catalog, artists, releases, editions, experiences, tokens, ...albumSingles };
}
