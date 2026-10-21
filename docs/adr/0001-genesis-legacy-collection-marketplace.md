# ADR 0001 — Marketplace for legacy ERC-1155 collections (Genesis)

Status: AUDIT CANDIDATE (scope confirmed 2026-10-20; not deployed; needs the owner Safe address, a human security audit and explicit deployment authorization). Audit package: `docs/GENESIS-MARKETPLACE-AUDIT-PACKAGE.md`.
Date: 2026-10-20 (fee policy amended 2026-10-21)

## Amendment 2026-10-21 — Genesis pays no platform fee (owner decision, supersedes the 250 bps fee below)
**Genesis resale: 0% platform fee / full existing 5% royalty / 95% seller at the current royalty rate.** The contract now has no
fee recipient and a constant `platformFeeBps = 0`; the constructor takes only the owner. Genesis's ERC-2981 royalty is honored in
full and is not changed (no `setRoyaltyInfo` call). New factory releases keep 2.5% platform / 2.5% artist royalty / 95% seller on
`ReleaseMarketplaceV4`, unchanged. Exact contract delta and the widened M-1 note: audit package §0. Statements below that cite a
250 bps legacy fee, a legacy fee recipient or a 92.5% seller share are historical.

## Context (verified on Avalanche C-Chain 43114 by `eth_call` at the time of writing)
- Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` is an EIP-1167 clone (45-byte runtime) of
  `0x2e61967a569bc18affc5e1b9f71e00af93a268c7`, source `ERC1155SingleBundle` (Joepegs Launchpeg), compiler 0.8.13.
  Etherscan reports it verified; I did **not** rebuild it and diff against runtime bytecode.
- ERC-165 reports ERC-1155 and ERC-2981 true. It has **no** `royaltyBpsOf` / `payoutOf` and is not factory-registered.
- `royaltyInfo(id, 1e18)` returns receiver `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` and `5e16` for tokens 0–3 and also for
  unminted id 7: **500 bps (5%)**, one contract-wide default. It is owner-mutable (`setRoyaltyInfo`, cap 2,500 bps).
  (The first root-cause note wrongly said 250 bps; this corrects it.)
- Genesis `owner()` is the same `0x284C…180a`. `paused()` is false.
- Genesis enforces an operator filter on `safeTransferFrom`/`safeBatchTransferFrom` when `from != msg.sender` and on
  `setApprovalForAll(operator)`: registry `0x000000000000AAeB6D7670E522A718067333cd4E`. It is registered for Genesis with no filtered
  operators, so any operator is currently allowed (`isOperatorAllowed(Genesis, V4 market) = true`). The Genesis owner can change this.
- `ReleaseMarketplaceV4` `0x0e77…F8f5` is immutable with no owner or allowlist; its registry, 250 bps royalty policy and
  `royaltyBpsOf`/`payoutOf` reads are fixed. Fee 250 bps, fee recipient `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`.

## Options
1. **Extend V4** — impossible: nothing is upgradeable or configurable. Rejected.
2. **Wrapper/adapter token for Genesis** — custody or restricted transfers of holders' assets. Rejected (traps tokens).
3. **Frontend/indexer-only workaround** — cannot make V4 accept Genesis, and would hide a failing transaction. Rejected.
4. **New, separate marketplace with an explicit collection allowlist** — chosen. V4 and the factory-release trust boundary are untouched.

## Decision: `LegacyCollectionMarketplace`
- Non-custodial: the seller keeps the tokens; the marketplace is an approved operator and moves them only inside `buy`.
- Immutable: fee 250 bps, fee recipient, chain id. No upgrade proxy, no arbitrary-call, no fund-withdraw function.
- Owner powers (intended: a Safe): allow a collection with `{maxRoyaltyBps ≤ 1000, tokenId range}`, disable a collection, pause,
  two-step owner transfer. A disabled collection or a pause blocks new listings and purchases, never cancellations.
  The owner cannot move listings, tokens or AVAX.
- Allowing a collection requires code, ERC-165 ERC-1155 and ERC-2981 support. Being ERC-1155/2981 alone grants nothing.
- Settlement in AVAX: `fee = ⌊price·250/10000⌋`; `(receiver, royalty) = token.royaltyInfo(id, price)` read at sale time through
  a bounds-checked `staticcall`; `royalty ≤ price·maxRoyaltyBps/10000`, receiver non-zero when royalty > 0, `fee+royalty ≤ price`;
  `seller = price − fee − royalty` (seller takes rounding dust). Any failed transfer reverts the whole sale, so the buyer never keeps
  the NFT while a payout is unpaid. The royalty percentage is **taken from Genesis, not hardcoded**; the cap only protects
  sellers if the Genesis owner raises the royalty later.
- Proposed Genesis scope: token ids 0–3, `maxRoyaltyBps = 500` (the verified current royalty). Owner decision required.
- Keeps V4's `cancelListing/expireListing/buy/getListing` signatures and all event shapes so the indexer and frontend reuse their decoders.
  The V4-shaped `createListing` was deliberately **not** kept (see "Resolutions, second round").

## Residual risks (must be accepted or mitigated before deployment)
- Operator filter: if the Genesis owner starts filtering this marketplace, `buy` reverts and listings go stale. Readiness check
  `isOperatorAllowed` is added; no on-chain mitigation exists or is attempted.
- Genesis owner can raise royalty up to the cap-exceeding level → purchases revert until the royalty is lowered or the cap raised.
- Royalty receiver that rejects AVAX blocks sales of Genesis (reverts by design; no silent skip).
- Platform fee recipient `0xb65C…1ce4` rejecting AVAX would block every sale; it is an EOA/Safe controlled by the platform.
- Not independently audited.

## Independent review (AI subagent, adversarial, contract only) — 2026-10-20
Not a substitute for a human audit. No critical/high findings; no path found where a buyer keeps tokens with an unpaid payout,
where funds strand, or where the owner can take funds/tokens/listings.
- Applied: listing is validated at the full `price × amount` as well as per unit; the `royaltyInfo` read is capped at 100k gas with a
  fixed 64-byte return buffer (test: `testListingValidatedAtFullQuantityAndGasGriefingRoyaltyIsBounded`).
- Accepted/documented (design): the collection's own admin can raise the royalty up to the cap or change its receiver between listing
  and sale (seller proceeds fall; the buyer always pays exactly `price × quantity`), or break `royaltyInfo` to freeze that collection's
  sales; the marketplace owner can freeze (pause/disable/narrow) but not alter or take; re-allowing a disabled collection revives its
  still-active listings (sellers should cancel when a collection is disabled); `feeRecipient` is immutable and must be able to receive
  AVAX (`0xb65C…1ce4` has no contract code on mainnet, i.e. it is an EOA); `listingStatus`/`getListing` of a never-created id reads
  `ACTIVE` with a zero seller, as in V4 — indexers must key on the `ListingCreated` event, not on `listingStatus` alone; `ListingSold.price`
  is the total while `ListingCreated.price` is per unit; the `RoyaltyTooHigh` branch is unreachable (cap ≤ 10% + 2.5% fee).
- Seller minimum-proceeds guard: built afterwards (see "Seller minimum-proceeds guard" below), which closes the royalty-change exposure noted above.


## Royalty policy — verified, kept separate (2026-10-20)
| Asset | Royalty | Receiver | Source of truth | Evidence |
|---|---|---|---|---|
| Genesis `0xD1B4…98eE` tokens 0–3 | **5.0% (500 bps)** | `0x284C09a7…180a` | Genesis's own ERC-2981 `royaltyInfo` | Launchpeg initializer hardcodes `_setDefaultRoyalty(initData.royaltyReceiver, 500)` ("Default royalty is 5%"); `eth_call` returns 5e16 per 1e18 for ids 0–3 (and 7); Etherscan logs show **no** `DefaultRoyaltySet` event on the proxy, i.e. never changed since launch. Owner can change it (`setRoyaltyInfo`, ≤ 2,500 bps). |
| New Void factory releases (`VoidReleaseFactoryV2Royalty` → `VoidRelease1155V4Royalty`) | **2.5% (250 bps)** | the edition's own artist payout | enforced on-chain at edition creation, again by `ReleaseMarketplaceV4` | `deploy/mainnet/README.md` "Economics (final)", `test/RoyaltyEnforcement.t.sol`, `test/MainnetEconomics.t.sol`, `config/mainnet-release-per-contract.json` (`artistRoyaltyBps: 250`) |
| Marketplace fee — V4 (factory releases) | 2.5% (250 bps) | `0xb65C575C…1ce4` (no contract code: an EOA) | immutable in the V4 constructor | `ReleaseMarketplaceV4` |
| Marketplace fee — `LegacyCollectionMarketplace` (Genesis) | **0%** (amended 2026-10-21) | none | compile-time constant `platformFeeBps = 0`; no fee recipient | `LegacyCollectionMarketplace` |

**Finding:** the "2.5% artist royalty" policy is a policy for *new factory releases*. Nothing in the repo (code, tests, docs, config) states a Genesis royalty policy; Genesis simply carries the 5% default its launchpad gave it, paid to the creator wallet that is also its owner. The frontend carries no Genesis royalty copy beyond what this PR added.

Seller proceeds, 1 AVAX resale, by policy:
- Factory release (V4): fee 0.025, artist royalty 0.025, **seller 0.95**.
- Genesis (legacy marketplace): fee 0, creator royalty 0.05, **seller 0.95** (amended 2026-10-21; was fee 0.025 / seller 0.925).

**Inconsistencies found (documented, not "fixed"):** (1) the platform headline "2.5% artist royalty" is true of factory releases only; (2) my first root-cause note said Genesis was 250 bps — corrected to 500; (3) `docs/C-CHAIN-PRODUCTION-RUNBOOK.md` (superseded) calls the legacy collection "out of scope"; this ADR is the first place it is brought into the marketplace. No royalty percentage or recipient was changed anywhere to make these agree.

## Final settlement formulas (`LegacyCollectionMarketplace.buy`)
For a purchase of `q` units of a listing priced `p` per unit: `S = p·q` (must equal `msg.value`).
- Platform fee: **0** (amended 2026-10-21). Nothing is paid to the platform.
- `(receiver, royalty) = token.royaltyInfo(tokenId, S)` — read at sale time, 100k-gas-capped, exactly 64 bytes returned; `royalty ≤ ⌊S · maxRoyaltyBps / 10000⌋`; if `royalty > 0` the receiver is non-zero and not the marketplace.
- `seller = S − royalty`.
- Conservation: `royalty + seller = S` exactly; the seller absorbs rounding dust (floors favor the seller).
- Order: seller floor check → ERC-1155 `safeTransferFrom(seller → buyer)` → pay royalty → pay seller. Any revert undoes everything.

## Seller minimum-proceeds guard
- `minSellerProceedsPerUnit[listingId]` (wei, public getter). The purchase requires `seller ≥ minSellerProceedsPerUnit · q` using the *actual* `S`, fee and live `royaltyInfo` of that exact purchase; otherwise `BelowMinimumProceeds(seller, required)` and the whole transaction reverts (no token moved, no payment kept, listing unchanged).
- Per unit × quantity, so splitting or enlarging a purchase cannot dodge it; computed at purchase time, so a royalty change between listing and sale cannot undercut it. A receiver change alone does not change the seller's proceeds (only the royalty amount does).
- Set at `createListingWithMinProceeds(...)`; changed by the seller only via `setMinSellerProceeds(listingId, min)` (ACTIVE listings, also while paused). A floor above the unit price, or not deliverable at today's royalty for 1 unit and for the full remaining quantity, is refused (`MinProceedsTooHigh`) so a typo cannot silently freeze a listing.
- Recommended floor (what the app sends): `⌊p · (10000 − 250 − royaltyBps) / 10000⌋`. Because the contract floors fee and royalty, real proceeds are ≥ this value for every `q`, so a sale at today's royalty always clears it, and a royalty increase that would leave the seller below the floor makes the purchase revert (at ordinary prices every increase; at wei-scale prices rounding can absorb a very small one without taking the seller below the floor).
- **Compatibility:** `Listing`, `getListing`, `ListingCreated/Cancelled/Expired/Sold`, `cancelListing`, `expireListing`, `buy` are byte-for-byte the V4 shapes (selectors/topics asserted in `testV4ShapedSelectorsAndEventsAreUnchanged`). The floor lives in a separate mapping; **no new event** was added because the indexer records any unrecognized marketplace event as a malformed-event error. There is **no** V4-shaped `createListing`: `createListingWithMinProceeds` is the only creation function and the floor is mandatory. `encodeCreateListingWithMinProceeds` throws without a non-zero floor. Off-chain observers read the floor with the `minSellerProceedsPerUnit(listingId)` view.

## Confirmed scope and open decisions (2026-10-20)
Confirmed by the owner as the *implementation scope of the candidate* (not permission to deploy or change production):
1. Honor Genesis's existing ERC-2981 royalty of **500 bps (5%)**; no royalty percentage or recipient is changed.
2. Initial scope: Genesis token ids **0–3 only**.
3. Royalty cap: **500 bps**.
4. ~~Marketplace fee stays 250 bps; 92.5 / 5 / 2.5.~~ **Amended 2026-10-21:** platform fee 0; settlement 95% seller / 5% creator / 0% platform.
5. V4 untouched; ordinary ERC-1155 transfers untouched; explicit deployment gate retained (`deployed:false`).

Still open:
- **Owner Safe address — BLOCKED.** Not in the repo; not invented; the deployer wallet is not a substitute. Validate with `scripts/prepare-legacy-marketplace-deployment.mjs` once supplied, and confirm identity out of band.
- **Human security audit** — not started.
- **Seller tolerance** — zero tolerance is retained as the fail-safe default and is now explicit in the listing UI and docs; a nonzero tolerance would lower sellers' floors and is a product decision that has not been made. Not a blocker.
- **Deployment authorization** and funded wallets for the mainnet acceptance run.

## Known limitations and trust assumptions (final)
- Seller floor is only as good as the floor chosen: a seller who deliberately sets a tiny floor accepts any royalty up to the cap. The app never sends one. There is no way to create a listing without a non-zero floor.
- A seller can raise their own floor (to what is attainable today) while a buyer's transaction is pending; that purchase then reverts atomically and costs the buyer only gas.
- The collection's admin (Genesis owner `0x284C…180a`) can change the royalty (≤ 2,500 bps on Genesis), change the receiver, or filter the marketplace's operator address. None can take funds or tokens; the first lowers seller proceeds only until the seller's floor reverts the sale, and the cap bounds the royalty a seller who chose a very low floor can be charged.
- The marketplace owner (intended: a Safe) can pause, disable or re-scope a collection (liveness only); re-allowing a disabled collection revives its still-active listings.
- Royalty receivers, sellers and the fee recipient that reject AVAX block their own sale (reverts by design).
- Floors are validated against today's royalty for 1 unit and for the full remaining quantity; intermediate quantities are checked at purchase time.

## Resolutions, second round (2026-10-20)
1. **The V4-shaped `createListing` overload was removed.** Code-level evidence: it called the same `_createListing` as the protected path with a zero floor, so it enforced the allowlist, token scope, cap, seller authorization, balance, approval and settlement preview, but skipped the seller guard — an alternate path around the guard. It had no caller: the app used `encodeCreateListing` only for the V4 marketplace (guarded by `isLegacyMarketplace`), `scripts/rehearse-royalty-fuji.mjs` targets V4 on Fuji, and the contract is undeployed, so no external client can depend on it. `testTheV4ShapedCreateListingSelectorDoesNotExistAndCreatesNothing` and `testTheSingleCreationPathEnforcesEveryEssentialInvariant` pin the result; a source tripwire fails if a second creation path appears.
2. **The floor is mandatory (non-zero) for creation and updates**, so it can never be cleared. Consequence found by fuzzing: at about 1 wei the exact-rate floor is 0, so no valid floor exists; the app refuses such a listing and the contract refuses a zero floor.
3. **Seller tolerance:** zero tolerance retained as the fail-safe; the review screen shows the exact minimum per edition and in total, says the royalty is set by the collection and that the listing stays unsold until cancelled and relisted if the royalty rises; the floor signed is the one reviewed (the app aborts if the royalty changed since).
4. **Second independent AI review** (fresh agent, 25 PoC tests, not committed): no critical/high/medium. Closed in code: payment-without-delivery (`TokensNotDelivered` check; `SelfPurchase` refused so the check is sound) and `listingStatus` reading `ACTIVE` for unknown ids (`UnknownListing`). Documented, not changed: forced AVAX, policy changes stranding listings, chain-id gating of `cancelListing`, gas-dependent `royaltyInfo` from a hostile allowlisted collection, fee-recipient payability, wash trading from a second wallet. A malicious allowlisted token can still lie about `balanceOf`; the allowlist remains a trust boundary.
5. Full evidence, hashes and the auditor checklist: `docs/GENESIS-MARKETPLACE-AUDIT-PACKAGE.md`.
6. **M-1 (gas-dependent `royaltyInfo`) — PARTIALLY CONFIRMED, no contract change.** A deliberately hostile collection (threshold on `gasleft()`, cheapest delivery) pays a zero royalty for gas limits in a ≈7.9k band (121,150–129,050) — reproduced with real purchases. It cannot exceed the 500 bps cap, cannot take the seller below the floor (a lower royalty raises seller proceeds; the floor and the payouts use the same single read), and cannot cause a meaningful denial of service. The only party underpaid is the royalty receiver of the hostile collection, which the owner must allowlist first. With ordinary delivery costs the lever does not exist, and **Genesis is irrelevant** (immutable EIP-1167 clone, deterministic storage-arithmetic `royaltyInfo`; 273 real purchases at distinct gas limits pay exactly 5%/92.5%). Rejected: the two-call check (it accepts the attack value) and a gas gate (it moves the lever to access-list warmth). A pinned/minimum royalty closes it but changes the confirmed Genesis scope and is left as an auditor/owner decision. Adopted: allowlist vetting rule + a sampled invariance check in the readiness script. Evidence: `docs/GENESIS-MARKETPLACE-AUDIT-PACKAGE.md` §8a.
