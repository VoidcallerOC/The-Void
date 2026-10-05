# Release-Per-Contract Implementation

**Repository:** `VoidcallerOC/The-Void`
**Scope:** implementation of a new, additive release-per-contract path for future releases.
**Deployment status:** **no contracts were deployed, no network configuration was changed, and no legacy data was migrated.**

## Decision implemented

Every newly deployed release is represented by an independent on-chain tuple:

> `(chainId, release ERC-1155 contract, dedicated primary sale, provenance anchor, tokenId)`

The release contract address is now part of the canonical identity. A numeric token ID alone is intentionally insufficient because the same edition ID may produce the same token ID in two isolated release contracts.

Legacy shared-contract releases remain on their existing paths.

## On-chain components

| Component | Purpose | Isolation guarantee |
|---|---|---|
| `VoidRelease1155V4` | Versioned, cloneable ERC-1155 implementation | Each clone has independent balances, approvals, roles, supply, metadata, royalties, and pause state. |
| `VoidReleaseFactory` | Controlled factory and immutable registry | One `releaseKey` maps to one release clone, primary sale, and provenance anchor. The factory is not an admin/issuer on resulting clones. |
| `VoidPrimarySale` per release | Primary purchase contract | Constructor permanently targets one release clone; sale A cannot mint into release B. Sale ownership transfers to the configured Safe/owner at creation. |
| `VoidProvenanceAnchor` per release | Provenance anchor | Bound to only the release clone created with it. |
| `ReleaseMarketplaceV3` | Future resale marketplace path | Accepts only `isRelease` contracts registered by `VoidReleaseFactory`; it deliberately has no shared canonical-token exception. |

### Clone initialization and authority

- `VoidRelease1155V4.initializeRelease` requires a non-zero release key and is callable only through the inherited factory initialization guard.
- The artist owns and administers only the clone for that release.
- The artist does **not** retain the issuer role; only the release’s dedicated primary sale receives it.
- The factory records the deployment but receives no role on the clone after initialization.
- A clone rejects a foreign release key while creating an edition.

## Persistence and Studio workflow

Migration `034_release_contracts.sql` adds two additive tables:

| Table | Role |
|---|---|
| `factory_releases` | Durable indexer registry for canonical `ReleaseCreated` event tuples. This supports restart/replay before an application record is attached. |
| `release_contracts` | Immutable Studio binding from an application release to its chain, release contract, primary sale, anchor, implementation version, and release key. |

The Studio endpoint `POST /api/studio/releases/:releaseId/contract` binds a draft release only after confirming that the exact contract tuple was indexed from the configured release factory and belongs to the authenticated artist. It does **not** accept arbitrary browser-provided contract addresses.

Once bound, new Studio editions use the bound contract and release-clone token-ID derivation. Publication confirmation validates `EditionCreated` against that exact bound contract, rather than the legacy Fuji singleton.

## Indexer behavior

`RELEASE_FACTORY` is a first-class indexer contract type. On a valid `ReleaseCreated` event the indexer:

1. persists the immutable factory-event tuple;
2. adds the dedicated `PRIMARY_SALE` to indexing at its creation block;
3. adds the release ERC-1155 clone to indexing at its creation block; and
4. reloads both release and sale contracts after restart from `factory_releases`.

The dedicated sale is added before its release clone so sale-mint transfers are treated as primary-sale mint activity rather than a generic transfer.

## Public catalog, Collect, and media entitlement

- Public edition API records now expose `primary_sale_address` for a verified bound release contract.
- Catalog mapping preserves the sale address as `edition.primarySaleAddress`.
- `CollectPanel` uses the release tuple for non-legacy releases: it reads balance, pause state, sale configuration, simulates purchase, and sends the purchase transaction only to that edition’s dedicated primary sale.
- The existing legacy Fuji route is retained unchanged for legacy/certified editions.
- Protected-media setup now rejects requirements that point at another release contract even when that contract has the same numeric token ID and belongs to the same artist. It enforces the exact `(chainId, contract, tokenId)` tuple of the experience’s edition.

## Regression and isolation coverage

### Solidity

`VoidReleaseFactoryTest` verifies:

- two releases by the same artist produce distinct contract, sale, and anchor addresses;
- identical edition IDs may share a numeric token ID while balances, supply, and pause state remain isolated;
- foreign release keys and unauthorized mutation fail;
- sale A cannot sell/mint release B; and
- a key cannot be rebound or a clone reinitialized.

`ReleaseMarketplaceV3Test` verifies that settlement transfers only the listed release contract and rejects an unregistered ERC-1155 contract.

### Application

Tests cover:

- decoding, persistence, restart discovery, and dedicated sale indexing from `ReleaseCreated`;
- immutable release-contract repository bindings;
- Studio binding only from an indexed factory event;
- release-aware primary-sale reads and sends with identical numeric token IDs; and
- release-bound protected-media requirements.

## Operational follow-up before activating the new path

1. Deploy and verify `VoidReleaseFactory`, `ReleaseMarketplaceV3`, and the `VoidRelease1155V4` implementation through the approved Safe process.
2. Configure the real factory as `RELEASE_FACTORY` in the indexer, including a finalized start block.
3. Apply migration `034_release_contracts.sql`.
4. Create a controlled release deployment service/Safe flow that calls `createRelease`, then wait for indexed confirmation before using the Studio contract-binding endpoint.
5. Run a Fuji rehearsal with two different releases using the same edition ID, then test purchase, resale, ownership snapshots, and protected media on both.
6. Keep legacy shared-contract records and flows in place; do not backfill them into `release_contracts`.
