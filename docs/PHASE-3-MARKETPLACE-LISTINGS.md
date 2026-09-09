# Phase 3 — Marketplace Listings

## Completion status

Phase 3 is implemented as a **non-custodial, approval-based ERC-1155 listing flow**. Owners retain their editions in their wallets. The application presents the music-native path **Artist → Release → Edition → Collect** and does not expose token IDs as the primary product concept.

No production contract has been deployed or enabled. `MARKETPLACE_CONFIG.enabled` remains `false` until a reviewed test-network deployment is configured.

## Contract architecture

`MusicMarketplace.sol` accepts arbitrary compatible ERC-1155 token contracts. A seller must be the transaction sender, own the requested quantity, and approve the marketplace with `setApprovalForAll` before creating a listing. The marketplace never takes custody during listing creation; it uses the seller’s approval only when a purchase executes.

Listings support native-currency unit pricing, partial fills, optional expiration, cancellation by the seller, explicit expiration, and terminal `SOLD`, `CANCELLED`, or `EXPIRED` states. Purchases validate the listing, quantity, exact `msg.value`, seller balance, and current approval before transferring tokens. State is updated before the external token transfer and payment calls, and a reentrancy guard protects settlement.

When the token contract implements ERC-2981, the marketplace calls `royaltyInfo` and pays the returned receiver if the royalty is within the remaining sale proceeds. Unsupported or reverting royalty interfaces result in no royalty payment. Platform fee configuration is centralized in the immutable constructor parameters rather than duplicated in the frontend.

The contract emits `ListingCreated`, `ListingCancelled`, `ListingExpired`, and `ListingSold` events. The frontend and future indexer use these events as the authoritative listing lifecycle signals.

## Contract files

| File | Purpose |
|---|---|
| `contracts/MusicMarketplace.sol` | Arbitrary ERC-1155, approval-based, native-currency marketplace contract. |
| `src/lib/marketplace.js` | ABI encoding, validation, receipt verification, listing lifecycle model, and wallet transaction helpers. |
| `src/lib/marketplace.test.js` | Listing validation, multi-unit pricing, ABI selector regression, event-topic decoding, receipt verification, and lifecycle tests. |
| `server/repositories.js` | Durable listing and marketplace transaction persistence for the production API/indexer boundary. |
| `server/indexer.js` and related indexer modules | Durable event synchronization and projection infrastructure for deployed environments. |

## Frontend files

| File | Purpose |
|---|---|
| `src/components/ListingPanel.jsx` | Edition-page owner flow: wallet, approval, listing, active state, and seller cancellation. |
| `src/components/PlatformPages.jsx` | Places the listing panel on the relevant edition page while preserving the music-native catalog hierarchy. |
| `src/lib/web3.js` | Wallet provider, chain switching, address validation, and receipt waiting. |
| `src/domain/models.js` and `src/data.js` | Existing artist, release, edition, and experience catalog model preserved unchanged. |

The UI clearly separates the approval transaction from the listing transaction. It supports edition/token selection, quantity, native price in base units, and optional expiration. Currency is intentionally limited to native currency in this phase; no ERC-20 settlement UI is exposed.

## Security considerations

The contract validates seller identity, addresses, quantity, price, expiry, balance, approval, listing status, expiration, exact payment, and settlement state. It rejects purchases of cancelled, sold, or expired listings; prevents duplicate terminal transitions; uses checks-effects-interactions ordering; and guards settlement against reentrancy. Arbitrary ERC-1155 contracts are supported, so deployment review must include malicious token behavior and safe-transfer receiver tests.

ERC-2981 detection is not treated as royalty enforcement by itself. The contract actually transfers the bounded royalty amount during settlement. Royalty receivers, fee recipients, and sellers are paid with checked low-level calls, and any failed payment reverts the full settlement.

The current client ABI constants were verified against the Solidity contract. The purchase selector is `0xd6febde8`, and the `ListingCreated` event topic is `0xd805c12164ca2f60bbd92cc6343c957e7813dff1eb56a4c62519c3222cd6bd19`. Regression tests now guard against selector/topic drift.

## Tests and validation

The repository’s authoritative test command is:

```bash
npm test -- --reporter=dot
npm run lint
npm run build
```

The Phase 3 client tests cover valid multi-unit listings, invalid quantities and prices, unsupported currency, stale expiry, approval/listing/purchase encoding, exact event-topic listing ID extraction, cancelled and expired purchase rejection, partial purchases, settlement receipt verification, and all supported listing lifecycle transitions.

The contract was also compiled locally with Solidity `0.8.24` using `solcjs`. No production deployment was performed.

## Deployment and test-network status

| Environment | Status |
|---|---|
| Local compilation | Passed with Solidity `0.8.24`. |
| Local/test contract deployment | Not performed in this session; no Foundry/Hardhat harness is present in the repository. |
| Avalanche Fuji | Not deployed or configured. |
| Avalanche mainnet | Not deployed; marketplace remains disabled. |

Before Fuji deployment, add a Foundry or Hardhat test harness covering malicious ERC-1155 receivers, royalty bounds, fee accounting, approval races, balance changes, expiration, cancellation, duplicate purchases, exact payment, and reentrancy attempts. Verify source and bytecode, record the deployment block and address, and configure only a test-network environment first.

## Known limitations

1. Only native-currency settlement is supported. ERC-20 currencies, offers, auctions, bidding, and escrow are intentionally excluded.
2. The frontend currently displays the confirmed listing locally; production discovery must read indexed listings from the server rather than trusting browser state.
3. The marketplace address is intentionally empty and disabled until a reviewed test deployment exists.
4. Solidity tests and a local chain harness are still required for financial settlement assurance.
5. Cryptographic server authentication, finalized ownership reconciliation, RPC failover, and production transaction indexing remain Phase 8 infrastructure work.
6. Full-length protected media is outside Phase 3 and must not be exposed by the listing flow.

## Exact prerequisites for Phase 4

Phase 4 may begin only after the following are complete:

1. Deploy and verify `MusicMarketplace` on Avalanche Fuji with documented fee recipient and fee basis points.
2. Complete the contract test harness and adversarial settlement review.
3. Configure a test-only marketplace address and chain-specific environment variables without enabling mainnet.
4. Wire listing reads to the durable API/indexer and reconcile `ListingCreated`, `ListingCancelled`, `ListingExpired`, and `ListingSold` events.
5. Add end-to-end wallet tests for approval, create listing, cancel listing, stale balance, insufficient approval, and expiration.
6. Confirm that the existing Voidcaller collection, release, edition, experience, and wallet flows remain green.

Phase 4 should then implement purchase UX and server-side transaction reconciliation, not auctions or offers.
