# LegacyCollectionMarketplace — human audit package

**Status: AUDIT CANDIDATE. Not deployed, not audited by a human, not live.** This package prepares a qualified human security
audit. The AI reviews, mutation checks, fuzz runs and fork tests recorded here are evidence of care, **not** an audit and not
production evidence. Nothing here authorizes deployment. `config/legacy-collection-marketplace.json` stays `deployed: false`.
No auditor, audit date, owner Safe address, deployment address or transaction hash exists yet; none is invented here.

Evidence classes used throughout: **[FACT]** read from the repo or chain · **[UNIT]** local Solidity/JS tests · **[FUZZ]** local
property tests · **[FORK]** local fork of real mainnet state, nothing broadcast · **[AI]** AI adversarial review ·
**[FUTURE]** required before/after deployment, does not exist yet.

## 1. Candidate identification [FACT]
| Item | Value |
|---|---|
| Contract | `contracts/LegacyCollectionMarketplace.sol` — 309 lines, Solidity `^0.8.24`, no imports beyond a 3-function ERC-1155 interface (`IERC1155ReleaseMarketplace` in `ReleaseMarketplaceV3.sol`) |
| Source commit (last change to the contract) | `e75db1adf5b96314ccfe6e15b28a4a07d6e1212c` |
| Git blob hash of the contract | `68f98e078e0532ed3dcff70ae0348913e058168b` (`git hash-object contracts/LegacyCollectionMarketplace.sol`) |
| SHA-256 of the contract file | `89a187444ad136110d02fcda8f3cc495e8e9512cc05298a1430fdd873cf3afcf` |
| Later commits | documentation/test-only commits on PR #229; the blob hash above is the authority. If the contract file's hash differs, this package is stale. |
| Upgradeability | None: no proxy, no initializer, no `delegatecall`, no `selfdestruct`. |
| Existing contract affected | None. `ReleaseMarketplaceV4` (`0x0e77116142844478a55EEd2Ab79de9F93770F8f5`) is untouched. |
The previous candidate (`87c5283`, blob `710fd21b…`) is superseded; see §10 for what changed and why.

## 2. Reproducible build [FACT]
```
forge --version            # forge 1.5.1-stable used here (CI uses Foundry v1.3.1)
forge clean && forge build # foundry.toml: solc 0.8.24, optimizer on, 200 runs, EVM cancun
node scripts/prepare-legacy-marketplace-deployment.mjs   # prints the hashes below (exit 3 BLOCKED while no owner Safe is supplied)
```
| Hash | Value |
|---|---|
| creation bytecode keccak256 | `0x3bd6aa5a42b26b2e11e22f92478669768d3a55c88de87e739ec22ec62ae39677` |
| runtime bytecode keccak256 | `0xc245a1574b1a50435dae4b5ea53a55fefe7767355ecbb05ed2467ce39747a5b1` |
Two consecutive `forge clean && forge build` runs produced identical hashes. The deployed runtime embeds the immutables
(`feeRecipient`, `platformFeeBps`, `deploymentChainId`), so compare with immutables masked, or deploy the same constructor
arguments on a fork and compare.

## 3. Policy under audit (confirmed scope — not authority to deploy)
- Collection: Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` (Joepegs `ERC1155SingleBundle` clone of `0x2e61967a…93a268c7`), Avalanche C-Chain 43114 [FACT].
- Token ids **0–3 only**; royalty **cap 500 bps**; marketplace fee **250 bps** to `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` (no contract code on mainnet: an EOA) [FACT].
- Genesis keeps its own ERC-2981 royalty: 500 bps to `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` — the Launchpeg initializer default, never changed (no `DefaultRoyaltySet` event on the proxy) [FACT]. The 2.5% artist royalty belongs to *new factory releases* only and is unchanged.
- Target settlement at the reported rates: seller 92.5%, creator 5%, fee 2.5%.
- Allowlist, token-id range and cap are enforced **by the contract** (`allowCollection`, `_requireSupported`, `_settlement`), not by the frontend [UNIT/FUZZ]: `testPolicyIsExactlyTokens0To3WithA500BpsCap`, `testTokenIdsOutsideTheScope…`, `testRoyaltyAtTheCapIsAcceptedAndOneBpsAboveIsRefused`, `testAnotherCollectionStaysRefused…`, `testFuzzRoyaltyAboveTheCapIsAlwaysRefused`.

## 4. Deployment parameters and ownership
| Parameter | Value |
|---|---|
| `feeRecipient_` | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` |
| `platformFeeBps_` | `250` (constructor reverts on any other value) |
| `owner_` | **BLOCKED — owner Safe address not supplied.** Left unset (`null`) in the candidate. Must not be the deployer wallet (`0xaBd3746e…c174`), the fee recipient, the factory, the V4 marketplace or Genesis. |
| First post-owner call | Safe → `allowCollection(Genesis, 500, 0, 3)`; exact calldata printed by the dry-run script |
`scripts/prepare-legacy-marketplace-deployment.mjs` is a **dry run**: it reads no key, signs nothing, broadcasts nothing (asserted by a test). It checks a supplied owner is well-formed, non-zero, on chain 43114, not a colliding role, has contract code, and answers `getThreshold()/getOwners()` like a Safe (warns on threshold < 2). **It cannot prove the address is the organisation's intended Safe; an authorized operator must confirm that out of band.** Without an address it reports BLOCKED (exit 3).

## 5. Settlement formulas (`buy`, quantity `q`, price per unit `p`, `S = p·q`)
```
fee      = ⌊S · 250 / 10000⌋                      → feeRecipient
(receiver, royalty) = token.royaltyInfo(tokenId, S)   // 100k gas cap, exactly 64 bytes, receiver word fits in 160 bits
require royalty ≤ ⌊S · maxRoyaltyBps / 10000⌋ ; royalty > 0 ⇒ receiver ∉ {0, this}
seller   = S − fee − royalty                       // fee + royalty + seller = S exactly
require seller ≥ minSellerProceedsPerUnit[listingId] · q
order: floor check → safeTransferFrom(seller→buyer) + buyer balance must rise by ≥ q → pay fee → pay royalty → pay seller
```
Rounding: floors on `fee` and on the collection's royalty favor the seller, who absorbs all dust. A price below 40 wei has a zero fee. [FUZZ] `testFuzzSettlementMatchesTheDocumentedFormulaAndNeverShortsTheFloor` (20,000 runs) asserts each line above plus conservation and zero residue.

## 6. Seller floor — behavior, and the default
> A purchase of `q` units completes only if the seller's net proceeds of **that purchase** (price × q, the royalty reported by the collection when the purchase is made, the 2.5% fee) are at least `minSellerProceedsPerUnit[listingId] × q`; otherwise the whole transaction reverts — no token moved, no payment kept, listing unchanged.
- **One way to list.** `createListingWithMinProceeds` is the only listing-creation function. The V4-shaped `createListing` (selector `0x5201ea65`) was **removed**: it created listings with no floor, and had no caller against this marketplace (§10). The floor is **mandatory**: zero reverts `MinProceedsRequired`, above the unit price or undeliverable today reverts `MinProceedsTooHigh`. `setMinSellerProceeds` has the same rules, so a floor can never be cleared or silently made undeliverable.
- **What the seller is told.** The app computes the floor as `⌊p·(10000−250−royaltyBps)/10000⌋` (exact-rate share). Because the contract floors the fee and the royalty, real proceeds are never below it, so a sale at today's royalty always clears it and a royalty increase that would leave the seller below the floor makes the purchase revert instead of paying less. At ordinary prices that is every increase (1 bp at 1 AVAX is 10^14 wei); at wei-scale prices rounding can absorb a very small one, which still never takes the seller below the floor. The listing review shows the exact minimum per edition and in total, states that the royalty is set by the collection, and explains that the listing then stays unsold until the seller cancels and relists. The floor that is signed is the one the seller reviewed; if the royalty changes between review and confirmation the app aborts and sends nothing.
- **Default tolerance: zero, retained as the fail-safe.** No tolerance is added and no tolerance input exists; the helper's `toleranceBps` parameter is unused by the UI. Raising it is a product decision (it lowers the seller's floor), not made here.
- **Tiny prices.** At about 1 wei the exact-rate share is 0, so no non-zero floor exists: the app refuses the listing and the contract refuses a zero floor. Fuzz tests use prices ≥ 100 wei; the boundary is tested explicitly (`testAOneWeiPriceHasNoProtectiveFloorAndIsRefusedSafely`).
- **A deliberately tiny floor** (e.g. 1 wei) is a stored, explicit seller choice that accepts any royalty up to the cap (`testATinyFloorIsAnExplicitChoice…`). The app never sends one.
- **Compatibility** [UNIT]: `Listing`, `getListing`, `ListingCreated/Cancelled/Expired/Sold`, `cancelListing`, `expireListing`, `buy` keep their V4 shapes (selectors/topics asserted). The floor is a separate public mapping; **no new event**, because the indexer records unrecognized marketplace events as malformed. `listingStatus` now reverts (`UnknownListing`) for a never-created id; `getListing` of an unknown id returns an all-zero struct.

## 7. Admin permissions and emergency behavior [UNIT + source tripwire]
Owner (intended: a Safe) can: `allowCollection` (needs code + ERC-165 for ERC-1155 and ERC-2981, `maxRoyaltyBps ≤ 1000`, `min ≤ max`), `disableCollection`, `setPaused`, two-step `transferOwnership`/`acceptOwnership`.
Owner **cannot**: withdraw AVAX or tokens (no such function; no `receive`/`fallback`), cancel/alter/seize a listing, change a floor, change the fee or fee recipient (immutable), change a seller's proceeds for any listing (every listing is protected). `src/lib/legacy-marketplace-consistency.test.js` pins the exact external surface and the owner-only set; adding a function such as `sweep()` fails it (checked).
Effect of owner actions: pause / disable / narrowing the range or cap blocks `buy` and new listings (liveness only). `cancelListing`, `expireListing` and `setMinSellerProceeds` keep working while paused. Re-allowing a disabled collection revives its still-active listings. Raising the cap (≤ 10%) lets a *seller who chose a very low floor* tolerate a higher royalty; protected listings are immune.
Emergency: Safe calls `setPaused(true)` and/or `disableCollection(Genesis)`. There are no funds to recover (non-custodial; nothing retained between transactions).

## 8. Assumptions and trust boundaries for the auditor
1. **Reentrancy.** `buy` is `nonReentrant`; the listing is updated before any external call. External calls inside `buy`: `balanceOf` (view), the ERC-1155 `safeTransferFrom` (buyer's receiver hook runs here), `balanceOf` again, then three AVAX payments (fee recipient, royalty receiver, seller). Entry points reachable during those calls: `createListingWithMinProceeds`, `setMinSellerProceeds`, `cancelListing`, `expireListing` are unguarded; they move no value and act only on the caller's own listings (a mid-buy cancel acts on the already-decremented amount) [UNIT/AI].
2. **Untrusted collection.** `balanceOf`, `isApprovedForAll`, `safeTransferFrom` and `royaltyInfo` come from the allowlisted collection. The delivery check (buyer balance must rise by ≥ q) stops a token that *reports success without delivering, or delivers short*. **A malicious allowlisted token can still lie about `balanceOf`**; the allowlist remains a trust boundary. `royaltyInfo` is read with a 100k gas cap and a fixed 64-byte buffer (inline assembly using scratch space 0x00–0x3f).
3. **Gas-dependent `royaltyInfo` (theoretical).** A hostile allowlisted collection could return different royalties depending on the gas supplied; the seller's floor still holds, but the creator could be underpaid. Genesis's `royaltyInfo` is deterministic storage arithmetic.
4. **Payout failure.** Any payout failure reverts the whole sale (`TransferFailed`). A royalty receiver, seller or the fee recipient that rejects AVAX blocks that sale; a non-payable fee recipient would block **all** sales forever (immutable). `0xb65C…1ce4` has no contract code today [FACT]. No pull-payment fallback by design.
5. **Operator filter.** Genesis calls an OpenSea-style registry (`0x000000000000AAeB6D7670E522A718067333cd4E`) on `setApprovalForAll(operator)` and on `safeTransferFrom` by any non-owner operator. It currently allows every operator (registered, no filtered operators) [FACT/FORK]. Genesis's owner can change that; then `buy` reverts and listings go stale. The app and readiness script check `isOperatorAllowed`. No on-chain mitigation.
6. **Collection admin.** Genesis's owner (`0x284C…180a`, also the royalty receiver) can raise the royalty (≤ 2,500 bps on Genesis), change the receiver, or filter the marketplace. Protected listings revert rather than pay less; the cap bounds the royalty.
7. **Chain-id gating.** Every state-changing function, including `cancelListing`, is gated by `deploymentChainId`; on a fork with a different chain id nothing works (sellers can cancel on the deployment chain).
8. **Self-purchase is refused** (`SelfPurchase`), which also makes the delivery check sound. Wash trading from a second wallet is not prevented.
9. **Forced AVAX** (selfdestruct/coinbase) is stranded; nothing reads the balance.
10. **Events.** `ListingSold.price` is the total, `ListingCreated.price` per unit; no event states the remaining amount after a partial fill.
11. **Stale listings.** A seller who moves tokens or revokes approval leaves an unfillable listing that revives if the tokens return; overlapping listings simply fail atomically.
12. **No UI to change a floor.** `setMinSellerProceeds` exists on-chain; the app offers cancel-and-relist only.

## 9. Verification results for this candidate [commands from the repo root; exit codes recorded]
| Class | Command | Exit | Result |
|---|---|---|---|
| UNIT + adversarial (Solidity) | `forge test` | 0 | **295 passed, 0 failed, 7 skipped** (6 = pre-existing claim-fork suite, 1 = this candidate's fork suite; both skip without an RPC and are reported as skipped) |
| FUZZ, heavy | `FOUNDRY_FUZZ_RUNS=20000 forge test --match-path "test/LegacyCollectionMarketplace*.t.sol"` | 0 | **57 passed, 0 failed, 1 skipped** (the fork suite) |
| FORK (local fork of real mainnet state, **nothing broadcast**) | `MAINNET_FORK_RPC=https://api.avax.network/ext/bc/C/rpc forge test --match-path test/LegacyCollectionMarketplaceMainnetFork.t.sol` | 0 | **6 passed** — real Genesis holder lists, second account buys, exact 2.5/5/92.5; ids 0–3 sell, id 4 refused; real Genesis owner raising the royalty to 7% reverts a protected purchase; V4 still refuses Genesis. *Not production evidence.* |
| FORK suite without an RPC | same command, no env | 0 | **0 passed, 1 skipped** (cannot pass silently) |
| App / API / indexer / manifest / UI | `npx vitest run` | 0 | **1922 passed, 60 skipped** (181 files passed, 10 skipped) |
| Lint | `npx eslint .` | 0 | clean |
| Production builds | `npx vite build` · `VITE_RELEASE_NETWORK=mainnet VITE_MARKETPLACE_CHAIN_ID=43114 VITE_MARKETPLACE_ADDRESS=0x0e77…F8f5 VITE_MARKETPLACE_FEE_BPS=250 npx vite build` | 0 · 0 | both succeed |
| Read-only readiness (live mainnet RPC) | `node scripts/verify-legacy-marketplace.mjs` | 2 | 9 PASS (V4 registry/fee; Genesis ERC-165s, not factory-registered, royalty 500 bps ≤ cap for ids 0–3); **NOT DEPLOYED** |
| Owner/deployment dry run | `node scripts/prepare-legacy-marketplace-deployment.mjs` | 3 | parameters + hashes printed; **BLOCKED** (no owner Safe) |
| Preview deployments | Vercel `the-void`, `the-void-vercel-mainnet` | — | build the app only; they do not exercise the contract |
| **Live mainnet** | — | — | **None. No deployment, listing, purchase or settlement exists.** |
Test files: `test/LegacyCollectionMarketplace.t.sol` (19), `…MinProceeds.t.sol` (18), `…GenesisPolicy.t.sol` (10, three fuzz), `…ListingPaths.t.sol` (10), `…MainnetFork.t.sol` (6), plus `src/lib/legacy-marketplace*.test.js`, `src/components/ListingPanel.legacy.test.jsx`, `scripts/prepare-legacy-marketplace-deployment.test.mjs`.
**Mutation checks** (a test fails when the logic is removed): seller-floor check → 3 fail; royalty-cap check → 2 fail (incl. a fuzz counterexample); fee 250→200 → 14 fail; delivery check → 2 fail; self-purchase check → 1 fail; an added second creation function → 2 tripwire tests fail; an added owner `sweep()` → 3 tripwire tests fail; UI royalty-changed guard → 1 fail.

## 10. What changed since the previous candidate (`87c5283`), and the AI reviews [AI — not human audits]
| Change | Why |
|---|---|
| Removed the V4-shaped `createListing`; the floor is mandatory and can never be cleared | The overload enforced every other invariant (allowlist, scope, cap, authorization, balance, approval, settlement preview all live in the shared `_createListing`) but created listings with no seller floor, so it was an alternate path around the seller guard. No caller exists: the app used `encodeCreateListing` only for V4 (guarded by `isLegacyMarketplace`), `scripts/rehearse-royalty-fuji.mjs` targets V4 on Fuji, and the contract is undeployed. |
| Delivery check + `SelfPurchase` | Review #2 (finding 1): a token reporting success without delivering took the buyer's AVAX. |
| `listingStatus` reverts for unknown ids | Review #2 (finding 2): the enum default read as `ACTIVE`. |
| UI shows the floor; signs the reviewed floor; aborts if the royalty changed; refuses prices with no valid floor | Make the zero-tolerance default explicit and unbypassable from the frontend. |
**Review #1** (earlier contract): no critical/high; two hardenings applied (full-quantity validation, bounded `royaltyInfo` read).
**Review #2** (fresh agent, contract blob `31302fb1…`, wrote 25 PoC tests in a scratch project **not committed to this repo**): no critical, high or medium; could not break any of the six guarantees (allowlist/fee, floor, royalty settlement, owner powers, authorization, ordinary transfers); tried reentrancy from the buyer hook, royalty receiver, fee recipient and seller into every function. Confirmed lows (lying token, `listingStatus` default, forced AVAX) plus informational items; the first two lows are fixed in `e75db1a`, the rest are documented in §8. Re-running its PoCs against the final contract: 22 still pass; the 3 that demonstrated the closed findings now fail, as intended.

## 11. Deployment, rollback and post-deployment verification [FUTURE — all steps need explicit authorization]
1. Supply the owner Safe → `OWNER_SAFE_ADDRESS=0x… node scripts/prepare-legacy-marketplace-deployment.mjs`; operator confirms Safe identity out of band.
2. Complete the human audit; resolve findings; re-run §9 on the final commit; re-record §1–§2 hashes.
3. Deploy `LegacyCollectionMarketplace(feeRecipient, 250, ownerSafe)` through the repo's approved-plan process (`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`); never the deployer as owner.
4. Safe executes `allowCollection(Genesis, 500, 0, 3)`.
5. Verify source and compare bytecode (§2); read back `owner()`, `feeRecipient()`, `platformFeeBps()`, `deploymentChainId()`, `getCollection(Genesis)`, `paused()`.
6. One reviewed PR sets `deployed: true`, `marketplaceAddress`, `deploymentBlock`, `ownerAddress`, `record`; `node scripts/verify-legacy-marketplace.mjs` must exit 0.
7. Deploy app/API/indexer from that commit. Run the mainnet acceptance procedure in `docs/GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md` (real holder lists with a floor, second account buys, balances and fee/royalty settle exactly, failed purchase moves nothing, plain transfer works, V4 trading re-verified) and record every transaction hash.
8. Rollback: `setPaused(true)` / `disableCollection(Genesis)` from the Safe; revert the manifest PR (`deployed:false`) to hide the UI. Sellers keep `cancelListing`. Redeploy a fixed contract if a bug is found; repoint the manifest.

## 12. Prioritized auditor checklist
**P0 — funds and invariants**
- [ ] `buy` end to end: ordering of effects/interactions, atomic revert on any failure, zero residue, `fee + royalty + seller = S`.
- [ ] Seller-floor invariant under partial fills, rounding, price × quantity overflow, royalty changes.
- [ ] Reentrancy from the buyer hook, royalty receiver, fee recipient and seller into every external function (§8.1).
- [ ] Delivery check and self-purchase rule: do they hold for odd ERC-1155 behavior (reentrant `balanceOf`, hooks that move tokens)?
- [ ] `_settlement` assembly: scratch-space use, gas cap, return-size and dirty-bit handling.
**P1 — authority and liveness**
- [ ] Owner power surface vs §7; two-step ownership; effect of narrowing/disabling/re-allowing a collection.
- [ ] Non-payable fee recipient / royalty receiver, operator-filter and collection-admin liveness risks (§8.4–8.6).
- [ ] `onlyDeploymentChain` on `cancelListing` (§8.7).
**P2 — integration and hygiene**
- [ ] Event semantics for indexers; `listingStatus`/`getListing` unknown-id behavior.
- [ ] Gas / griefing; unbounded loops (none); `_supportsInterface` 30k gas cap vs real collections.
- [ ] Reproduce §9 FORK results independently.
- [ ] Whether to add a pull-payment fallback, a floor-update UI, or a tolerance setting (product decisions, §6).

## 13. Blockers before deployment [FUTURE]
1. **Owner Safe address — BLOCKED** (not in the repo; will not be invented).
2. **Human security audit** — not started; findings must be resolved.
3. **Explicit deployment authorization** and two funded wallets for the mainnet acceptance run.
4. Mainnet acceptance evidence with transaction hashes — none exists.
