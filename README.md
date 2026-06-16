# Voidcaller — The Void

On-chain metalcore. Music as ritual, NFT as relic. A React + Vite single-page
site for the Voidcaller project: the self-titled EP minted on Avalanche, a
forthcoming "Tunnel Vision" EP, and a relic reliquary backed by on-chain
ownership.

## Stack

- **React 19** + **React Router 7**, built with **Vite 8**.
- **Dependency-free web3 layer** (`src/lib/web3.js`) — raw `provider.request()`
  + hand-rolled ABI encoding for ERC-1155 ownership reads and transfers. No
  ethers/viem on the client.
- Inline-style components in the band aesthetic (black / bone / crimson);
  design tokens live in `src/styles/colors_and_type.css`.

## Commands

```bash
npm run dev      # local dev server
npm run build    # production build to dist/
npm run preview  # preview the production build
npm run lint     # eslint (zero-tolerance; enforced in CI)
npm test         # vitest unit tests
```

CI (`.github/workflows/ci.yml`) runs **lint + test + build** on every PR and
on pushes to `main`. All three are required to pass.

## Architecture

| Area | Where | Notes |
|------|-------|-------|
| Routing / shell | `src/App.jsx`, `src/components/Layout.jsx` | Persistent Nav / Footer / sticky player; route sections are `React.lazy`-split behind a Suspense boundary. |
| Wallet | `src/lib/WalletContext.jsx`, `src/lib/wallet-context.js` | EIP-6963 + legacy detection, ownership reads, listener lifecycle. The context object + `useWallet` hook live in their own module for fast-refresh. |
| On-chain | `src/lib/web3.js` | Contracts/chains, `balanceOf` ownership, `safeTransferFrom`, receipt polling, IPFS helpers. |
| Audio | `src/lib/audio.js` | Module-singleton player mirrored into React via `useAudio()`; resolves preview-vs-full source per track ownership. |
| Content | `src/data.js` | Releases, tracklists, presale terms. The `$VOID` presale section is hidden behind the `VOID_LIVE` flag. |

## Deployment

Deployed on Vercel. `vercel.json` rewrites all paths to `index.html` (SPA) and
sets long-lived immutable `Cache-Control` on `/assets` and `/fonts`.

## Known limitation — audio gating is client-side only

Released-EP tracks are meant to be **owner-gated**: bearers of the relic hear
the full song, everyone else hears a 30-second preview. That gating is resolved
**entirely in the browser** (`src/lib/audio.js`) against the connected wallet's
on-chain balances.

The full-length audio files are served as **public static assets** under
`public/assets/audio/`. Anyone can therefore download a full track by hitting
its URL directly, without owning the relic — the gate is a UX convenience, not
an access control.

Making the gate real requires serving full audio from behind an
ownership-verifying endpoint (a serverless function that checks a signed wallet
message + on-chain balance, then streams the file or returns a short-lived
signed URL) and removing the full tracks from the public directory. This is
intentionally deferred; preview clips and all other functionality work as-is.
