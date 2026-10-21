# Genesis resale economics: locked policy (2026-10-21)

**Genesis resale: 0% platform fee / full existing 5% royalty / 95% seller at the current royalty rate.**

Status: policy LOCKED by the owner on 2026-10-21. It is implemented in `contracts/LegacyCollectionMarketplace.sol` (merged
candidate, revised). The marketplace is **NOT DEPLOYED**. Nothing was deployed, signed or broadcast. Genesis's royalty settings
were not touched.

This replaces the earlier version of this file, which recorded a conflict between 2.5 / 5 / 92.5 (owner, 2026-10-20) and
2.5 / 2.5 / 95. Both are superseded: the platform takes nothing, and the royalty stays at the collection's own 5%.

## 1. Policy

| | Genesis (`LegacyCollectionMarketplace`) | New factory releases (`ReleaseMarketplaceV4`, unchanged) |
|---|---|---|
| Platform fee | **0%**. No fee recipient exists in the contract | 2.5% to `0xb65C…1ce4` |
| Creator / artist royalty | the collection's own ERC-2981 `royaltyInfo`, paid in full (500 bps today) to `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | 2.5% to the edition's artist payout |
| Seller | sale price minus the royalty actually paid (**95%** at 5%) | 95% |

| Sale price | Platform | Genesis royalty | Seller |
|---|---|---|---|
| 1 AVAX | 0 | 0.05 | 0.95 |
| 10 AVAX | 0 | 0.5 | 9.5 |
| 100 AVAX | 0 | 5 | 95 |

The marketplace follows the live ERC-2981 result. That result is validated against the 500 bps cap and must name a non-zero
recipient that is not the marketplace. The expected recipient `0x284C…180a` is enforced by the app and by the readiness script.
If Genesis ever reported a different royalty, the seller would receive the price minus that royalty. The seller's floor still
protects every listing: a royalty increase after listing makes the sale revert instead of underpaying the seller.

## 2. Where the policy is enforced

- **Contract (authoritative).** `uint256 public constant platformFeeBps = 0`. No fee recipient and no fee constructor argument.
  `_settlement` sets `platformFee = 0` and `seller = S − royalty`. `_settle` pays only the royalty receiver and the seller.
- **Manifest.** `config/legacy-collection-marketplace.json` records `platformFeeBps: 0` and no `feeRecipient`.
  `legacyMarketplaceActive()` refuses to activate with any other fee.
- **App.** `readLegacyListingContext` refuses unless the live contract reports `platformFeeBps() == 0` and a real
  `previewSettlement` carries a zero platform share. The listing panel shows "MARKETPLACE FEE · 0%".
- **Indexer.** The legacy marketplace is registered with `platformFeeBps: 0`, so a `ListingSold` with a non-zero fee is rejected as malformed.
- **Scripts.** `prepare-legacy-marketplace-deployment.mjs` builds `LegacyCollectionMarketplace(owner)` and refuses a non-zero manifest fee.
  `verify-legacy-marketplace.mjs` requires `platformFeeBps() == 0`, no `feeRecipient()`, and a preview with a 0 fee, royalty plus seller equal to the price,
  and the expected recipient.

## 3. Confirmed live Genesis facts (read-only, block ~98,144,972; unchanged)

- ERC-1155 and ERC-2981 supported. `royaltyInfo(id, price)` for ids 0–3 returns `0x284C…180a` and `⌊price·500/10000⌋`, the same for every id.
- The code is an immutable EIP-1167 clone of verified `ERC1155SingleBundle`. **The royalty is owner-mutable:**
  `setRoyaltyInfo(receiver, feePercent)` is `onlyOwner` and capped at 2,500 bps. The owner is `0x284C…180a`, an EOA. It has never been changed.
  This policy does not call it.
- Operator filter: OpenSea registry `0x0000…cd4E`. It allows a freshly deployed marketplace on a fork. Whether it allows the real
  deployed address is UNVERIFIED until deployment.
- `ReleaseMarketplaceV4` refuses Genesis (`isRelease` is false). That is unchanged and is not bypassed.

## 4. Evidence

- Fork against live Genesis (10 tests, nothing broadcast): 0 / 5 / 95 at 1, 10 and 100 AVAX for ids 0–3, with the platform
  wallet's balance unchanged. Exactly 5% / 95% at every completing gas limit. V4 still refuses Genesis.
- Unit and fuzz suites: for any price, quantity and royalty up to the cap, the fee is 0 and `seller = S − royalty`.
- Fork evidence is not mainnet acceptance. Acceptance needs a real deployment and the procedure in `docs/GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md`.

## 5. Still required before Genesis trades (owner decisions; none is assumed)

1. Owner Safe address for the marketplace (not in the repo; will not be invented).
2. Human security audit of the zero-fee contract (audit package §0, including the widened M-1 note).
3. Explicit deployment authorization, then the deployment, manifest activation and acceptance run.
