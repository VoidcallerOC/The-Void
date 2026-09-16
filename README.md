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
npm run db:validate # validates migration inventory and transaction structure
npm run db:migrate  # applies migrations; requires a configured PostgreSQL service
```

CI (`.github/workflows/ci.yml`) runs **lint + test + build** on every PR and
on pushes to `main`. All three are required to pass.

## Architecture

| Area | Where | Notes |
|------|-------|-------|
| Routing / shell | `src/App.jsx`, `src/components/Layout.jsx` | Persistent Nav / Footer / sticky player; route sections are `React.lazy`-split behind a Suspense boundary. |
| Wallet | `src/lib/WalletContext.jsx`, `src/lib/wallet-context.js` | EIP-6963 + legacy detection, ownership reads, listener lifecycle. The context object + `useWallet` hook live in their own module for fast-refresh. |
| On-chain | `src/lib/web3.js` | Contracts/chains, `balanceOf` ownership, `safeTransferFrom`, receipt polling, IPFS helpers. |
| Audio | `src/lib/audio.js` | Module-singleton player mirrored into React via `useAudio()`; plays public previews by default and resolves bearer media only through an opaque API grant. |
| Content | `src/data.js` | Releases, tracklists, presale terms. The `$VOID` presale section is hidden behind the `VOID_LIVE` flag. |

## Deployment

`vercel.json` supports the static SPA deployment by rewriting site routes to
`index.html` and setting immutable `Cache-Control` on `/assets` and `/fonts`.
It does **not** deploy `server/index.js` or `server/indexer-worker.js`. The
production API, PostgreSQL database, persistent indexer, private object store,
and signer service must be deployed separately before the platform can operate
as an authenticated marketplace or media service. See
[`LAUNCH-GATE.md`](./LAUNCH-GATE.md) for the verified scope and exact remaining
deployment actions.

## Protected media architecture

All full-duration masters are no longer public static assets. The only public
audio files are the 27–30 second preview clips under
`public/assets/audio-preview/`. The player requests `POST /api/media/grants`
only after wallet authentication. The server then verifies current confirmed
ownership and the published experience entitlement before creating an opaque,
wallet-bound, short-lived grant. The player receives `/api/media/<grant-id>`
rather than a master filename.

The gateway validates grant expiry and revocation before it opens private
storage. Development can use a filesystem root outside `public/`. Production
requires the provider-neutral object-storage signer configuration documented in
`.env.example`; the signer must return a short-lived HTTPS URL from an approved
host. No production object store or signing service is configured by this
repository alone.
