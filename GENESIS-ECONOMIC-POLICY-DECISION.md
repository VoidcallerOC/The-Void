# Genesis resale economics: conflict record and owner decision (2026-10-21)

Status: **BLOCKED on an owner decision.** No contract, royalty, deployment or production configuration was changed.
Nothing was deployed, signed or broadcast.

## 1. The conflict

| Source | Genesis resale split (platform / creator royalty / seller) |
|---|---|
| Owner confirmation, 2026-10-20 (`docs/adr/0001-genesis-legacy-collection-marketplace.md` "Confirmed scope", `docs/GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md`) | **2.5 / 5 / 92.5**: honor Genesis's own 500 bps royalty |
| Genesis compatibility mission, 2026-10-21 | **2.5 / 2.5 / 95** stated as the intended split |
| What the deployed collection reports today | royalty **500 bps** to `0x284C…180a` |
| What `LegacyCollectionMarketplace` (merged, not deployed) pays | the royalty the collection reports, capped at 500 bps. **2.5 / 5 / 92.5** today |

The two outcomes are not equivalent. At 1 AVAX the seller receives 0.925 under one and 0.95 under the other. The difference
(0.025 AVAX) goes to the royalty receiver instead of the seller. Sellers are third-party holders, not the owner. That both the
platform and the royalty receiver are owner-controlled wallets does not change what a seller receives.

## 2. Confirmed live facts (read-only, block ~98,144,972, publicnode RPC)

- `supportsInterface`: ERC-1155 `0xd9b67a26` true, ERC-2981 `0x2a55205a` true, AccessControl `0x7965db0b` true.
- `royaltyInfo(id, price)` for ids 0–3 (and 4): receiver `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a`, amount `⌊price·500/10000⌋`
  (1 → 0; 3,333 → 166; 1e18 → 5e16). The same for every id: one contract-wide default.
- Code: 45-byte EIP-1167 clone of `0x2e61967a…93a268c7` (`ERC1155SingleBundle`, verified, solc 0.8.13). There is no EIP-1967 slot
  and no `upgradeTo`. **The code is immutable. The royalty is not.**
- **Royalty is mutable:** `ERC1155LaunchpegBase.setRoyaltyInfo(address receiver, uint96 feePercent) external onlyOwner` reverts above 2,500 bps
  and emits `DefaultRoyaltySet`. `owner()` = `0x284C…180a`, which has no contract code, so it is an EOA. `pendingOwner` is zero. No
  `DefaultRoyaltySet` event exists since launch (ADR), so the royalty has never been changed.
- Operator filter: `operatorFilterRegistry()` = `0x000000000000AAeB6D7670E522A718067333cd4E` (OpenSea). It allows a freshly deployed
  `LegacyCollectionMarketplace` on a fork (`testRealGenesisFacts`). The real deployed address is **UNVERIFIED** until deployment, and the
  collection owner can change the registry (`setOperatorFilterRegistryAddress`, owner-only).
- `paused()` = false. The receiver is an EOA, so it accepts AVAX. A rejecting receiver would revert the whole sale (`TransferFailed`).
- `ReleaseMarketplaceV4` refuses Genesis because `registry.isRelease` is false. It still refuses at a 250 bps royalty (fork test below).

## 3. Options (owner decision; none is taken here)

| | Action | Result on resale | Trade-offs |
|---|---|---|---|
| **A** | Keep the 2026-10-20 decision. Deploy `LegacyCollectionMarketplace` as merged. | 2.5 / 5 / 92.5 | No change to any contract. It differs from the 95% headline for factory releases, so the UI must show the Genesis split. |
| **B** | Genesis owner `0x284C` calls `setRoyaltyInfo(0x284C…180a, 250)` on the collection, then deploys the marketplace as merged. Optionally lower `maxRoyaltyBps` to 250 at `allowCollection`. | 2.5 / 2.5 / 95 | The marketplace is unchanged. It changes Genesis's royalty **on every marketplace** (Joepegs etc.), a collection-level change this mission forbade the agent to make. It is reversible by the owner, so it is not a permanent guarantee to sellers. |
| C | Marketplace pays a fixed 250 bps regardless of what Genesis reports. | 2.5 / 2.5 / 95 | **Rejected without approval:** it substitutes a royalty model that the collection does not report (constraint 10). It would need new code, a new audit and an ADR. |

Proven on a fork (nothing broadcast): with option B, the unchanged marketplace settles exactly 0.025 / 0.025 / 0.95, and V4 still
refuses Genesis (`testIfTheGenesisOwnerSetTwoPointFivePercentTheUnchangedMarketplaceWouldSettle95`).

A seller floor protects every listing either way. A royalty **increase** after listing cannot take a seller below their
floor: the sale reverts (`testRealGenesisRoyaltyIncreaseCannotUndercutAProtectedSeller`).

## 4. What the owner must decide

One line: **"Genesis resale is 2.5 / 5 / 92.5 (option A)"** or **"2.5 / 2.5 / 95 via the collection owner's `setRoyaltyInfo` (option B)"**.
Option B is a transaction the owner signs from `0x284C`. The agent will not prepare or broadcast it without a separate, explicit instruction.

Not legal advice: changing the royalty that existing Genesis holders were sold under may carry disclosure obligations.
Consult a human attorney if that matters to you.
