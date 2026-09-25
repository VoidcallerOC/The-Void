// Legacy / genesis Voidcaller collection on Avalanche C-Chain MAINNET.
// Enumerated from TransferSingle + TransferBatch logs against
// 0xD1B4367dd9f235f9ee61878019d66E31511E98eE (chainId 43114).
// No repo master audio is referenced here. Besides the public 30s previews,
// the only audio is each token's animation_url from its on-chain metadata,
// which is already public on IPFS to anyone who reads the token URI.

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

// Public IPFS media from each token's on-chain metadata (uri(id) resolves to
// LEGACY_URI_TEMPLATE). Verified against the metadata JSON on 2026-09-25.
// contentType is what the gateway serves: token 0's "0.mp3" is WAV data.
export const LEGACY_METADATA_BASE = "ipfs://bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte";
export const LEGACY_IPFS_MEDIA = Object.freeze({
  0: Object.freeze({ image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif", animationUrl: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.mp3", audioContentType: "audio/wav" }),
  1: Object.freeze({ image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif", animationUrl: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3", audioContentType: "audio/mpeg" }),
  2: Object.freeze({ image: "ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs", animationUrl: "ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn", audioContentType: "audio/wav" }),
  3: Object.freeze({ image: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif", animationUrl: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.wav", audioContentType: "audio/wav" }),
});

// Same public gateway the frontend uses (src/lib/web3.js ipfsToHttp).
export const LEGACY_IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

export function legacyMetadataUri(tokenId) {
  return `${LEGACY_METADATA_BASE}/${tokenId}`;
}

export function legacyIpfsToHttp(uri, gateway = LEGACY_IPFS_GATEWAY) {
  const value = String(uri || "");
  return value.startsWith("ipfs://") ? `${gateway.replace(/\/?$/, "/")}${value.slice(7)}` : value;
}

const PUBLIC_ARTWORK = new Set(Object.values(LEGACY_IPFS_MEDIA).flatMap((media) => [media.image, legacyIpfsToHttp(media.image)]));

// Exact-match allowlist for the four public token images. Anything else that
// looks like a CID is still redacted from public API responses.
export function isPublicLegacyArtwork(value) {
  return typeof value === "string" && PUBLIC_ARTWORK.has(value);
}

// Token id whose on-chain animation_url is exactly this URI, or null.
export function legacyAudioTokenId(uri) {
  for (const [tokenId, media] of Object.entries(LEGACY_IPFS_MEDIA)) {
    if (media.animationUrl === uri) return Number(tokenId);
  }
  return null;
}

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
