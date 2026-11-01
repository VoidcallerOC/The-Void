import { artworkSources } from "./artwork.js";

function durationSeconds(value) {
  const match = /^(\d+):(\d{2})$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function shortAddress(address) {
  const value = String(address || "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * Metadata for one experience row, from the catalog only (nothing invented): a song row reads the token the
 * experience is linked to (its own on-chain name, description and image, plus the catalog's track length);
 * a whole-record row lists the edition's tracks and their total runtime. Null fields are simply not shown.
 */
export function experienceRowMetadata(catalog, experience, edition = null) {
  const tokens = catalog?.tokens || [];
  const tokenId = experience.media?.tokenId;
  const linked = tokens.find((token) => (token.experiences || []).includes(experience.id))
    || (tokenId === undefined || tokenId === null ? null : tokens.find((token) => String(token.tokenId) === String(tokenId) && (!experience.editionId || token.editionId === experience.editionId)));
  const owningEdition = linked ? (catalog?.editions || []).find((item) => item.id === linked.editionId) || edition : edition;
  const requirement = (experience.requirements || []).find((item) => item.contract);
  const contract = owningEdition?.contractAddress || requirement?.contract || "";
  const chainId = Number(owningEdition?.chainId ?? requirement?.chainId) || null;
  if (linked) {
    const metadata = linked.metadata || {};
    return {
      kind: "track",
      tokenId: String(linked.tokenId),
      duration: linked.song?.duration || null,
      description: typeof metadata.description === "string" ? metadata.description.trim() : "",
      artworkSources: [...new Set([...artworkSources(metadata.image || ""), linked.media?.art].filter(Boolean))],
      contract,
      chainId,
    };
  }
  const editionTokens = edition ? tokens.filter((token) => token.editionId === edition.id && token.song) : [];
  if (!editionTokens.length) return null;
  const lengths = editionTokens.map((token) => durationSeconds(token.song.duration));
  return {
    kind: "record",
    trackCount: editionTokens.length,
    totalDuration: lengths.every((value) => value !== null) ? formatDuration(lengths.reduce((sum, value) => sum + value, 0)) : null,
    tokenIds: editionTokens.map((token) => String(token.tokenId)),
    contract,
    chainId,
  };
}
