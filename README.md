# Voidcaller — The Void

On-chain metalcore. Music as ritual, NFT as relic.

- Live (Grotto): https://voidcaller.enterthegrotto.xyz
- This repo’s Vercel deploy: https://voidcaller-site.vercel.app
- Collection (Avalanche C-Chain): [`0xd1b4367dd9f235f9ee61878019d66e31511e98ee`](https://snowtrace.io/address/0xd1b4367dd9f235f9ee61878019d66e31511e98ee)
- Markets: [OpenSea](https://opensea.io/collection/voidcaller-avalanche) · [Joepegs](https://joepegs.com/collections/avalanche/voidcaller)

## What this is

Chapter I is a four-track self-titled EP minted as ERC-1155 relics on Avalanche. **Any one Chapter I relic unlocks the full EP** in the player. Everyone else hears ~30s fragments. Chapter II (*Tunnel Vision*) is forthcoming — fragments only until mint.

The Reliquary reads ownership on C-Chain and The Grotto. Marks (Witness / Choir / Crossed) are computed from those balances — no extra token.

## Run locally

```bash
npm install
npm run dev
```

```bash
npm run build
npm run preview
```

React + Vite. No wallet keys or env vars required. Public Avalanche RPCs are hardcoded in `src/lib/web3.js`.

## Layout

| Path | Page |
| --- | --- |
| `/` | Hero / claim |
| `/chronicle` | Releases |
| `/the-call` | Player + Chapter II fragments (also `/the-bleed`) |
| `/reliquary` | On-chain relics |
| `/choir` | Marks / community |
| `/covenant` | Hidden until `VOID_LIVE` in `src/data.js` |

## How audio gating works

`src/lib/audio.js` picks `previewSrc` vs `src` from wallet ownership. **This is client-side.** Full masters live under `/public/assets/audio` and can be fetched directly. Real gating needs a signed / ownership-checked endpoint — not in this repo yet.

## Web3

`src/lib/web3.js` is dependency-free (`eth_call` + hand-rolled ABI). It covers:

- ERC-1155 `balanceOf` on C-Chain and Grotto
- metadata from IPFS (Pinata) with a hardcoded fallback
- `safeTransferFrom` encoding for the Reliquary send modal

Hero stats in `src/data.js` are a snapshot. Update them when the collection moves.

## Scripts

- `scripts/make-previews.mjs` / `make-previews-ep1.mjs` — 30s clips
- `scripts/gifs-to-video.mjs` — track-art loops

Audio and art in `public/assets` are large. That’s expected.

## $VOID / Covenant

`VOID_LIVE` in `src/data.js` stays `false` until legal clearance and the launch signal. Do not flip it casually.
