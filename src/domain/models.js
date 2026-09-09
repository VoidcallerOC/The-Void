// Music-native platform domain models. These are application records rather
// than blockchain records; contract data is infrastructure attached to editions.
export const EXPERIENCE_TYPES = Object.freeze({
  AUDIO: "AUDIO", VIDEO: "VIDEO", STEMS: "STEMS", DOWNLOAD: "DOWNLOAD", ARTWORK: "ARTWORK", LYRICS: "LYRICS", DEMO: "DEMO", LIVE_RECORDING: "LIVE_RECORDING", TICKET: "TICKET", VIP_ACCESS: "VIP_ACCESS", DISCOUNT: "DISCOUNT", PHYSICAL_REDEMPTION: "PHYSICAL_REDEMPTION",
});

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
export function createExperience({ id, experienceType = EXPERIENCE_TYPES.AUDIO, title, description = "", requirements = [], media = {}, editionId = null, access = "collector", ...rest }) {
  if (!Object.values(EXPERIENCE_TYPES).includes(experienceType)) throw new Error(`Unsupported experience type: ${experienceType}`);
  return { type: "experience", id, experienceType, title, description, requirements, media, editionId, access, ...rest };
}
export function createCatalog({ artists = [], releases = [], editions = [], tokens = [], collections = [], experiences = [] }) { return { artists, releases, editions, tokens, collections, experiences }; }
export function catalogById(items = []) { return Object.fromEntries(items.map((item) => [item.id, item])); }
export function getArtistCatalog(catalog, artistId) { const artist = catalog.artists.find((item) => item.id === artistId); if (!artist) return null; const releases = catalog.releases.filter((item) => item.artistId === artistId); const editions = catalog.editions.filter((edition) => releases.some((release) => release.id === edition.releaseId)); const collections = catalog.collections.filter((collection) => collection.artistIds.includes(artistId)); return { artist, releases, editions, collections }; }
export function getReleaseCatalog(catalog, releaseId) { const release = catalog.releases.find((item) => item.id === releaseId); if (!release) return null; return { release, artist: catalog.artists.find((item) => item.id === release.artistId), editions: catalog.editions.filter((item) => item.releaseId === releaseId), experiences: catalog.experiences.filter((item) => release.experiences.includes(item.id)) }; }
export function getEditionCatalog(catalog, editionId) { const edition = catalog.editions.find((item) => item.id === editionId); if (!edition) return null; const release = catalog.releases.find((item) => item.id === edition.releaseId); return { edition, release, artist: catalog.artists.find((item) => item.id === release?.artistId), tokens: catalog.tokens.filter((item) => item.editionId === editionId), experiences: catalog.experiences.filter((item) => edition.experienceIds.includes(item.id)) }; }
