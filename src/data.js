import { createArtist, createCatalog, createCollection, createEdition, createExperience, createRelease, createToken, EXPERIENCE_TYPES } from "./domain/models.js";

// Static data for the Voidcaller site.
// Reflects the actual project: a self-titled EP collection minted on Avalanche.
//   OpenSea:  https://opensea.io/collection/voidcaller-avalanche
//   Joepegs:  https://joepegs.com/collections/avalanche/voidcaller

// ===========================================================================
// $VOID PRESALE — STAGED, NOT LIVE.
// Flip VOID_LIVE to true ONLY after: (1) legal clearance on US-persons
// exclusion + utility-token framing, and (2) the $BOB launch signal.
// While false, the entire Covenant section and its nav link are hidden.
// Numbers below are the current plan — confirm/adjust before going live.
// ===========================================================================
export const VOID_LIVE = false;

export const VC_DATA = {
  voidPresale: {
    ticker: "$VOID",
    terms: [
      ["833", "AVAX RAISE"],
      ["300,000", "$VOID / AVAX"],
      ["~1.5×", "PRESALE DAY-ONE"],
      ["72h", "CURATED WINDOW"],
    ],
    allocation: [
      ["25%", "PRESALE"],
      ["25%", "LIQUIDITY"],
      ["20%", "ECOSYSTEM"],
      ["15%", "TEAM · 12-MO VEST"],
      ["10%", "RESERVE"],
      ["5%", "VESTING BONUS"],
    ],
    tiers: [
      ["I", "BEARERS", "Holders of the relic. On-chain snapshot — marked first."],
      ["II", "THE CHOIR", "The Grotto community gathers next."],
      ["III", "THE ECOSYSTEM", "AVAX participants, last through the gate."],
    ],
  },
  chain: "AVALANCHE",
  contract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
  // On-chain proof for the self-titled EP — real traction, the trust signal.
  // Update these as the collection moves.
  heroStats: [
    ["477", "BEARERS"],
    ["1,620", "RELICS FORGED"],
    ["17–25×", "FLOOR OVER MINT"],
  ],
  block: "47,118,302",
  gas: "26 nAVAX",
  socials: [
    { name: "Discord", href: "https://discord.gg/9htWQv8v6t" },
    { name: "Twitter/X", href: "https://x.com/VoidcallerOC" },
  ],
  marketplaces: [
    { name: "SNOWTRACE", href: "https://snowtrace.io/address/0xd1b4367dd9f235f9ee61878019d66e31511e98ee" },
    { name: "OPENSEA",   href: "https://opensea.io/collection/voidcaller-avalanche" },
    { name: "JOEPEGS",   href: "https://joepegs.com/collections/avalanche/voidcaller" },
  ],
  releases: [
    {
      id: "I",
      title: "VOIDCALLER",
      subtitle: "Self-titled EP",
      date: "MINTED",
      art: "/assets/voidcaller_art_4.png",
      bleed: "Self-titled EP · on-chain on Avalanche",
      tagline: "The first call. The first relic. One relic unlocks the full EP. Trading on OpenSea and Joepegs — the chain remembers.",
      status: "MINTED",
      mint: "—",
      forged: "—",
      supply: "—",
      live: true,
      tracksKey: "firstEPTracks",
      queueId: "self-titled",
    },
    {
      id: "II",
      title: "TUNNEL VISION",
      subtitle: "Chapter II",
      date: "FORTHCOMING",
      art: "/assets/voidcaller_art_6.png",
      bleed: "Tunnel Vision EP · forthcoming",
      tagline: "Six artifacts. One tunnel. Fragments for the world. The rest for the bearer.",
      status: "FORTHCOMING",
      mint: "TBA",
      forged: "0",
      supply: "TBA",
    },
  ],
  // ============ THE SELF-TITLED EP (released / minted) ============
  // Full tracks are owner-gated. Any Chapter I token (ids 0–3) unlocks the
  // entire EP. Non-owners hear `previewSrc` (30s clip); bearers hear `src`.
  firstEPTracks: [
    { n: "01", title: "The Hollow",       time: "3:57", tokenId: 1, src: "/api/media/stream/audio/ep1-01-the-hollow.mp3",     previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3",     art: "/assets/track-art/ep1-the-hollow.png",     artVid: "/assets/track-art-vid/ep1-the-hollow" },
    { n: "02", title: "Don’t Look Down",  time: "4:20", tokenId: 2, src: "/api/media/stream/audio/ep1-02-dont-look-down.mp3", previewSrc: "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3", art: "/assets/track-art/ep1-dont-look-down.png", artVid: "/assets/track-art-vid/ep1-dont-look-down" },
    { n: "03", title: "Complex",          time: "5:08", tokenId: 3, src: "/api/media/stream/audio/ep1-03-shattered.mp3",      previewSrc: "/assets/audio-preview/ep1-03-complex-preview.mp3",        art: "/assets/track-art/ep1-complex.png",        artVid: "/assets/track-art-vid/ep1-complex" },
    { n: "04", title: "Enough",           time: "4:46", tokenId: 0, src: "/api/media/stream/audio/ep1-04-starlight.mp3",      previewSrc: "/assets/audio-preview/ep1-04-enough-preview.mp3",         art: "/assets/track-art/ep1-enough.png",         artVid: "/assets/track-art-vid/ep1-enough" },
  ],
  // ============ TUNNEL VISION (upcoming) ============
  // Unreleased EP — playback is a ~30s fragment per track until mint.
  tracklist: [
    { n: "01", title: "Warning Signs",   time: "3:38", preview: true, src: "/assets/audio-preview/ep2-01-warning-signs-preview.mp3",   art: "/assets/track-art/ep2-warning-signs.png",   artVid: "/assets/track-art-vid/ep2-warning-signs" },
    { n: "02", title: "Pathway",         time: "3:28", preview: true, src: "/assets/audio-preview/ep2-02-pathway-preview.mp3",         art: "/assets/track-art/ep2-pathway.png",         artVid: "/assets/track-art-vid/ep2-pathway" },
    { n: "03", title: "Immerse",         time: "3:22", preview: true, src: "/assets/audio-preview/ep2-03-immerse-preview.mp3",         art: "/assets/track-art/ep2-immerse.png",         artVid: "/assets/track-art-vid/ep2-immerse" },
    { n: "04", title: "Aligned",         time: "3:21", preview: true, src: "/assets/audio-preview/ep2-04-aligned-preview.mp3",         art: "/assets/track-art/ep2-aligned.png",         artVid: "/assets/track-art-vid/ep2-aligned" },
    { n: "05", title: "The Noise",       time: "3:29", preview: true, src: "/assets/audio-preview/ep2-05-the-noise-preview.mp3",       art: "/assets/track-art/ep2-the-noise.png",       artVid: "/assets/track-art-vid/ep2-the-noise" },
    { n: "06", title: "Lessons Learned", time: "3:51", preview: true, src: "/assets/audio-preview/ep2-06-lessons-learned-preview.mp3", art: "/assets/track-art/ep2-lessons-learned.png", artVid: "/assets/track-art-vid/ep2-lessons-learned" },
  ],
  featuredEP: {
    id: "II",
    title: "TUNNEL VISION",
    subtitle: "Chapter II · Forthcoming",
    art: "/assets/voidcaller_art_6.png",
    pullquote: "Six artifacts. One tunnel. The wait was the point.",
    body: "Fragments play for everyone. The masters live with the bearer. Chapter I is already on-chain — one relic unlocks that entire EP.",
  },
  manifesto: [
    "We are not a stream. We are a record.",
    "Own the relic, own the song.",
    "The chain remembers what the world forgets.",
  ],
  unlocks: [
    ["FULL TRACKS", "One Chapter I relic unlocks the entire self-titled EP. The unmarked hear only a fragment."],
    ["CHOIR ACCESS", "Witness. Choir. Crossed. Marks read from the chain — no new token, no points."],
  ],
  lyrics: {
    "01": "Searching for the light in the dark",
    "02": "For the light we left behind",
    "03": "I sink beneath the surface of your lies",
    "04": "What breaks you might make you whole",
    "05": "Either live with meaning, or stay lost within the noise",
    "06": "Look at me now — am I a man or just a let down",
  },
};

// Platform-facing records. Voidcaller is the first catalog, not a special case
// in the UI or Web3 layers.
const voidcallerArtist = createArtist({
  id: "voidcaller",
  name: "Voidcaller",
  handle: "VoidcallerOC",
  bio: "A music-native project where records become relics and ownership unlocks the full experience.",
  avatar: "/assets/voidcaller_art_4.png",
  banner: "/assets/voidcaller_art_6.png",
  socials: VC_DATA.socials,
  verified: true,
});

const voidcallerRelease = createRelease({
  id: "voidcaller-self-titled",
  artistId: "voidcaller",
  title: "VOIDCALLER",
  subtitle: "Self-titled EP",
  description: "The first call. The first relic. One relic unlocks the full EP.",
  story: VC_DATA.releases[0].tagline,
  status: "minted",
  artwork: "/assets/voidcaller_art_4.png",
  experiences: ["voidcaller-full-ep"],
  tracks: VC_DATA.firstEPTracks.map(({ n, title, time }) => ({ n, title, time })),
});

const voidcallerEdition = createEdition({
  id: "voidcaller-chapter-i",
  releaseId: "voidcaller-self-titled",
  title: "Chapter I · The Relic",
  description: "The ERC-1155 edition for the self-titled EP.",
  includes: ["Full self-titled EP", "Collector reliquary access", "Token-gated music experiences"],
  tokenIds: [0, 1, 2, 3],
  contractId: "voidcaller-avalanche",
  contractAddress: VC_DATA.contract,
  chainId: 43114,
  chain: "AVALANCHE",
  supply: "1,620",
  status: "minted",
  experienceIds: ["voidcaller-full-ep"],
});

const voidcallerExperience = createExperience({
  id: "voidcaller-full-ep",
  experienceType: EXPERIENCE_TYPES.AUDIO,
  title: "The Full Record",
  description: "One Chapter I relic unlocks the entire self-titled EP.",
  requirements: [{ type: "erc1155-balance", contract: VC_DATA.contract, tokenIds: [0, 1, 2, 3] }],
  media: { type: "audio", releaseId: "voidcaller-self-titled", protected: true, previewAvailable: true },
});

export const VOIDCALLER_CATALOG = createCatalog({
  artists: [voidcallerArtist],
  releases: [voidcallerRelease],
  editions: [voidcallerEdition],
  tokens: voidcallerEdition.tokenIds.map((tokenId) => createToken({ id: `voidcaller-token-${tokenId}`, editionId: voidcallerEdition.id, tokenId, name: `Voidcaller Relic #${tokenId}` })),
  collections: [createCollection({ id: "voidcaller-collection", name: "Voidcaller Reliquary", artistIds: [voidcallerArtist.id], releaseIds: [voidcallerRelease.id], editionIds: [voidcallerEdition.id], description: "The first artist collection on the music-native platform." })],
  experiences: [voidcallerExperience],
});

export const DISCOVERY_CATEGORIES = ["featured", "artists", "limited-editions"];
export const DISCOVERY = {
  featured: [voidcallerRelease.id],
  artists: [voidcallerArtist.id],
  "limited-editions": [voidcallerEdition.id],
};
