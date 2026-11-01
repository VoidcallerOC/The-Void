# Corrected factory: automatic 2.5% platform settlement on primary sales

Status: **repository change only. Nothing in this document is deployed or activated.** No transaction was sent, no
contract deployed, and no production configuration changed. Every "fork" result below is a local simulation of mainnet
state, not an event on mainnet.

## 1. Production state (chain 43114)

| Item | Address | Evidence |
|---|---|---|
| Production factory `VoidReleaseFactoryV2Royalty` | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `deployments/release-per-contract-mainnet-0x262B…json` (block 97619965); `factory.primarySaleOf(release)` read live |
| Forgive & Forget release (EIP-1167 clone) | `0x9Aa6165B493ac50d0f8CDee2FD48a3C5155FD103` | `factory.isRelease` true, read live |
| Release implementation | `0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006` | deployment record |
| Its primary sale `VoidPrimarySale` | `0x6ae84A51F100f10f0535A514555043ae9eDf9aA3` | live: `releases()` = release; `platformRecipient()` = `0xb65C…`; fee 250 bps; owner = factory |
| Marketplace `ReleaseMarketplaceV4` | `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` | live: `registry()` = production factory (immutable) |
| Platform recipient | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` | manifest, factory, sale, marketplace all agree |
| Artist / payout | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | live `payoutOf`, `royaltyInfo` |
| Genesis collection (separate, not factory-made) | `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` | live; royalty 500 bps; `isRelease` false |

Frontend, API and indexer read the same manifest (`config/mainnet-release-per-contract.json`). The indexer's live log shows
chain 43114 with the factory, marketplace, sale (token address = release) and release.

## 2. What executes each responsibility

```
artist --createRelease--> Factory --clones--> Release (ERC-1155, royalty 250 bps locked)
                              |--new--------> Primary sale (ISSUER_ROLE on the release)
                              |--new--------> Provenance anchor
buyer  --purchase{value}--> Primary sale --mint--> Release
secondary: seller --createListing--> Marketplace(registry = Factory) --buy--> Release transfer + 95/2.5/2.5
```

- The **sale** decides primary payment distribution. In production it is `VoidPrimarySale`, which credits
  `balances[platformRecipient]` and `balances[payout]` and sends nothing (`VoidPrimarySale.sol:186-193`). `withdraw()` pays
  only `msg.sender`. It is immutable, so the platform share cannot be pushed from the existing sale.
- The **factory** decides which sale each new release gets (`new VoidPrimarySale(...)` in `_deployInfrastructure`, private).
  A factory-only change is therefore sufficient for **future** releases, with no new release implementation: the same
  `VoidRelease1155V4Royalty` clone is used and the sale only needs `mint`, `payoutOf`, `artistOf`, `maxSupplyOf`.
- The **marketplace** accepts only releases its immutable `registry` (a factory) recognises. Releases from a new factory
  therefore also need a `ReleaseMarketplaceV4` constructed with the new factory's address. Proven on a fork: the production
  marketplace reverts `UnsupportedRelease` for such a release; a matching marketplace accepts it.
- **Genesis** is a separate collection and is not factory-registered, so it is outside both. Its claim contract only reads
  `sales(tokenId)` from the sale, which has the same struct in the settled sale.

## 3. The change

`contracts/VoidReleaseFactoryV2RoyaltySettled.sol` is `VoidReleaseFactoryV2Royalty` with one change: each release's sale is
`VoidPrimarySaleSettled` (platform share pushed inside `purchase()`, whole purchase reverts if that transfer fails; artist
97.5% stays a pull balance). Everything else (ownerless, release keys, events, `RELEASE_VERSION`, royalty lock, provenance
anchor) is the same. The source of the production factory and sale is unchanged.

Not changed: the existing Forgive & Forget release, factory, sale, marketplace, Genesis, or any manifest/configuration.

## 4. Tests

- `test/VoidReleaseFactorySettled.t.sol` (local EVM, 10 tests): wiring and registry; same release rules and version as the
  production factory; royalty lock; exactly 2.5% reaches the platform wallet during the purchase and 97.5% is credited;
  only the artist can claim; rounding at 1, 39, 40, 41 wei and odd values sums exactly; a rejecting platform wallet reverts the
  purchase with no mint, credit, sold count or escrow; wrong payment; 95/2.5/2.5 resale on the matching marketplace; the
  production marketplace refuses the new release.
- `test/VoidReleaseFactorySettledFork.t.sol` (2 fork tests, skipped without `MAINNET_FORK_URL`): a replacement release from a
  factory that exists only on the fork pays the real platform wallet 0.00625 AVAX on a 0.25 AVAX purchase; the existing
  release, its factory registry, original sale credits, metadata, holder balances and Genesis balances are unchanged; the
  production marketplace refuses the new release.
- Reentrancy into the platform recipient is covered by `VoidPrimarySaleSettled.t.sol`
  (`testReenteringPlatformIsBlockedAndOuterPurchaseCompletesOnce`).

## 5. Original release

Forgive & Forget cannot be modified, and nothing here touches it. It has no on-chain function to pause or retire it except the
artist's `configureSale` pause on its own sale (which also ended it: the sale is sold out and expired). Retirement from the
active interface is an application-level archive of the catalog entry, as `server/migrations/030_archive_forgive_forget_18.sql`
did for an earlier duplicate; the contract address and token stay in history. Do not burn or transfer the token.

## 6. Replacement release (not started)

Requires, in order, each needing explicit owner authorization and a human signer:
1. Deploy `VoidReleaseFactoryV2RoyaltySettled(0xb65C…1ce4)`.
2. Deploy `ReleaseMarketplaceV4(0xb65C…1ce4, 250, <new factory>)`.
3. Update the mainnet manifest and indexer configuration to the new factory and marketplace (production change).
4. The artist creates the replacement release from the new factory, then the edition and sale.
5. Verify on chain with the same checks as the fork tests, then re-upload the same artwork and audio.

Not rollbackable on chain: deployed contracts, created releases and any purchase. Rollback means not activating (keep the old
manifest) and, if sales began, the artist pausing the sale with `configureSale(..., paused = true)`.

## 7. Limits

- The 0.00625 AVAX platform credit already held in the original sale can only be moved by the platform wallet calling
  `withdraw()` itself.
- A release admin (the artist) can authorize another minter and bypass the primary fee; that is detectable, not preventable.
- Genesis resale inside The Void still needs a marketplace built for Genesis (`LegacyCollectionMarketplace`, not deployed).
