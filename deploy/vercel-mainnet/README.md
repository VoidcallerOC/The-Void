# Mainnet web (Avalanche C-Chain)

Isolated Vercel project for C-Chain (`43114`). Do **not** retarget the Fuji project
(`the-void` / `the-void-alpha.vercel.app`) — that surface stays on Fuji (`43113`) and
`vercel.json` at the repo root.

## Root cause this project fixes

The Fuji production build defaults `RELEASE_DEPLOYMENT.chainId` to **43113**. A wallet on
C-Chain then hits a silent `AUTH_CHAIN_UNSUPPORTED` on **AUTH REQUIRED** (“Switch your wallet
to Avalanche Fuji (43113)…”). Mainnet auth requires this separate build with
`VITE_RELEASE_NETWORK=mainnet`.

## Create the Vercel project (owner)

1. New Vercel project from `VoidcallerOC/The-Void`.
2. **Root Directory:** `deploy/vercel-mainnet` (uses this folder’s `vercel.json`).
3. Do **not** reuse the Fuji project’s production domain until cutover is approved.
4. Optional dashboard env (also baked into `buildCommand` from the recorded manifest):
   - `VITE_MARKETPLACE_CHAIN_ID=43114`
   - `VITE_MARKETPLACE_ADDRESS=0x0e77116142844478a55EEd2Ab79de9F93770F8f5`
   - `VITE_MARKETPLACE_FEE_BPS=250`
   - `VITE_IPFS_GATEWAY=https://fuchsia-labour-butterfly-445.mypinata.cloud/ipfs/` — the account's dedicated Pinata
     gateway, used only for artwork images (`src/lib/artwork.js`): resized WebP through the gateway's image optimization,
     with the public gateway as the fallback. Audio and anything the account did not pin keep the public gateway.
5. API rewrites target `https://the-void-api-mainnet.onrender.com`. Provision that Render
   service first (`deploy/mainnet/render.mainnet.yaml`) and set API `PUBLIC_APP_URL` /
   `AUTH_DOMAIN` / `AUTH_URI` / `AUTH_ALLOWED_CHAIN_IDS=43114` to this project’s origin.

## Local verify (no deploy)

```bash
npm run build:mainnet
npm run test -- src/lib/release-network-mainnet.test.js server/mainnet-runtime-config.test.js
```

Expect the main bundle / selected modules to resolve chain **43114**, factory
`0x262B774cf9a1949170B58E2d57F6189980FE757b`, marketplace
`0x0e77116142844478a55EEd2Ab79de9F93770F8f5`.
