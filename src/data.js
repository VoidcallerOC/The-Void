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
      tagline: "The first call. The first relic. Live on Avalanche, trading on OpenSea and Joepegs.",
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
      tagline: "The choir grows. The next bleed: six tracks, one tunnel.",
      status: "FORTHCOMING",
      mint: "TBA",
      forged: "0",
      supply: "TBA",
    },
  ],
  // ============ THE SELF-TITLED EP (released / minted) ============
  // Full tracks are owner-gated. `tokenId` ties each track to its on-chain relic
  // (ERC-1155 ids 0–3). Non-owners hear `previewSrc` (30s clip); bearers hear the
  // full `src`. Gating is resolved in lib/audio.js against the connected wallet.
  firstEPTracks: [
    { n: "01", title: "The Hollow",       time: "3:57", tokenId: 1, src: "/assets/audio/ep1-01-the-hollow.mp3",     previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3",     art: "/assets/track-art/ep1-the-hollow.png",     artVid: "/assets/track-art-vid/ep1-the-hollow" },
    { n: "02", title: "Don’t Look Down",  time: "4:20", tokenId: 2, src: "/assets/audio/ep1-02-dont-look-down.mp3", previewSrc: "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3", art: "/assets/track-art/ep1-dont-look-down.png", artVid: "/assets/track-art-vid/ep1-dont-look-down" },
    { n: "03", title: "Complex",          time: "5:08", tokenId: 3, src: "/assets/audio/ep1-03-shattered.mp3",      previewSrc: "/assets/audio-preview/ep1-03-complex-preview.mp3",        art: "/assets/track-art/ep1-complex.png",        artVid: "/assets/track-art-vid/ep1-complex" },
    { n: "04", title: "Enough",           time: "4:46", tokenId: 0, src: "/assets/audio/ep1-04-starlight.mp3",      previewSrc: "/assets/audio-preview/ep1-04-enough-preview.mp3",         art: "/assets/track-art/ep1-enough.png",         artVid: "/assets/track-art-vid/ep1-enough" },
  ],
  // ============ TUNNEL VISION (upcoming) ============
  // Unreleased EP — playback is a ~30s "best part" preview clip per track.
  // `time` is the real song length; `preview: true` marks clip-only playback.
  tracklist: [
    { n: "01", title: "Warning Signs",   time: "3:38", preview: true, src: "/assets/audio-preview/ep2-01-warning-signs-preview.mp3",   art: "/assets/track-art/ep2-warning-signs.png",   artVid: "/assets/track-art-vid/ep2-warning-signs" },
    { n: "02", title: "Pathway",         time: "3:28", preview: true, src: "/assets/audio-preview/ep2-02-pathway-preview.mp3",         art: "/assets/track-art/ep2-pathway.png",         artVid: "/assets/track-art-vid/ep2-pathway" },
    { n: "03", title: "Immerse",         time: "3:22", preview: true, src: "/assets/audio-preview/ep2-03-immerse-preview.mp3",         art: "/assets/track-art/ep2-immerse.png",         artVid: "/assets/track-art-vid/ep2-immerse" },
    { n: "04", title: "Aligned",         time: "3:21", preview: true, src: "/assets/audio-preview/ep2-04-aligned-preview.mp3",         art: "/assets/track-art/ep2-aligned.png",         artVid: "/assets/track-art-vid/ep2-aligned" },
    { n: "05", title: "The Noise",       time: "3:29", preview: true, src: "/assets/audio-preview/ep2-05-the-noise-preview.mp3",       art: "/assets/track-art/ep2-the-noise.png",       artVid: "/assets/track-art-vid/ep2-the-noise" },
    { n: "06", title: "Lessons Learned", time: "3:51", preview: true, src: "/assets/audio-preview/ep2-06-lessons-learned-preview.mp3", art: "/assets/track-art/ep2-lessons-learned.png", artVid: "/assets/track-art-vid/ep2-lessons-learned" },
  ],
  // The Bleed section showcases the upcoming Tunnel Vision EP — playable previews.
  featuredEP: {
    id: "II",
    title: "TUNNEL VISION",
    subtitle: "Chapter II · Forthcoming",
    art: "/assets/voidcaller_art_6.png",
    pullquote: "Six tracks. One tunnel. The choir grows.",
    body: "Streamed off-chain, forged on-chain. Bearers of the relic will carry the masters and unlock the stems for live remix nights in the choir.",
  },
  manifesto: [
    "We are not a band. We are a broadcast.",
    "Every relic is a record of the bleed.",
    "The chain remembers what the world forgets.",
  ],
  // What holding a relic unlocks — real NFT utility, shown on The Bleed.
  // STEMS / REMIX RIGHTS pulled for now (no stems for the first releases yet).
  unlocks: [
    ["FULL TRACKS", "Own the relic, own the song. Bearers stream every track end to end — the unmarked hear only a fragment."],
    ["CHOIR ACCESS", "The inner gathering. Live remix nights, first listens, and the rooms where the next chapter is forged first."],
  ],
  // Per-track lyric pulls for The Bleed now-playing display. Drop in one real
  // standout line from each Tunnel Vision track (keep it short). Empty = hidden.
  lyrics: {
    "01": "Searching for the light in the dark",
    "02": "For the light we left behind",
    "03": "I sink beneath the surface of your lies",
    "04": "What breaks you might make you whole",
    "05": "Either live with meaning, or stay lost within the noise",
    "06": "Look at me now — am I a man or just a let down",
  },
};
