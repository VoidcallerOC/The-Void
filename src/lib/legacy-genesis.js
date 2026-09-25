// Legacy / genesis Voidcaller collection on Avalanche C-Chain MAINNET.
// Enumerated from TransferSingle + TransferBatch logs against
// 0xD1B4367dd9f235f9ee61878019d66E31511E98eE (chainId 43114).
// Full-track masters are never listed here — only public 30s previews.

export const LEGACY_CHAIN_ID = 43114;
export const LEGACY_CONTRACT = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
export const LEGACY_IMPLEMENTATION = "0x2e61967a569bc18affc5e1b9f71e00af93a268c7";
export const LEGACY_NAME = "Voidcaller";
export const LEGACY_SYMBOL = "VOIDCALLER";
export const LEGACY_URI_TEMPLATE = "ipfs://bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte/{id}";

// Minted token IDs only. uri(4)+ exists as a template but was never minted.
export const LEGACY_TOKENS = Object.freeze([
  { tokenId: 0, title: "Enough", slug: "enough", time: "4:46", previewSrc: "/assets/audio-preview/ep1-04-enough-preview.mp3", art: "/assets/track-art/ep1-enough.png", n: "01" },
  { tokenId: 1, title: "The Hollow", slug: "the-hollow", time: "3:57", previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3", art: "/assets/track-art/ep1-the-hollow.png", n: "02" },
  { tokenId: 2, title: "Don't Look Down", slug: "dont-look-down", time: "4:20", previewSrc: "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3", art: "/assets/track-art/ep1-dont-look-down.png", n: "03" },
  { tokenId: 3, title: "Complex", slug: "complex", time: "5:08", previewSrc: "/assets/audio-preview/ep1-03-complex-preview.mp3", art: "/assets/track-art/ep1-complex.png", n: "04" },
]);

export const LEGACY_ALBUM_ID = "voidcaller-legacy-genesis";
export const LEGACY_EDITION_ID = "voidcaller-legacy-edition";

export function legacyExperienceId(tokenId) {
  return `voidcaller-legacy-track-${tokenId}`;
}

export function isLegacyMainnetRequirement(requirement) {
  if (!requirement || typeof requirement !== "object") return false;
  const chainId = Number(requirement.chainId);
  const contract = String(requirement.contract || "").toLowerCase();
  return chainId === LEGACY_CHAIN_ID && contract === LEGACY_CONTRACT;
}

// True for an edition (catalog model or API row) on the legacy mainnet
// contract. These editions are never sold through the Fuji primary sale.
export function isLegacyMainnetEdition(edition) {
  if (!edition || typeof edition !== "object") return false;
  return isLegacyMainnetRequirement({
    chainId: edition.chainId ?? edition.chain_id,
    contract: edition.contractAddress ?? edition.contract_address,
  });
}

export function publicLegacyTracks() {
  return LEGACY_TOKENS.map((track) => ({
    n: track.n,
    title: track.title,
    time: track.time,
    tokenId: track.tokenId,
    previewSrc: track.previewSrc,
    art: track.art,
    protectedMedia: { experienceId: legacyExperienceId(track.tokenId), mediaType: "AUDIO" },
  }));
}
