// Generalized collector domain. The blockchain/indexer supplies ownership records;
// catalog records only explain the music and experiences attached to each asset.
export function createOwnershipRecord({ wallet, contract, tokenId, amount = 0, chain, updatedAt = Date.now(), ...rest }) {
  return { wallet: String(wallet || "").toLowerCase(), contract: String(contract || "").toLowerCase(), tokenId: String(tokenId), amount: Number(amount), chain, updatedAt, ...rest };
}

export function ownershipKey({ contract, tokenId, chain }) { return `${String(chain)}:${String(contract).toLowerCase()}:${String(tokenId)}`; }

export function normalizeOwnershipRecords(records = [], wallet = "") {
  return records.filter((record) => Number(record.amount) > 0).map((record) => createOwnershipRecord({ ...record, wallet: record.wallet || wallet })).sort((a, b) => ownershipKey(a).localeCompare(ownershipKey(b)));
}

export function mergeOwnershipRecords(records = []) {
  const merged = new Map();
  for (const record of records) {
    const key = ownershipKey(record);
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, amount: prior.amount + Number(record.amount), updatedAt: Math.max(prior.updatedAt, record.updatedAt) } : { ...record, amount: Number(record.amount) });
  }
  return [...merged.values()];
}

function editionMatches(record, edition) {
  return String(record.contract).toLowerCase() === String(edition.contractAddress).toLowerCase() && Number(record.chain?.id || record.chainId || record.chain) === Number(edition.chainId) && edition.tokenIds.map(String).includes(String(record.tokenId));
}

export function getCollectorLibrary(catalog, records = []) {
  const ownership = mergeOwnershipRecords(normalizeOwnershipRecords(records));
  const ownedEditions = catalog.editions.map((edition) => {
    const holdings = ownership.filter((record) => editionMatches(record, edition));
    if (!holdings.length) return null;
    const release = catalog.releases.find((item) => item.id === edition.releaseId);
    const artist = catalog.artists.find((item) => item.id === release?.artistId);
    const experiences = catalog.experiences.filter((experience) => edition.experienceIds.includes(experience.id));
    return { edition, release, artist, holdings, quantity: holdings.reduce((sum, record) => sum + record.amount, 0), experiences };
  }).filter(Boolean);
  return {
    ownership,
    editions: ownedEditions,
    releases: [...new Map(ownedEditions.map((item) => [item.release?.id, item.release]).filter(([id]) => id)).values()],
    artists: [...new Map(ownedEditions.map((item) => [item.artist?.id, item.artist]).filter(([id]) => id)).values()],
    experiences: ownedEditions.flatMap((item) => item.experiences.map((experience) => ({ ...experience, edition: item.edition, release: item.release, artist: item.artist }))),
  };
}

export function hasOwnershipRequirement(requirement, ownership = []) {
  const matching = ownership.filter((record) => String(record.contract).toLowerCase() === String(requirement.contract).toLowerCase() && requirement.tokenIds.map(String).includes(String(record.tokenId)));
  const amount = matching.reduce((sum, record) => sum + Number(record.amount), 0);
  return amount >= Number(requirement.minAmount || 1);
}

export function canAccessExperience(experience, ownership = []) {
  return (experience?.requirements || []).every((requirement) => hasOwnershipRequirement(requirement, ownership));
}

export function createCollectionActivity({ type, wallet, contract, tokenId, amount = 1, chain, timestamp = Date.now(), ...rest }) {
  return { type, wallet: wallet?.toLowerCase(), contract: contract?.toLowerCase(), tokenId: String(tokenId), amount, chain, timestamp, ...rest };
}
