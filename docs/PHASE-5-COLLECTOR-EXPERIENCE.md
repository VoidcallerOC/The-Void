# Phase 5 — Collector Experience

## Collector architecture

The collector surface is now **My Collection**, rather than a wallet inventory. The catalog is represented by artist, release, edition, token, collection, and experience records in `src/domain/models.js` and `src/data.js`. `src/lib/collection.js` converts generalized ownership records into a collector library containing artists, releases, editions, quantities, and available experiences. Voidcaller is represented through the same catalog path as every future artist.

Each ownership record contains `wallet`, `contract`, `tokenId`, `amount`, `chain`, and `updatedAt`. Contract and chain are part of the matching key, so balances from different ERC-1155 contracts or chains are not conflated. The transfer modal accepts the owned contract and a bounded quantity, then refreshes ownership after a confirmed transaction.

## Indexing architecture

`src/lib/web3.js` provides a source-of-truth fallback reader that queries ERC-1155 `balanceOf` for configured chains and token IDs. It exposes both the legacy set-based result used by Voidcaller identity logic and the generalized `checkCollectionOwnershipRecords` result used by My Collection. A production indexer should ingest `TransferSingle` and `TransferBatch` events, maintain current balances keyed by `(wallet, chain, contract, tokenId)`, and expose an API with an `updatedAt` watermark. The browser reader remains a safe fallback and is intentionally configuration-driven rather than hardcoded into collection UI.

The index is an optimization and discovery layer; ownership must be rechecked against the chain before granting protected experiences or finalizing sensitive actions. Purchased assets enter the collection when the indexed balance or fallback chain read reflects the settlement transfer. Transfers are reflected after the post-confirmation ownership refresh.

## Media protection architecture

`src/lib/media-auth.js` defines the client/server contract: a wallet-bound challenge includes an experience ID and nonce, the server verifies the signature and current ownership, and the server returns an opaque, short-lived grant. Protected media is requested through `/media/:grantId`; the client never needs a permanent master-file path. `MEDIA_AUTH_TTL_SECONDS` defaults to five minutes and grants must be rejected after `expiresAt`.

The current repository still serves preview audio from the frontend for the public listening experience. Full masters must be moved behind a server or storage edge that performs signature verification, current ownership verification, expiry checks, rate limiting, and one-time or tightly scoped grant validation before Phase 6 production media rollout.

## Validation

Automated coverage is provided in `src/lib/collection.test.js`, `src/lib/media-auth.test.js`, `src/lib/marketplace.test.js`, `src/lib/web3.test.js`, and the existing audio tests. It covers one and multiple editions, multiple contracts/chains, quantities and merge behavior, token-gated access and denial, media grant expiry, quantity-aware purchases, transfer encodings, Voidcaller catalog resolution, and the existing wallet helpers. Manual browser validation remains necessary for wallet disconnect/reconnect, real purchase settlement, and real transfer confirmation because those require an injected provider.

## Files changed

| Area | Files |
|---|---|
| Generalized ownership/indexing | `src/lib/collection.js`, `src/lib/web3.js`, `src/lib/WalletContext.jsx` |
| Collector UI | `src/components/Reliquary.jsx`, `src/components/TransferModal.jsx` |
| Marketplace quantity correctness | `src/lib/marketplace.js`, `contracts/MusicMarketplace.sol` (existing contract source) |
| Media boundary | `src/lib/media-auth.js` |
| Tests | `src/lib/collection.test.js`, `src/lib/media-auth.test.js`, existing marketplace/web3 tests |

## Security findings

The on-chain marketplace contract uses approval checks, balance checks, exact native payment, reentrancy protection, partial quantity settlement, royalty bounds, and post-settlement events. The browser must not be treated as an authorization boundary: set-based UI ownership is advisory, and protected media requires the server verification flow described above. The current fallback RPC reader can be unavailable or stale and therefore must not be used alone for server authorization. Public preview assets are acceptable; master assets are not protected until deployed behind the grant endpoint.

## Remaining limitations

The repository contains a client-side fallback indexer, not a hosted event indexer or authenticated media service. The catalog currently contains Voidcaller only, although its model and UI are multi-artist and multi-contract capable. Release and edition navigation is represented in the collector records but still needs dedicated routed detail pages. Experience authorization is modeled and tested locally; server-side signature verification, grant revocation, and audit logging remain deployment work.

## Phase 6 prerequisites

Phase 6 should provide the ownership-event indexer and API, production media gateway with wallet-signature verification, persistent catalog and experience administration, routed release/edition pages, end-to-end wallet tests on a fork or testnet, and operational monitoring for stale indexing, grant abuse, and marketplace settlement failures.
