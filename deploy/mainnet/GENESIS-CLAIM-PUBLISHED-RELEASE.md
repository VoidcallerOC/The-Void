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

Forgive & Forget schedule as requested on 2026-10-23 (token 1 on `0xF0C091A159DE16cF0F306b2B61d37685EC5A830e`, sale
`0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845`). A claim can bind only to a start still in the future when it is
mined; the owner sets the final timestamps in the plan. These rows are a worked example of the policy:

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
| 3 | The token exists on the release (`maxSupplyOf`, `edition(token).exists`) | revert from the release / `InvalidConfiguration` |
| 3a | Release and sale are distinct contracts with code, neither is the Genesis collection, and the sale's `releases()` is the release | `InvalidConfiguration` |
| 3b | The voucher signer is not the claim admin; on 43114 the Genesis collection has code | `InvalidConfiguration` |
| 4 | Open edition: both allocations 0. A capped edition needs finite, non-overlapping allocations | `InvalidConfiguration` |
| 5 | The sale is configured and its `maxSupply` equals `publicAllocation` (0 = uncapped) | `PublicAllocationChanged` |
| 6 | Sale `startTime == claimStart` and `endTime == claimStart + publicWindow - 1` | `PublicSaleSchedule` |
| 7 | Sale `priceWei == 0.25 AVAX` | `PublicPriceChanged` |
| 8 | Release `mintedSupply == sale.sold + claimedSupply`: no mint outside the sale | `SupplyAccountingMismatch` |

`claim()` repeats checks 5-8 on every call, so a later `configureSale` or an outside issuer mint makes
claims fail closed; restoring the sale makes them work again.

## What every `claim()` checks, in order

1. Not paused (`Paused`); chain id is the deployment chain (`WrongDestinationChain`); `claimStart <= now < claimEnd`
   (`ClaimNotOpen`, `ClaimWindowClosed`); `voucher.deadline >= now` (`ExpiredVoucher`).
2. `voucher.claimant == msg.sender` and non-zero, and every bound field matches: Genesis contract and chain,
   `ELIGIBILITY_RULE`, destination chain, release, token, allocation, and `quantity == 1` (`InvalidVoucher`).
3. The wallet has not claimed (`AlreadyClaimed`) and the nonce is unused (`Replay`); a finite allocation is not
   exhausted (`AllocationExhausted`).
4. The sale and supply checks 5-8 above.
5. The EIP-712 signature (65 bytes, low-s, v 27/28) recovers to `signer` (`InvalidSignature`). The domain binds
   the chain id and this claim contract's address.
6. On 43114 the claimant holds at least one Genesis unit (IDs 0-3) right now, read from the real collection with
   `balanceOfBatch` (`NotGenesisHolder`); a failing read reverts the claim.
7. Effects (`hasClaimed`, `usedNonces`, `claimedSupply`), then `release.mint(claimant, token, 1)` through
   `ISSUER_ROLE`. `nonReentrant` blocks re-entry from the ERC-1155 receiver hook. Any mint failure (no
   `ISSUER_ROLE`, release paused, receiver refusing) reverts the whole claim, so nothing is consumed.

The claim takes no payment (non-payable, no `receive`), holds no funds and has no withdrawal. Paid copies go
only through `VoidPrimarySaleSettled.purchase`: 2.5% pushed to the platform recipient in the purchase, 97.5%
credited to the payout wallet and withdrawable only by it. A free claim never counts against the sale's
per-wallet limit, and a claimant can still buy up to that limit.

## Trust assumptions

- **Voucher signer (server key).** Decides eligibility beyond "holds a Genesis unit now": the used-unit ledger
  (a unit used by one claim stays used after a transfer) lives in the API, from its reservation store
  (migration 039) and Genesis transfer logs. A leaked signer key can therefore mint at most one free copy to
  each wallet that currently holds a Genesis unit, never to a wallet without one; the admin can `pause()` and
  `setSigner()` at once, and the artist can revoke `ISSUER_ROLE`. Losing reservation rows (for example a
  database restore) could let a transferred, already-used unit be claimed again by its new holder's wallet,
  still one per wallet.
- **Claim admin.** Can pause/unpause, rotate the signer and transfer the admin role (one step; the admin and
  signer must differ). It cannot change the release, token, schedule, price or allocations, which are immutable.
- **Artist (release admin).** Grants and can revoke the claim's `ISSUER_ROLE`; can reconfigure the sale, which
  halts claims until the sale matches the claim again.
- **Genesis collection.** The immutable EIP-1167 proxy at `0xD1B4367dd9f235f9ee61878019d66E31511E98eE`
  (implementation `0x2e61967a569bc18affc5e1b9f71e00af93a268c7`, owner the artist wallet), read-only.
- **Fuji** has no Genesis collection: there the signed voucher alone gates claims (test network only). The contract does not check the sale's
`perWalletLimit` or `paused`; a free claim mints through the release, not the sale, so it never counts
against the paid per-wallet limit, and a claimant can still buy up to the limit.

## What the deploy script adds (`npm run deploy:genesis-claim`, plan only on mainnet)

- The release and sale are real contracts on the chain, the sale's `releases()` is this release.
- On mainnet the release was created by the active factory in `config/mainnet-release-per-contract.json`
  (`isRelease(release)`), and the sale is the one that factory paired with it (`primarySaleOf(release)`). A
  release from a historical factory, or any other contract, is refused. The plan records the factory as
  `target.releaseFactory`.
- Open edition (`GENESIS_EXPECT_OPEN_EDITION=yes`, the default): `maxSupplyOf(token) == 0`.
- The edition's `mintEndOf(token)` is `0` or exactly `publicSaleEnd`. The mint end is fixed when
  the edition is created and cannot be changed afterwards; a mint end before the sale end would refuse the
  late purchases (`MintingEnded`) whatever the sale says. Live token 1 has `mintEndOf(1) == 0`.
- On mainnet `GENESIS_PUBLIC_SALE_END` is required and must give a policy window from `claimStart`; if
  `GENESIS_PUBLIC_WINDOW_SECONDS` is also set it must agree.
- The sale is not paused, and its `perWalletLimit` equals `GENESIS_EXPECT_PER_WALLET_LIMIT` (required on
  mainnet, optional on Fuji).
- `claimStart` is at least 600 s after the latest block when the plan is made.
- The constructor is simulated with `eth_call` before the plan is written; the artist wallet must hold
  `DEFAULT_ADMIN_ROLE` on the release for the `grantRole(ISSUER_ROLE, claim)` follow-up.
- Roles stay separate: the claim admin and voucher signer are not the fee recipient or the deployer, the signer
  is not the artist or the admin, and the signer is a dedicated key (the artist wallet may be the admin).
- Funding gate: the plan is `readyToSign` only when the deployer has no pending transactions, the predicted claim
  address is empty, the RPC returned usable fee data, and the deployer holds `gasLimit × maxFeePerGas × 1.5`.
  These live checks are re-run before each signature and are not part of the plan binding.

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

## Owner actions, in order (none is performed by this repository)

The schedule (start, end, per-wallet limit) is the owner's decision; nothing here chooses it.

1. **Artist wallet** `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` signs `configureSale(1, 250000000000000000, 0,
   <limit>, <start>, <end>, false)` on the sale `0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845`, with a policy window
   (whole hours, 7-14 days) and `<start>` far enough ahead for steps 2-6.
2. **Owner** chooses the claim admin (not the fee recipient) and generates a dedicated voucher signer key offline
   (not the admin, deployer, artist or fee recipient). Only the signer's address goes into the plan.
3. **Owner** funds the deployer `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` for one contract creation before
   signing (planning needs no funds). The plan computes the requirement itself: `funding.requiredAvax` =
   `signingRequests[0].gasLimit` × the RPC's `maxFeePerGas` × 1.5, and its `checks` row *deployer funded with 50%
   headroom over gasLimit × maxFeePerGas* must read PASS before either signing path offers the transaction. A plan
   made while the RPC returns no usable fee data is refused rather than guessed.
4. **Owner** runs *Plan the Genesis holder claim for C-Chain mainnet* (GitHub Actions) on the merged claim source
   with `release_contract`, `primary_sale`, `token_id=1`, `claim_start=<start>`, `public_sale_end=<end>`,
   `expected_per_wallet_limit=<limit>`, `claim_admin`, `claim_signer_address`, `expected_deployer_address`,
   `expected_deployer_nonce`. The run simulates the constructor, records the exact creation data (and its
   hash), and uploads the artifact `genesis-claim-mainnet-plan-<run id>`: `plan.json`, `plan-output.log` and
   `plan-binding.json` (the plan bound to that run's commit). Nothing is merged; the binding file is the
   approval, valid only for that commit and that deployer nonce.
5. **Owner** checks out the binding's `sourceCommit` cleanly and signs the single creation transaction in Rabby
   with the deployer: `npm run sign:mainnet -- --kind genesis-claim-mainnet --plan plan.json --binding
   plan-binding.json`. The tool re-plans from the live chain and refuses any difference from the approved plan;
   after mining it verifies the transaction against the plan's data hash and every claim parameter on chain.
   (`npm run owner:deploy -- --kind genesis-claim-mainnet --input …` plans and signs in one local session
   instead; `deploy/mainnet/OWNER-SIGNING.md` lists every input.)
6. **Artist wallet** signs `grantRole(ISSUER_ROLE, <claim>)` on the release (the plan's `followUps.issuerGrant`):
   the only permission the claim needs. It must be mined before `<start>`.
7. **Owner** sets the API (Render) variables below and redeploys the API; `GENESIS_CLAIM_ENABLED=true` only with
   the owner's explicit authorization.

## API (Render) configuration at activation (not changed by this repository)

| Variable | Value |
|---|---|
| `GENESIS_CLAIM_ENABLED` | `true` (owner-authorized; `false` until then) |
| `RELEASE_NETWORK` | `mainnet` |
| `GENESIS_CLAIM_CONTRACT` | the verified claim address |
| `GENESIS_CLAIM_RELEASE_CONTRACT` / `GENESIS_CLAIM_PRIMARY_SALE` / `GENESIS_CLAIM_TOKEN_ID` | `0xF0C091A159DE16cF0F306b2B61d37685EC5A830e` / `0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845` / `1` |
| `GENESIS_CLAIM_ALLOCATION` / `GENESIS_PUBLIC_MINT_ALLOCATION` | `0` / `0` |
| `GENESIS_CLAIM_START` | the plan's `claimStart` |
| `GENESIS_CLAIM_WINDOW_SECONDS` | `86400` |
| `GENESIS_PUBLIC_WINDOW_SECONDS` | the plan's `publicWindowSeconds` (the blueprint default `604800` is wrong for any other window; the API then refuses to serve vouchers) |
| `GENESIS_PUBLIC_PRICE_WEI` | `250000000000000000` |
| `GENESIS_CLAIM_SIGNER_ADDRESS` / `GENESIS_CLAIM_SIGNER_PRIVATE_KEY` | the dedicated signer (the key only as a Render secret) |
| `GENESIS_RPC_URL` / `GENESIS_DESTINATION_RPC_URL` | C-Chain RPC |

The API refuses to load unless the deployed claim's parameters match these values.
