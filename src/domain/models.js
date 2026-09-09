// Music-native platform domain models. These are application records rather
// than blockchain records; contract data is infrastructure attached to editions.
export function createArtist({ id, name, handle = id, wallet = "", address = wallet, bio = "", avatar = "", banner = "", socials = [], verified = false, verification = { status: verified ? "verified" : "unverified" }, releases = [], collectionIds = [], experiences = [], ...rest }) {
  return { type: "artist", id, name, handle, wallet: wallet || address, address: address || wallet, bio, avatar, banner, socials, verified: Boolean(verified), verification, releases, collectionIds, experiences, ...rest };
}

export function createRelease({ id, artistId, title, subtitle = "", description = "", story = "", status = "forthcoming", artwork = "", editions = [], tracks = [], experiences = [], ...rest }) {
  return { type: "release", id, artistId, title, subtitle, description, story, status, artwork, editions, tracks, experiences, ...rest };
}

export function createEdition({ id, releaseId, title, description = "", includes = [], tokenIds = [], contractId = "", contractAddress = "", chainId = null, chain = "", supply = null, status = "available", metadataUri = "", experienceIds = [], experiences = [], ...rest }) {
  return { type: "edition", id, releaseId, title, description, includes, tokenIds, contractId, contractAddress, chainId, chain, supply, status, metadataUri, experienceIds, experiences, ...rest };
}

export function createToken({ id, editionId, tokenId, name = "", metadata = null, media = {}, experiences = [], ...rest }) {
  return { type: "token", id, editionId, tokenId, name, metadata, media, experiences, ...rest };
}

export function createCollection({ id, name, artistIds = [], releaseIds = [], editionIds = [], description = "", source = "artist-owned", imported = false, ...rest }) {
  return { type: "collection", id, name, artistIds, releaseIds, editionIds, description, source, imported, ...rest };
}

export function createExperience({ id, experienceType = "music", title, description = "", requirements = [], media = {}, ...rest }) {
  return { type: "experience", id, experienceType, title, description, requirements, media, ...rest };
}

export function createCatalog({ artists = [], releases = [], editions = [], tokens = [], collections = [], experiences = [] }) {
  return { artists, releases, editions, tokens, collections, experiences };
}

export function catalogById(items = []) { return Object.fromEntries(items.map((item) => [item.id, item])); }
export function getArtistCatalog(catalog, artistId) {
  const artist = catalog.artists.find((item) => item.id === artistId);
  if (!artist) return null;
  const releases = catalog.releases.filter((item) => item.artistId === artistId);
  const editions = catalog.editions.filter((edition) => releases.some((release) => release.id === edition.releaseId));
  const collections = catalog.collections.filter((collection) => collection.artistIds.includes(artistId));
  return { artist, releases, editions, collections };
}
export function getReleaseCatalog(catalog, releaseId) {
  const release = catalog.releases.find((item) => item.id === releaseId);
  if (!release) return null;
  return { release, artist: catalog.artists.find((item) => item.id === release.artistId), editions: catalog.editions.filter((item) => item.releaseId === releaseId), experiences: catalog.experiences.filter((item) => release.experiences.includes(item.id)) };
}
export function getEditionCatalog(catalog, editionId) {
  const edition = catalog.editions.find((item) => item.id === editionId);
  if (!edition) return null;
  const release = catalog.releases.find((item) => item.id === edition.releaseId);
  return { edition, release, artist: catalog.artists.find((item) => item.id === release?.artistId), tokens: catalog.tokens.filter((item) => item.editionId === editionId), experiences: catalog.experiences.filter((item) => edition.experienceIds.includes(item.id)) };
}
