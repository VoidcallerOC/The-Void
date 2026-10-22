# Deploying the Genesis claim against an already-published release

Read-only reference. It changes nothing on chain and nothing in production. It lists what
`contracts/GenesisHolderClaim.sol` and `scripts/deploy-genesis-claim.mjs` require of a release, edition
and sale that the artist has already published, so a mismatch is found before anyone signs.
Covered by `test/GenesisHolderClaimSettledSingle.t.sol` (VoidReleaseFactoryV2RoyaltySettled clone,
VoidPrimarySaleSettled, GenesisHolderClaim, chain id 43114).

## What the constructor reads (it reverts on any mismatch)

| # | Requirement | Revert |
|---|---|---|
| 1 | Chain is 43113 or 43114; on 43114 the windows are exactly 86400 s (claim) and 604800 s (public) at exactly 0.25 AVAX | `InvalidConfiguration` |
| 2 | `claimStart >= block.timestamp` at mining time | `InvalidConfiguration` |
| 3 | The token exists on the release (`maxSupplyOf`, `edition`) | revert from the release |
| 4 | Open edition: both allocations 0. A capped edition needs finite, non-overlapping allocations | `InvalidConfiguration` |
| 5 | The sale is configured and its `maxSupply` equals `publicAllocation` (0 = uncapped) | `PublicAllocationChanged` |
| 6 | Sale `startTime == claimStart` and `endTime == claimStart + 604800 - 1` | `PublicSaleSchedule` |
| 7 | Sale `priceWei == 0.25 AVAX` | `PublicPriceChanged` |
| 8 | Release `mintedSupply == sale.sold + claimedSupply`: no mint outside the sale | `SupplyAccountingMismatch` |

`claim()` repeats checks 5-8 on every call, so a later `configureSale` or an outside issuer mint makes
claims fail closed; restoring the sale makes them work again. Sale `perWalletLimit` and `paused` are not
checked; a free claim does not count against the limit.

## What the deploy script adds (`npm run deploy:genesis-claim`, plan only on mainnet)

- The release and sale are real contracts on the chain, the sale's `releases()` is this release.
- Open edition (`GENESIS_EXPECT_OPEN_EDITION=yes`, the default): `maxSupplyOf(token) == 0`.
- The edition's `mintEndOf(token)` is `0` or exactly `claimStart + 604800 - 1`. The mint end is fixed when
  the edition is created and cannot be changed afterwards.
- `claimStart` is at least 600 s after the latest block when the plan is made.
- The constructor is simulated with `eth_call` before the plan is written; the artist wallet must hold
  `DEFAULT_ADMIN_ROLE` on the release for the `grantRole(ISSUER_ROLE, claim)` follow-up.
- Roles stay separate: the claim admin and voucher signer are not the fee recipient, the deployer, or the
  artist (signer), and the signer is a dedicated key.

## Checking an already-published release (read-only)

1. Edition: `maxSupplyOf`, `edition(token).mintedSupply`, `mintEndOf(token)`.
2. Sale: `sales(token)` price, `maxSupply`, `sold`, `startTime`, `endTime`; `releases()`.
3. `release.hasRole(DEFAULT_ADMIN_ROLE, artist)` and that the claim does not yet hold `ISSUER_ROLE`.
4. Pick `claimStart` from the sale: it must equal the sale's `startTime`, and `endTime` must equal
   `startTime + 604799`. Both must still be in the future when the deployment is mined.

## Mismatch and minimum safe correction

| Found | Minimum safe correction |
|---|---|
| Sale price, cap, start or end differ | The artist calls `configureSale` again (the sale is not part of the release's immutable edition data). No new contract. |
| Sale already started (`startTime` in the past) | The claim cannot bind: the constructor needs `claimStart >= now` and `startTime == claimStart`. Moving `startTime` into the future is a sale change for the artist to decide; otherwise the free claim cannot use this sale. |
| Edition mint end is neither 0 nor `startTime + 604799` | Choose the claim schedule from the edition's mint end only if it still leaves `claimStart` in the future; otherwise the claim cannot bind to this edition. |
| Edition is capped (`maxSupply != 0`) | The claim needs matching finite allocations; an open edition needs none. A capped edition cannot be made open. |
| `mintedSupply != sold` (a mint outside the sale) | None for that edition: accounting would fail on every claim. |
| Edition does not exist yet | Create it first; the claim is deployed last. |

None of these corrections is applied by this repository; each is the artist's or the owner's decision.
