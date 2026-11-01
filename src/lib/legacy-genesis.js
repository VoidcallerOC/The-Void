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

// Each token's on-chain metadata `description`, verbatim (uri(id) -> description), read from
// LEGACY_METADATA_BASE on 2026-11-01. Empty where the token's metadata has none. Public by definition.
export const LEGACY_TOKEN_DESCRIPTIONS = Object.freeze({
  0: "Art by Wrathtank_avax",
  1: "“The Hollow” was born from the anger of watching those in positions of influence or power, continue to take advantage.\nWatching as people were led away from their dreams. Watching as the world falls into disillusion.\n“The Hollow” stands to represent the ones who have watched for too long. The one’s who scream for change, we hear your cries.\nWatch the fall of false prophets; Embrace the Void.\n\nLYRICS:\n\nCan you believe this?\n\nHow many lives we’ve lost to their unholy ignorance.\n\nNow there’s only us\n\n(Stand up)\nRead between the lines\n\nCarry on.\nBreathe slow it’s cold as ice,\n\nEven when their eyes seem so inviting.\nSpeak true,\nno alibis,\nBe the change to make this never ending\nFear not what’s next to come.\nThere’s a page for every story’s last act.\nWe’re not the ones to rot,\nAfter all we’ve weathered leaves us breathless.\nHas Heaven left us?\n\nI’ve seen the fall of angels,\nDemons dance around us.\nCracks begin to show\nShatter\nLeft within your mind,\nHollow.\nCan you believe this?\n\nHow many lives we’ve lost to their unholy ignorance.\n\nNow there’s only us\n\n(Stand up)\nRead between the lines\n\nCarry on.\n\nThe words are echoing around in my head.\n\n“The problems’ handled, but there’s too many dead.”\nFathers and mothers.\n\nThe Devil’s eyes are watching you.\nIn violence, we found this.\nWith confidence we’re coming through.\nExcuse us, we can’t trust.\nThe leaders all collapse around us.\nSilence the mind just,\nOpen up your eyes and see the sun.\nThe mindless, claimed prophets,\n\nHold the knife they think will stop us.\nBarren, and senseless,\nAll hope is lost for those forgotten.\nBelieve it,\ngo seize it.\nThe future’s bright for those who see it\nSilence the mind just,\nOpen up your eyes and see the sun.\nI feel the rope wrap around my neck,\n\nWith every outcry there’s distraction instead.\nI can’t believe how many lives were wasted;\nBastards\nHow many families ripped apart;\n\n“forever after.”\nHas Heaven left us?\n\nI’ve seen the fall of angels,\nDemons dance around us.\nCracks begin to show\nShatter\nLeft within your mind,\nHollow.\n\nArt by Wrathtank_avax",
  2: "Faced with insurmountable challenges.\nBridging the gap between where you are and where you want to be is daunting, to say the least.\nBelieve in your mission, breathe, take the leap, and \"Don't Look Down.\"\nArt by Wrathtank_avax",
  3: "",
});

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

/** Evidence that exists for the four minted mainnet tokens, and the gaps that
 * forbid a verified provenance backfill. This does not write those releases. */
export function legacyReleaseEvidence() {
  return {
    sufficientForVerifiedProvenance: false,
    chainId: LEGACY_CHAIN_ID,
    contract: LEGACY_CONTRACT,
    metadataBase: LEGACY_METADATA_BASE,
    copyrightOwnership: false,
    artistVerification: "CONTRACT_OWNER_WALLET_ONLY",
    gaps: [
      "Each token URI is an IPFS metadata document, not a Studio canonical provenance document, and none contains a provenance root.",
      "Artwork and audio are IPFS URIs. The repository does not contain SHA-256 digests of those exact bytes.",
      "Token 0's animation URL ends in .mp3 but the gateway content type is audio/wav. A filename is not a byte identity.",
      "Original mint transaction hashes and block timestamps are not stored here. They have to be read from C-Chain before any later backfill.",
    ],
    tokens: LEGACY_TOKENS.map((token) => ({
      tokenId: token.tokenId,
      title: token.title,
      metadataUri: legacyMetadataUri(token.tokenId),
      image: LEGACY_IPFS_MEDIA[token.tokenId].image,
      animationUrl: LEGACY_IPFS_MEDIA[token.tokenId].animationUrl,
      audioContentType: LEGACY_IPFS_MEDIA[token.tokenId].audioContentType,
      provenanceRoot: null,
    })),
  };
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

// The live original catalog: release id or slug voidcaller-legacy-genesis,
// or any edition of that release on the legacy mainnet contract. Title is
// not an identity. A later Fuji release can be named VOIDCALLER.
export function isLegacyMainnetCatalogRelease(release, editions = []) {
  if (!release || typeof release !== "object") return false;
  const id = String(release.id ?? "").trim();
  const slug = String(release.slug ?? "").trim();
  if (id === LEGACY_ALBUM_ID || slug === LEGACY_ALBUM_ID) return true;
  if (!id) return false;
  return editions.some((edition) => {
    const editionReleaseId = String(edition?.releaseId ?? edition?.release_id ?? "").trim();
    return editionReleaseId === id && isLegacyMainnetEdition(edition);
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
