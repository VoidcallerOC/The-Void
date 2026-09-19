// Music-native platform domain models. These are application records rather
// than blockchain records; contract data is infrastructure attached to editions.
// Product language is what the collector sees. EXPERIENCE_TYPES remains the
// delivery-compatible vocabulary used by the existing media/auth services.
export const EXPERIENCE_TYPES = Object.freeze({
  AUDIO: "AUDIO", VIDEO: "VIDEO", STEMS: "STEMS", DOWNLOAD: "DOWNLOAD", ARTWORK: "ARTWORK", LYRICS: "LYRICS", DEMO: "DEMO", LIVE_RECORDING: "LIVE_RECORDING", TICKET: "TICKET", VIP_ACCESS: "VIP_ACCESS", DISCOUNT: "DISCOUNT", PHYSICAL_REDEMPTION: "PHYSICAL_REDEMPTION",
});

export const EXPERIENCE_CATEGORIES = Object.freeze({
  FULL_RECORD: { label: "Full record", deliveryType: "AUDIO", supported: true },
  UNRELEASED_TRACK: { label: "Unreleased track", deliveryType: "AUDIO", supported: true },
  DEMO: { label: "Demo", deliveryType: "DEMO", supported: true },
  LIVE_RECORDING: { label: "Live recording", deliveryType: "LIVE_RECORDING", supported: true },
  ALTERNATE_VERSION: { label: "Alternate version", deliveryType: "AUDIO", supported: true },
  INSTRUMENTAL: { label: "Instrumental", deliveryType: "AUDIO", supported: true },
  STEMS: { label: "Stems", deliveryType: "STEMS", supported: true },
  MUSIC_VIDEO: { label: "Music video", deliveryType: "VIDEO", supported: true },
  DIGITAL_DOWNLOAD: { label: "Digital download", deliveryType: "DOWNLOAD", supported: true },
  ALTERNATE_ARTWORK: { label: "Alternate artwork", deliveryType: "ARTWORK", supported: false, note: "Artwork delivery is not yet protected by the media gateway." },
  COLLECTOR_ARCHIVE: { label: "Collector archive", deliveryType: "DOWNLOAD", supported: true },
  MEMBERSHIP: { label: "Membership", deliveryType: "TICKET", supported: false },
  VIP_BACKSTAGE: { label: "VIP / backstage", deliveryType: "VIP_ACCESS", supported: false },
  PHYSICAL_DIGITAL: { label: "Physical + digital", deliveryType: "PHYSICAL_REDEMPTION", supported: false, note: "Physical fulfillment is not connected to Artist Studio yet." },
  CUSTOM_EXPERIENCE: { label: "Custom experience", deliveryType: null, supported: false },
});

export function experienceCategory(category) {
  return EXPERIENCE_CATEGORIES[String(category || "").toUpperCase()] || null;
}

export function experienceCategoryLabel(category) {
  return experienceCategory(category)?.label || String(category || "Experience").replaceAll("_", " ");
}

export function createArtist({ id, name, handle = id, wallet = "", address = wallet, bio = "", avatar = "", banner = "", socials = [], verified = false, verification = { status: verified ? "verified" : "unverified" }, releases = [], collectionIds = [], experiences = [], ...rest }) {
  return { type: "artist", id, name, handle, wallet: wallet || address, address: address || wallet, bio, avatar, banner, socials, verified: Boolean(verified), verification, releases, collectionIds, experiences, ...rest };
}
export function createRelease({ id, artistId, title, subtitle = "", description = "", story = "", status = "forthcoming", artwork = "", editions = [], tracks = [], experiences = [], ...rest }) {
  return { type: "release", id, artistId, title, subtitle, description, story, status, artwork, editions, tracks, experiences, ...rest };
}
export function createEdition({ id, releaseId, title, description = "", includes = [], tokenIds = [], contractId = "", contractAddress = "", chainId = null, chain = "", supply = null, status = "available", metadataUri = "", experienceIds = [], experiences = [], tier = "standard", valueProposition = "", ...rest }) {
  return { type: "edition", id, releaseId, title, description, includes, tokenIds, contractId, contractAddress, chainId, chain, supply, status, metadataUri, experienceIds, experiences, tier, valueProposition, ...rest };
}
export function createToken({ id, editionId, tokenId, name = "", metadata = null, media = {}, experiences = [], ...rest }) {
  return { type: "token", id, editionId, tokenId, name, metadata, media, experiences, ...rest };
}
export function createCollection({ id, name, artistIds = [], releaseIds = [], editionIds = [], description = "", source = "artist-owned", imported = false, ...rest }) {
  return { type: "collection", id, name, artistIds, releaseIds, editionIds, description, source, imported, ...rest };
}
export function createRequirement({ type = "ownership", contract = "", tokenIds = [], minAmount = 1, chainId = null, ...rest }) {
  return { type, contract: contract.toLowerCase(), tokenIds: tokenIds.map(String), minAmount, chainId, ...rest };
}
export function createExperience({ id, productType, experienceType = EXPERIENCE_TYPES.AUDIO, title, description = "", requirements = [], media = {}, editionId = null, access = "collector", ...rest }) {
  const category = productType ? experienceCategory(productType) : null;
  if (productType && !category) throw new Error(`Unsupported experience category: ${productType}`);
  const deliveryType = category?.deliveryType || experienceType;
  if (!Object.values(EXPERIENCE_TYPES).includes(deliveryType)) throw new Error(`Unsupported experience type: ${deliveryType}`);
  return { type: "experience", id, productType: productType ? String(productType).toUpperCase() : null, experienceType: deliveryType, title: title || (category ? category.label : ""), description, requirements, media, editionId, access, ...rest };
}
export function createCatalog({ artists = [], releases = [], editions = [], tokens = [], collections = [], experiences = [] }) { return { artists, releases, editions, tokens, collections, experiences }; }
export function catalogById(items = []) { return Object.fromEntries(items.map((item) => [item.id, item])); }
export function getArtistCatalog(catalog, artistId) { const artist = catalog.artists.find((item) => item.id === artistId); if (!artist) return null; const releases = catalog.releases.filter((item) => item.artistId === artistId); const editions = catalog.editions.filter((edition) => releases.some((release) => release.id === edition.releaseId)); const collections = catalog.collections.filter((collection) => collection.artistIds.includes(artistId)); return { artist, releases, editions, collections }; }
export function getReleaseCatalog(catalog, releaseId) { const release = catalog.releases.find((item) => item.id === releaseId); if (!release) return null; return { release, artist: catalog.artists.find((item) => item.id === release.artistId), editions: catalog.editions.filter((item) => item.releaseId === releaseId), experiences: catalog.experiences.filter((item) => release.experiences.includes(item.id)) }; }
export function getEditionCatalog(catalog, editionId) { const edition = catalog.editions.find((item) => item.id === editionId); if (!edition) return null; const release = catalog.releases.find((item) => item.id === edition.releaseId); return { edition, release, artist: catalog.artists.find((item) => item.id === release?.artistId), tokens: catalog.tokens.filter((item) => item.editionId === editionId), experiences: catalog.experiences.filter((item) => (edition.experienceIds || []).includes(item.id) || item.editionId === editionId) }; }
