# Marketplace compatibility audit: Genesis + corrected-factory collections (2026-10-21)

STATUS: PARTIAL. Root cause identified and proven (source, tests, live read-only calls). Repository change is tests and
this note only. No contract, manifest, env or production change. Nothing deployed or broadcast.

## 1. Root cause (exact)

`contracts/ReleaseMarketplaceV4.sol`:
- `registry` is `immutable`, set once in the constructor from `releaseFactory_`.
- `createListing`, `cancelListing`, `expireListing` and `buy` all call
  `_requireSupportedRelease(tokenContract)` → `if (!registry.isRelease(tokenContract)) revert UnsupportedRelease();`

`registry.isRelease` is the factory's own `mapping(address => bool) isRelease`. It is written only inside that factory's
`_createRelease` (`contracts/VoidReleaseFactoryV2.sol:95`). The factory is ownerless and has no register function.
The marketplace has no owner and no setter.

So: deployed marketplace `0x0e77…F8f5` accepts exactly the releases created by factory `0x262B…757b`. A release created
by `VoidReleaseFactoryV2RoyaltySettled` is registered only in the corrected factory's mapping, so every marketplace call
on it reverts `UnsupportedRelease`. Cause: an immutable registry, not owner configuration, not an interface mismatch.

Live, read-only (block 98102374, `api.avax.network`):

| Read | Result |
|---|---|
| `marketplace.registry()` | `0x262B774cf9a1949170B58E2d57F6189980FE757b` |
| `marketplace.platformFeeBps()` / `feeRecipient()` / `deploymentChainId()` | 250 / `0xb65C…1ce4` / 43114 |
| `marketplace.nextListingId()` | 1 (no listing ever created) |
| `marketplace.owner()`, `factory.owner()` | revert (no such function) |
| `factory.isRelease(F&F 0x9aa6…d103)` / `isRelease(Genesis)` | true / false |
| `factory.releaseCount()` | 1 |
| Live runtime code vs `forge build` of `ReleaseMarketplaceV4` (immutables and metadata masked) | identical, 6530 bytes |

## 2. Genesis

Genesis `0xD1B4…98eE` is not a factory release. It has never been listable on any The Void marketplace:
`factory.isRelease(Genesis) = false` and it has no `royaltyBpsOf`/`payoutOf` (see `GENESIS-RESALE-ROOT-CAUSE.md`).
Its in-app resale path is `LegacyCollectionMarketplace` (`config/legacy-collection-marketplace.json`, `deployed: false`).
Genesis claims go through `GenesisHolderClaim` and the F&F sale, which nothing here touches.

What could break Genesis: nothing in the fix below touches a Genesis contract, its royalty, the claim contract, or the
legacy-marketplace manifest. Frontend routing for Genesis is unchanged (tested).

## 3. Smallest fix

There are two in-repo designs, and they are mutually exclusive in what they deploy:

| Path | Deployments | Marketplace deployment? |
|---|---|---|
| A. Settled sale on releases from the **existing** factory (PR #231, `PAYMENT-FIX-ACTIVATION.md`) | one `VoidPrimarySaleSettled` per release + artist role swap | **No.** Releases stay in `0x262B…`'s registry; `0x0e77…` accepts them. |
| B. **Corrected factory** (PR #234, `FACTORY-FEE-FIX.md`) | `VoidReleaseFactoryV2RoyaltySettled` + one `ReleaseMarketplaceV4(feeRecipient, 250, <new factory>)` | **Yes, unavoidable** (section 1). No new contract code; the existing, byte-verified `ReleaseMarketplaceV4` source. |

For path B (what the mission asks to support), the application layer is **already multi-deployment**:
- `config/release-network.js` `manifestDeployments`: active `{factory, marketplace}` + `historicalDeployments[]`.
- `src/lib/marketplace.js` `marketplaceConfigForEdition`: each edition trades on the marketplace of its own `factoryAddress`.
- `server/config.js` `withManifestReleaseDeployments`: the indexer indexes every recorded factory and marketplace.
- `server/indexer.js` registers each `ReleaseCreated` release per factory address.

So once both contracts exist, the only app change is the mainnet manifest: new factory/marketplace active, the current
pair moved verbatim into `historicalDeployments`. A multi-registry marketplace was considered and rejected: it is new
unaudited code and still needs a deployment, while existing listings and the frontend already route per factory.

## 4. Deployment requirement

- Path B: **YES** (new factory + one new `ReleaseMarketplaceV4` instance). Evidence: section 1.
- Path A: **NO** marketplace deployment (per-release sale deployment instead).

## 5. Contract impact

No Genesis contract change. No existing address changes. `0x262B…`, `0x0e77…`, F&F release/sale stay live and keep
trading on their own marketplace (historical entry).

## 6. Tests added

- `test/MarketplaceMultiCollectionCompatibility.t.sol` (7, local EVM): production-factory release still lists/resells on
  the production marketplace; corrected marketplace refuses it; production marketplace refuses a corrected release
  because `registry` is the production factory; two corrected releases at different addresses both list, sell and pay
  their own artists, listings carry the right `tokenContract`; a Genesis-like ERC-2981 collection is refused by both;
  a clone from a same-bytecode look-alike factory is refused; primary 2.5% pushed once at purchase, 97.5% claimable,
  resale charges only 2.5% fee + 2.5% royalty and does not touch the primary sale.
- `src/lib/release-deployments-corrected-factory.test.js` (4): with a hypothetical manifest (corrected factory active,
  production historical), both pairs are kept, each edition routes to its factory's marketplace whichever marketplace is
  configured, Genesis gets no factory routing, the indexer includes both factories and marketplaces.

Existing coverage reused: `VoidReleaseFactorySettled.t.sol` (failed platform transfer reverts atomically, rounding,
artist-only claim), `VoidReleaseFactorySettledFork.t.sol` and Genesis fork tests (need fork RPC; skipped here).

## 7. Risks and rollback

- New marketplace starts with `nextListingId = 1`; listing IDs are per marketplace. The API keys listings by marketplace
  address (`api-service.js` `MARKETPLACE_MISMATCH` checks), so no collision. `VITE_MARKETPLACE_ADDRESS` must be one of the
  recorded marketplaces or factory routing is skipped (`marketplaceConfigForEdition`).
- The indexer must start at the new contracts' deployment blocks; wrong blocks miss events.
- Old factory stays callable on chain (ownerless); the app stops using it only through the manifest.
- Rollback before sales: revert the manifest commit. After deployment the contracts cannot be removed; after sales the
  artist pauses via `configureSale(..., paused = true)`.
