# LegacyCollectionMarketplace — human audit package

**Status: AUDIT CANDIDATE. Not deployed, not audited by a human, not live.** This package prepares a qualified human security
audit. The two AI adversarial reviews and the mutation checks recorded here are evidence of care, **not** an audit.
Nothing here authorizes deployment. `config/legacy-collection-marketplace.json` stays `deployed: false`.

## 1. Candidate identification
| Item | Value |
|---|---|
| Contract | `contracts/LegacyCollectionMarketplace.sol` (292 lines, Solidity `^0.8.24`, no imports beyond a 3-function ERC-1155 interface in `ReleaseMarketplaceV3.sol`) |
| Source commit (last change to the contract) | `343087dfddc59140c4a0b658407e354a23677a3c` |
| Git blob hash of the contract | `710fd21bcad8a870e9676bb3a43a6f2241f68d0a` (`git hash-object contracts/LegacyCollectionMarketplace.sol`) |
| SHA-256 of the contract file | `abcce21a8d0d682bb257aa36612aeb4979eb4ee799be0853a707e6144bfe2199` |
| Test + doc commit | the head of PR #229 (the contract is byte-identical to the source commit; the blob hash above is the authority) |
| Upgradeability | None. No proxy, no initializer, no `delegatecall`, no `selfdestruct`. |
| Existing contract affected | None. `ReleaseMarketplaceV4` (`0x0e77116142844478a55EEd2Ab79de9F93770F8f5`) is untouched. |

## 2. Reproducible build
```
forge --version            # forge 1.5.1-stable used here
forge clean && forge build # foundry.toml: solc 0.8.24, optimizer on, 200 runs; evm = cancun (Foundry default for 0.8.24)
node scripts/prepare-legacy-marketplace-deployment.mjs   # prints the hashes below (exit 3 BLOCKED while no owner Safe is supplied)
```
| Hash | Value |
|---|---|
| creation bytecode keccak256 | `0x40844659a770bb3a27457fddc5c6b3a474bb91cd588a776c5e4a17ba8220cc16` |
| runtime bytecode keccak256 | `0x2a6d4e7cadf5a9eab9cd9497c73f0b72127f60f239269d6c2ab4e5df9e81d19b` |

Two consecutive `forge clean && forge build` runs produced identical hashes. After any real deployment, compare the on-chain
runtime bytecode with the runtime hash above (immutables `feeRecipient`, `platformFeeBps`, `deploymentChainId` are embedded, so the
deployed code hash will differ from this one; compare with immutables masked, or re-derive by deploying the same constructor args on a fork).

## 3. Policy under audit (confirmed scope — not authority to deploy)
- Collection: Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` (Joepegs `ERC1155SingleBundle` clone of `0x2e61967a…93a268c7`), Avalanche C-Chain 43114.
- Token ids **0–3 only**; royalty **cap 500 bps**; marketplace fee **250 bps** to `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` (no code: an EOA).
- Genesis keeps its own ERC-2981 royalty: 500 bps to `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` (verified; never changed since launch). The 2.5% artist royalty belongs to *new factory releases* only and is unchanged.
- Target settlement at the reported rates: seller 92.5%, creator 5%, fee 2.5%.
- Cap, token range and allowlist are enforced **by the contract** (`allowCollection`, `_requireSupported`, `_settlement`), not by the frontend. Tests: `testPolicyIsExactlyTokens0To3WithA500BpsCap`, `testTokenIdsOutsideTheScope…`, `testRoyaltyAtTheCapIsAcceptedAndOneBpsAboveIsRefused`, `testAnotherCollectionStaysRefused…`.

## 4. Deployment parameters and ownership
| Parameter | Value |
|---|---|
| `feeRecipient_` | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` |
| `platformFeeBps_` | `250` (constructor reverts on any other value) |
| `owner_` | **BLOCKED — owner Safe address not supplied.** The deployment candidate leaves it unset (`null`). It must not be the deployer wallet (`0xaBd3746e…c174`), the fee recipient, the factory, the V4 marketplace or Genesis. |
| First post-owner call | Safe → `allowCollection(Genesis, 500, 0, 3)`; exact calldata is printed by the dry-run script |
Owner validation tooling: `scripts/prepare-legacy-marketplace-deployment.mjs` (dry run, reads no key, never broadcasts) checks the supplied address is well-formed, non-zero, on chain 43114, not a colliding role, has contract code and answers `getThreshold()/getOwners()` like a Safe; it warns on threshold < 2. **It cannot prove the address is the organisation's intended Safe — an authorized operator must confirm that out of band.** Until then owner configuration is BLOCKED.

## 5. Settlement formulas (`buy`, quantity `q`, price per unit `p`, `S = p·q`)
```
fee      = ⌊S · 250 / 10000⌋                      → feeRecipient
(receiver, royalty) = token.royaltyInfo(tokenId, S)   // 100k gas cap, exactly 64 bytes, receiver word fits in 160 bits
require royalty ≤ ⌊S · maxRoyaltyBps / 10000⌋ ; royalty > 0 ⇒ receiver ∉ {0, this}
seller   = S − fee − royalty                       // conservation: fee + royalty + seller = S exactly
require seller ≥ minSellerProceedsPerUnit[listingId] · q
order: floor check → ERC-1155 safeTransferFrom(seller→buyer) → pay fee → pay royalty → pay seller
```
Rounding: floors on `fee` and on the collection's royalty favor the seller; the seller takes all dust. Fuzz-verified against these formulas (`testFuzzSettlementMatchesTheDocumentedFormula…`, 20,000 runs).

## 6. Seller minimum-proceeds invariant
> A purchase of `q` units completes only if the seller's net proceeds of **that purchase** (price × q, live `royaltyInfo`, 2.5% fee) are at least `minSellerProceedsPerUnit[listingId] × q`; otherwise the whole transaction reverts (no token moved, no payment retained, listing unchanged).

- Set at `createListingWithMinProceeds` or by the seller via `setMinSellerProceeds` (ACTIVE listings; works while paused). Owner and strangers cannot change it (`NotSeller`).
- A floor above the unit price, or undeliverable today for 1 unit or the whole remaining quantity, is refused (`MinProceedsTooHigh`). Intermediate quantities are checked at purchase.
- App-recommended floor `⌊p·(10000−250−royaltyBps)/10000⌋` is always cleared at the current royalty because fee/royalty floors only help the seller.
- **Known gap by design:** the V4-shaped `createListing` overload sets no floor; such a listing sells at the live royalty up to the cap. The app never calls it on this marketplace (`encodeCreateListingWithMinProceeds` throws without a floor). *Auditor question: should this overload be removed?*
- Compatibility: `Listing`, `getListing`, `ListingCreated/Cancelled/Expired/Sold`, `createListing`, `cancelListing`, `expireListing`, `buy` are the V4 shapes (selectors/topics asserted by `testV4ShapedSelectorsAndEventsAreUnchanged`). The floor is a separate public mapping. **No new event**: the indexer records unrecognized marketplace events as malformed.

## 7. Admin permissions and emergency behavior
Owner (intended: a Safe) can: `allowCollection` (requires code + ERC-165 for ERC-1155 and ERC-2981, `maxRoyaltyBps ≤ 1000`, `min ≤ max`), `disableCollection`, `setPaused`, two-step `transferOwnership`/`acceptOwnership`.
Owner **cannot**: withdraw AVAX or tokens (no such function; the contract has no `receive`/`fallback`), cancel/alter/seize a listing, change a floor, change the fee or fee recipient (immutable), change a seller's proceeds for a protected listing. Verified by tests (`testOwnerCannotAlterSellerProceedsOfAProtectedListing…`) and by the source tripwire (`src/lib/legacy-marketplace-consistency.test.js`, which pins the external surface and the owner-only set).
Effect of owner actions: pause / disable / narrowing blocks `createListing*` and `buy` (liveness only). `cancelListing`, `expireListing`, `setMinSellerProceeds` keep working. Re-allowing a disabled collection revives its still-active listings. Raising the cap (≤ 10%) only widens what an **unprotected** listing tolerates.
Emergency: Safe calls `setPaused(true)` and/or `disableCollection(Genesis)`. There are no funds to recover (non-custodial; nothing retained between transactions).

## 8. Assumptions the auditor should challenge
1. **Reentrancy:** `buy` is `nonReentrant`; the listing is updated before any external call; external calls are the ERC-1155 transfer (buyer hook), then three AVAX payments (`fee recipient`, `royalty receiver`, `seller`). `createListing*`, `cancelListing`, `expireListing`, `setMinSellerProceeds` are *not* guarded and may be re-entered during a `buy` — reasoned harmless (no value flow; a mid-buy cancel acts on the already-decremented amount).
2. **External-call trust:** `balanceOf`, `isApprovedForAll`, `safeTransferFrom`, `royaltyInfo` come from the allowlisted collection. A hostile/upgradeable collection can only DoS its own market. `royaltyInfo` is read with a 100k gas cap and a fixed 64-byte buffer (inline assembly, scratch space 0x00–0x3f).
3. **Payout failure:** every payout failure reverts the whole sale (`TransferFailed`). A royalty receiver, seller or the fee recipient that rejects AVAX blocks that sale (and the fee recipient blocks all sales). No pull-payment fallback by design.
4. **Operator filter:** Genesis calls an OpenSea-style registry (`0x000000000000AAeB6D7670E522A718067333cd4E`) on `setApprovalForAll(operator)` and on `safeTransferFrom` by any non-owner operator. It currently allows all operators (registered, no filtered operators). Genesis's owner can change that; then `buy` reverts and listings go stale. The app and readiness script check `isOperatorAllowed`. No on-chain mitigation.
5. **Collection admin:** Genesis's owner (`0x284C…180a`, the same wallet as the royalty receiver) can raise the royalty (≤ 2,500 bps on Genesis), change the receiver, or filter the marketplace. Protected listings revert instead of paying less; the cap bounds unprotected ones.
6. **Unset listing ids:** `getListing`/`listingStatus` of a never-created id returns zero seller and `Status.ACTIVE` (enum default), as V4 does. Every mutator guards on `seller != 0`. Indexers must key on `ListingCreated`.
7. **Events:** `ListingSold.price` is the total, `ListingCreated.price` per unit; no event states remaining amount after a partial fill.
8. **Forced AVAX** (selfdestruct/coinbase) is stranded; nothing reads the balance.

## 9. Test and verification results (this candidate; commands run from the repo root)
| Kind | Command | Result |
|---|---|---|
| Unit + adversarial (Solidity) | `forge test` | **285 passed, 0 failed, 7 skipped** (6 = the pre-existing mainnet-fork claim suite; 1 = this candidate's fork suite; both skip without an RPC and are reported as skipped, not passed) |
| Fuzz, heavy | `FOUNDRY_FUZZ_RUNS=20000 forge test --match-path "test/LegacyCollectionMarketplace*.t.sol"` | **47 passed, 0 failed, 1 skipped** (the skipped one is the fork suite) |
| Local fork of real mainnet state (**nothing broadcast**) | `MAINNET_FORK_RPC=https://api.avax.network/ext/bc/C/rpc forge test --match-path test/LegacyCollectionMarketplaceMainnetFork.t.sol` | **6 passed** — real Genesis holder lists, second account buys, exact 2.5/5/92.5; ids 0–3 sell, id 4 refused; real Genesis owner raising royalty to 7% reverts a protected purchase; V4 still refuses Genesis. *Fork results are not production evidence.* |
| App / API / indexer / manifest consistency | `npx vitest run` | **1918 passed, 60 skipped** (180 files passed) |
| Lint | `npx eslint .` | exit 0 |
| Production builds | `npx vite build` · `VITE_RELEASE_NETWORK=mainnet VITE_MARKETPLACE_CHAIN_ID=43114 VITE_MARKETPLACE_ADDRESS=0x0e77…F8f5 VITE_MARKETPLACE_FEE_BPS=250 npx vite build` | both succeed |
| Read-only readiness (live mainnet RPC) | `node scripts/verify-legacy-marketplace.mjs` | 9 PASS (V4 registry/fee; Genesis ERC-165s, not factory-registered, royalty 500 bps ≤ cap for ids 0–3); reports **NOT DEPLOYED**, exit 2 |
| Owner/deployment dry run | `node scripts/prepare-legacy-marketplace-deployment.mjs` | prints parameters and hashes; **BLOCKED, exit 3** (no owner Safe) |
| Preview deployments | Vercel previews `the-void` and `the-void-vercel-mainnet` for PR #229 | built and Ready on every pushed commit (they build the app; they do not exercise the contract) |
| **Live mainnet evidence** | — | **None. No deployment, listing, purchase or settlement exists.** |
Mutation checks (tests fail when the logic is removed): seller-floor check removed → 3 tests fail; royalty-cap check removed → 2 fail (incl. a fuzz counterexample); fee changed 250→200 → 14 fail; an owner `sweep()` added → 3 source-tripwire tests fail.
AI reviews (not human audits): adversarial review of the contract on 2026-10-20 — no critical/high; two hardenings applied (full-quantity validation, bounded `royaltyInfo` read).

## 10. Deployment, rollback and post-deployment verification (all steps need explicit authorization)
1. Supply the owner Safe → run `OWNER_SAFE_ADDRESS=0x… node scripts/prepare-legacy-marketplace-deployment.mjs` → review output; operator confirms Safe identity out of band.
2. Complete the human audit; resolve findings; re-run section 9 on the final commit; re-record the hashes.
3. Deploy `LegacyCollectionMarketplace(feeRecipient, 250, ownerSafe)` through the repo's approved-plan process (`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`); never the deployer as owner.
4. Safe executes `allowCollection(Genesis, 500, 0, 3)`.
5. Verify source and compare bytecode; read back `owner()`, `feeRecipient()`, `platformFeeBps()`, `deploymentChainId()`, `getCollection(Genesis)`, `paused()`.
6. One reviewed PR sets `deployed: true`, `marketplaceAddress`, `deploymentBlock`, `ownerAddress`, `record`. `node scripts/verify-legacy-marketplace.mjs` must exit 0.
7. Deploy app/API/indexer from that commit. Run the mainnet acceptance procedure in `docs/GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md` (real holder lists with a floor, second account buys, balances and fee/royalty settle exactly, failed purchase moves nothing, plain transfer works, V4 trading re-verified) and record every transaction hash.
8. Rollback: `setPaused(true)` / `disableCollection(Genesis)` from the Safe; revert the manifest PR (`deployed:false`) to hide the UI. Sellers keep `cancelListing`. Redeploy a fixed contract if a bug is found; repoint the manifest.

## 11. Auditor checklist
- [ ] Reentrancy across all entry points during `buy` (hooks of buyer/seller/royalty receiver/fee recipient).
- [ ] Seller-floor invariant under partial fills, rounding, price × quantity overflow, and royalty changes.
- [ ] Royalty read: assembly correctness, gas cap, buffer reuse, dirty bits, receiver validation.
- [ ] Owner power surface vs section 7; two-step ownership; effect of re-allowing a collection.
- [ ] Atomicity: any revert after the listing update restores all state.
- [ ] `ListingSold`/`ListingCreated` event semantics for indexers; unset-id semantics.
- [ ] Operator-filter interaction; stale-listing handling.
- [ ] Whether to remove the unprotected `createListing` overload.
- [ ] Gas / griefing: unbounded loops (none), external call gas.
- [ ] Mainnet fork reproduction of the rehearsal in section 9.

## 12. Blockers before deployment
1. **Owner Safe address — BLOCKED** (not in the repo; will not be invented).
2. **Human security audit** — not started; findings must be resolved.
3. **Default seller tolerance in the UI** — currently 0 (any royalty increase blocks a sale); a product choice, not a code blocker.
4. **Explicit deployment authorization** and funded wallets for the mainnet acceptance run.
