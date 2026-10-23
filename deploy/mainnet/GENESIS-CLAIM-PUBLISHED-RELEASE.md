# Deploying the Genesis claim against an already-published release

Read-only reference. It changes nothing on chain and nothing in production. It lists what
`contracts/GenesisHolderClaim.sol` and `scripts/deploy-genesis-claim.mjs` require of a release, edition
and sale that the artist has already published, so a mismatch is found before anyone signs.
Covered by `test/GenesisHolderClaimSettledSingle.t.sol` (VoidReleaseFactoryV2RoyaltySettled clone,
VoidPrimarySaleSettled, GenesisHolderClaim, chain id 43114), `test/GenesisHolderClaimHalloweenSchedule.t.sol`
(the sequential release and the Halloween schedule below) and, against the live sequential release,
`test/GenesisHolderClaimSequentialMainnetFork.t.sol` (fork only; set `MAINNET_FORK_RPC`).

## Mainnet schedule policy

The free claim and the paid sale open together at `claimStart`. Claims close exactly 24 hours later
(`claimEnd = claimStart + 86400`); the paid sale stays open through `publicSaleEnd = claimStart + publicWindow - 1`
(inclusive). On chain 43114 the contract, the deploy script and the API all require:

- claim window exactly 86400 s and public price exactly 0.25 AVAX;
- public window in whole hours (a multiple of 3600 s), at least 604800 s (7 days) and at most 1209600 s (14 days).

Whole hours mean a sale opening on the hour ends at :59:59; a window one second short or long is refused.
The mainnet plan names the sale's inclusive end explicitly (`GENESIS_PUBLIC_SALE_END`, workflow input
`public_sale_end`) and derives the window from it; the API takes the same window as
`GENESIS_PUBLIC_WINDOW_SECONDS` and refuses to serve vouchers if it differs from the deployed claim.

Forgive & Forget launch (token 1 on `0xF0C091A159DE16cF0F306b2B61d37685EC5A830e`, sale
`0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845`):

| | America/New_York | UTC | Unix |
|---|---|---|---|
| Claim and paid sale open (`claimStart`, sale `startTime`) | Fri Oct 23, 2026 8:00:00 PM EDT | 2026-10-24 00:00:00 | 1792800000 |
| Claim closes (first refused second, `claimEnd`) | Sat Oct 24, 2026 8:00:00 PM EDT | 2026-10-25 00:00:00 | 1792886400 |
| Paid sale's last second (`publicSaleEnd`, sale `endTime`) | Sat Oct 31, 2026 11:59:59 PM EDT | 2026-11-01 03:59:59 | 1793505599 |

`publicWindow` = 705600 s (8 days 4 hours). US DST ends Nov 1, 2026 at 2:00 AM local, after the sale ends.
Sale: `configureSale(1, 250000000000000000, 0, 3, 1792800000, 1793505599, false)` (uncapped, 3 paid per wallet).
These timestamps live in the deployment plan and here only, never in application code.

## What the constructor reads (it reverts on any mismatch)

| # | Requirement | Revert |
|---|---|---|
| 1 | Chain is 43113 or 43114; on 43114 the claim window is exactly 86400 s, the public window is whole hours from 604800 s to 1209600 s, and the price is exactly 0.25 AVAX | `InvalidConfiguration` |
| 2 | `claimStart >= block.timestamp` at mining time | `InvalidConfiguration` |
| 3 | The token exists on the release (`maxSupplyOf`, `edition`) | revert from the release |
| 4 | Open edition: both allocations 0. A capped edition needs finite, non-overlapping allocations | `InvalidConfiguration` |
| 5 | The sale is configured and its `maxSupply` equals `publicAllocation` (0 = uncapped) | `PublicAllocationChanged` |
| 6 | Sale `startTime == claimStart` and `endTime == claimStart + publicWindow - 1` | `PublicSaleSchedule` |
| 7 | Sale `priceWei == 0.25 AVAX` | `PublicPriceChanged` |
| 8 | Release `mintedSupply == sale.sold + claimedSupply`: no mint outside the sale | `SupplyAccountingMismatch` |

`claim()` repeats checks 5-8 on every call, so a later `configureSale` or an outside issuer mint makes
claims fail closed; restoring the sale makes them work again. The contract does not check the sale's
`perWalletLimit` or `paused`; a free claim mints through the release, not the sale, so it never counts
against the paid per-wallet limit, and a claimant can still buy up to the limit.

## What the deploy script adds (`npm run deploy:genesis-claim`, plan only on mainnet)

- The release and sale are real contracts on the chain, the sale's `releases()` is this release.
- Open edition (`GENESIS_EXPECT_OPEN_EDITION=yes`, the default): `maxSupplyOf(token) == 0`.
- The edition's `mintEndOf(token)` is `0` or exactly `publicSaleEnd`. The mint end is fixed when
  the edition is created and cannot be changed afterwards; a mint end before the sale end would refuse the
  late purchases (`MintingEnded`) whatever the sale says. Live token 1 has `mintEndOf(1) == 0`.
- On mainnet `GENESIS_PUBLIC_SALE_END` is required and must give a policy window from `claimStart`; if
  `GENESIS_PUBLIC_WINDOW_SECONDS` is also set it must agree.
- The sale is not paused, and with `GENESIS_EXPECT_PER_WALLET_LIMIT` set (the mainnet workflow requires it)
  its `perWalletLimit` equals that value.
- `claimStart` is at least 600 s after the latest block when the plan is made.
- The constructor is simulated with `eth_call` before the plan is written; the artist wallet must hold
  `DEFAULT_ADMIN_ROLE` on the release for the `grantRole(ISSUER_ROLE, claim)` follow-up.
- Roles stay separate: the claim admin and voucher signer are not the fee recipient, the deployer, or the
  artist (signer), and the signer is a dedicated key.

## Checking an already-published release (read-only)

1. Edition: `maxSupplyOf`, `edition(token).mintedSupply`, `mintEndOf(token)`.
2. Sale: `sales(token)` price, `maxSupply`, `sold`, `startTime`, `endTime`; `releases()`.
3. `release.hasRole(DEFAULT_ADMIN_ROLE, artist)` and that the claim does not yet hold `ISSUER_ROLE`.
4. Pick `claimStart` from the sale: it must equal the sale's `startTime`, and `endTime - startTime + 1` must
   be a policy window (whole hours, 7 to 14 days). `claimStart` must still be in the future when the
   deployment is mined.

## Mismatch and minimum safe correction

| Found | Minimum safe correction |
|---|---|
| Sale price, cap, start or end differ | The artist calls `configureSale` again (the sale is not part of the release's immutable edition data). No new contract. |
| Sale already started (`startTime` in the past) | The claim cannot bind: the constructor needs `claimStart >= now` and `startTime == claimStart`. Moving `startTime` into the future is a sale change for the artist to decide; otherwise the free claim cannot use this sale. |
| Edition mint end is neither 0 nor the sale's `endTime` | Choose the claim schedule from the edition's mint end only if it still leaves `claimStart` in the future; otherwise the claim cannot bind to this edition. |
| Edition is capped (`maxSupply != 0`) | The claim needs matching finite allocations; an open edition needs none. A capped edition cannot be made open. |
| `mintedSupply != sold` (a mint outside the sale) | None for that edition: accounting would fail on every claim. |
| Edition does not exist yet | Create it first; the claim is deployed last. |

None of these corrections is applied by this repository; each is the artist's or the owner's decision.
