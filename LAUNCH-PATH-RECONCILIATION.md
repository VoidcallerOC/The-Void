# Launch-path reconciliation: primary-sale fee fix without breaking Genesis (2026-10-21)

STATUS: PARTIAL. Audit, reconciliation and plan only. Nothing deployed, signed, broadcast, merged or migrated.
Builds on `MARKETPLACE-COMPATIBILITY-AUDIT.md`. Its root cause still holds; no new evidence contradicts it.

Evidence tiers used below: **repo** (source on `main` at `5324606`), **local** (Foundry/vitest/anvil),
**fork** (local fork of live state), **live** (read-only RPC, explorer, production HTTP).

## A. Decision: Option B (corrected factory)

| Criterion | A: settled sale per release on the existing factory (#231) | B: `VoidReleaseFactoryV2RoyaltySettled` (#234) |
|---|---|---|
| 2.5% pushed at purchase, 97.5% claimable, atomic revert | Yes (local, fork) | Yes (local, fork) |
| Genesis | Untouched | Untouched |
| Marketplace | Existing `0x0e77…` accepts (fork PASS) | Needs one new `ReleaseMarketplaceV4` instance (existing code) |
| New deployments | 1 sale per release, forever | 2, once (factory + marketplace) |
| Extra artist actions per release | Deploy-time `grantRole` + `revokeRole` + reconfigure, every release | None beyond today's create/edition/configure |
| Production config changes | One `INDEXER_CONTRACTS_JSON` env entry per release | Manifest swap once |
| App support today | **Missing.** The buyer and Studio paths use the factory-registered sale: `verifyReleaseSaleBinding` (`src/lib/release-sale-binding.js`) refuses any sale that is not `factory.primarySaleOf(release)`, and `factory_releases.primary_sale_address` comes from `ReleaseCreated`. A satellite sale is only understood by the Earnings view. | **Present.** Indexer adds each `ReleaseCreated` sale as `PRIMARY_SALE` with `PlatformPaid` decoding; frontend routes per factory; Earnings verifies the sale (anvil: masked code hash matches, `authorized: true`) |
| Risk to existing release | None on chain if not applied to it; F&F sale is already sold out/expired | None |
| Window of fee bypass | Until the artist revokes the old sale's `ISSUER_ROLE`, that sale still mints at the credit model | None from the factory; the artist-as-admin bypass exists in both |
| Rollback | Per release, by the artist | Revert the manifest; the old pair keeps working |

**Why B:** A costs one deployment and three artist transactions per release, needs a production env change per
release, and the app's buy and Studio paths would need new code to use a sale the factory did not register.
B is two one-time deployments of reviewed code, after which every release settles correctly with no extra steps,
and the app already supports it.

## B. Genesis status

| Requirement | Status | Evidence |
|---|---|---|
| Visibility | **VERIFIED** (code in production) | `src/data.js`; production bundle of `thevoidstudio.xyz` (Vercel project `the-void-vercel-mainnet`, `VITE_RELEASE_NETWORK=mainnet`) contains `0xd1b4…98ee` 6 times. Page rendering not screenshot-checked. |
| Collection identity | **VERIFIED** | live: 45-byte EIP-1167 proxy, code hash `0xe722…0ed9`; `factory.isRelease(Genesis)=false` |
| Claims | **UNVERIFIED** as a live feature | live: the F&F release's only `RoleGranted` logs are from its creation (artist roles + old sale as issuer); no `GenesisHolderClaim` is authorized on mainnet. Code composes with the corrected factory (new local test, below). |
| Resale | **NOT DEPLOYED** | `config/legacy-collection-marketplace.json` `deployed: false`, `marketplaceAddress: null`; fork `testExistingV4MarketplaceStillRefusesGenesis` PASS on live state |
| Launch-blocking | **NO** | Genesis resale has never existed in the app (planned, separate `LegacyCollectionMarketplace` deployment). The fee fix changes nothing Genesis uses. A Genesis claim on the replacement release is an optional, separately authorized step (checklist 9). |

## C. Deployment and configuration requirements

| # | Item | Class |
|---|---|---|
| 1 | Repo: make `scripts/deploy-release-per-contract-mainnet.mjs` plan `VoidReleaseFactoryV2RoyaltySettled` (it hard-codes `VoidReleaseFactoryV2Royalty`, lines 24, 209, 221, 275), keeping its runtime-vs-artifact checks | **Required** (code change, needs a PR) |
| 2 | Deploy `VoidReleaseFactoryV2RoyaltySettled(0xb65C…1ce4)` | **Required** (owner signs) |
| 3 | Deploy `ReleaseMarketplaceV4(0xb65C…1ce4, 250, <factory from 2>)` | **Required** (owner signs) |
| 4 | Manifest: new pair active; current pair (`0x262B…`, `0x0e77…`, impl `0x8064…`, blocks 97619965/97619978) moved verbatim to `historicalDeployments` | **Required** (PR) |
| 5 | Redeploy API/indexer (Render) and web (Vercel) from the manifest commit | **Required** |
| 6 | `VITE_MARKETPLACE_ADDRESS` | **Unnecessary** to change: routing works with either recorded marketplace (tested) |
| 7 | DB migration for the fee fix | **Unnecessary** (040/041 already on `main`; production apply status not checked here) |
| 8 | PR #236 archive migration 042 (DB status only; contract, token, purchases untouched) | **Optional**, owner decision, separate |
| 9 | Artist: create the replacement release in Studio (create, edition, `configureSale`) | **Required** for a replacement; no extra steps vs today |
| 10 | `GenesisHolderClaim` for the replacement release + artist `grantRole(ISSUER_ROLE, claim)` | **Optional** (only if the Genesis claim is part of this launch) |
| 11 | `LegacyCollectionMarketplace` deployment (Genesis resale) | **Optional / out of scope** |
| 12 | Option A satellite sale on F&F | **Unnecessary** (F&F sale sold out and expired) |

## D. Existing release impact

No existing contract or token changes. Live at block 98102763: F&F `0x9aa6…d103` `name()="Forgive & Forget"`,
`factory.releaseAt(0)`, `primarySaleOf = 0x6ae8…9aA3`, ISSUER held by that sale only. The sale holds 0.00625 AVAX,
which is exactly the platform's credit; the artist's credit is 0 (withdrawn since `PAYMENT-FIX-ACTIVATION.md`
recorded 0.24375). Only the platform wallet can move its credit. Genesis code unchanged.

## E. Test evidence

| Command | Result |
|---|---|
| `forge test --match-contract "GenesisHolderClaimSettledRelease\|MarketplaceMultiCollection\|VoidReleaseFactorySettled\|GenesisHolderClaimRoyaltyRelease"` | 25 passed, 2 skipped (fork) |
| `forge test` | 349 passed, 19 skipped, 0 failed |
| `MAINNET_FORK_URL=MAINNET_FORK_RPC=publicnode forge test --match-path "test/*Fork*.t.sol"` | 18 passed, 3 failed, 6 skipped. Failures: RPC "block not found" ×2, "missing trie node" ×1 |
| same, `SettledSaleMainnetFork` with `MAINNET_FORK_BLOCK=98103312` | 8 passed, 1 failed (`testPinned_HistoricalStateAtThePurchaseBlock`: needs an archive RPC; **UNVERIFIED**) |
| `GenesisHolderClaimMainnetFork` | 6 skipped by design (live edition exists) |
| `npx vitest run` | 2022 passed, 87 skipped, 0 failed |
| `npx eslint .` | exit 0 |
| anvil: corrected factory → `createRelease` → `verifyAuthorizedSale` | masked hash matches `SETTLED_SALE_RUNTIME_CODE_HASH`; `authorized: true`, kind `settled-satellite` (shown as "Settled sale") |
| live `/api/health/ready` (mainnet API) | indexer tracks exactly `0x0e77…` MARKETPLACE, `0x262b…` RELEASE_FACTORY, `0x6ae8…` PRIMARY_SALE, `0x9aa6…` ERC1155 |
| live web bundle `thevoidstudio.xyz` | `VITE_MARKETPLACE_ADDRESS=0x0e77…`, chain 43114, fee 250, manifest `0x262B…`/`0x0e77…` |

New coverage this round: `test/GenesisHolderClaimSettledRelease.t.sol` (3): the unchanged claim composes with a
corrected-factory release and settled sale; the free claim moves no AVAX; public purchases push 2.5% and credit
97.5%, which the artist withdraws; a claimed token resells 95/2.5/2.5 on the corrected marketplace.
Requirement map: 1–3, 9 (`VoidReleaseFactorySettled`, `MarketplaceMultiCollection…`, new claim test); 4 (fork
Genesis-balance tests, new claim test); 5 (fork `testExistingV4MarketplaceStillRefusesGenesis`, Genesis-like
refusal); 6–8, 10 (`MarketplaceMultiCollection…`, `release-deployments-corrected-factory.test.js`); 11 (vitest +
live readiness and bundle); 12 (fork `testNewFactoryLeavesTheExistingRelease…`, live reads).

Unresolved live checks: pinned historical fork (archive RPC); production DB state of migrations 040/041; whether
`GENESIS_CLAIM_ENABLED` is set on the mainnet API (env not read).

## F. Ordered launch checklist (every signing step is owner-authorized)

1. **Deploy tooling PR** (C1). Gate: plan tests pass; plan shows the settled factory artifact and `0xb65C…`. Rollback: none needed.
2. **Deploy factory** (C2). Gate: runtime == artifact; `platformRecipient()==0xb65C…`; `implementation()` has code. Rollback: unused contract is inert; do not record it.
3. **Deploy marketplace** (C3), after 2. Gate: `registry()==new factory`, `platformFeeBps()==250`, `feeRecipient()==0xb65C…`, `deploymentChainId()==43114`, runtime == artifact. Rollback: as 2.
4. **Manifest PR** (C4), after 3. Gate: `release-deployments-corrected-factory.test.js` re-pointed at the real addresses and blocks; `release-network-mainnet` tests; CI green. Rollback: revert the commit.
5. **Redeploy API/indexer, then web** (C5), after 4. Gate: `/api/health/ready` lists both factories and both marketplaces at their deployment blocks; bundle carries the new manifest; F&F still resolves to `0x0e77…`. Rollback: redeploy the previous commit.
6. **(Optional) #236 archive** (C8). Gate: owner decision; reversal SQL in the migration. Independent of 1–5.
7. **Artist creates the replacement release** (C9), after 5. Gate: `factory.primarySaleOf(release)` is a `VoidPrimarySaleSettled` with ISSUER as the only minter; Studio binding verifies; Earnings shows "Settled sale". Rollback: artist `configureSale(..., paused = true)`; the contract stays.
8. **First controlled purchase**, after 7. Gate: in the same tx, platform wallet +2.5% and `PlatformPaid`; `balances(artist)` = 97.5%; indexer rows. Rollback: pause the sale.
9. **(Optional) Genesis claim** (C10), before the sale's start time. Gate: same checks as `GenesisHolderClaimSettledRelease.t.sol` on chain. Rollback: claim admin `pause()`; artist revokes ISSUER.
10. **Controlled resale** on the new marketplace. Gate: 95/2.5/2.5, buyer owns the token, listing indexed under the new marketplace. Rollback: cancel listing.

## G. Launch status and deployment readiness (updated 2026-10-21 01:50 UTC)

Canonical checklist. States: code complete → tests complete → review complete → deployment authorized →
deployed → activated → launch verified. Nothing below is past "tests complete".

| Gate | Requirement | State | Evidence |
|---|---|---|---|
| A. Code approval | #237 and #238 reviewed, CI green | **Waiting on owner review** | #237 CI green at `57e5135`; #238 head `a64b84e` (CI running at time of writing) |
| B. Deployment-plan approval | Fresh plan from the approved commit, committed to `deploy/mainnet/approved-plans/` by PR; merge = approval | NOT STARTED (follows A) | Provisional plan below |
| C. Funding | Deployer funded with headroom | **Met by an owner action** (not this agent) | Deployer `0xaBd3…c174` received 0.39679 AVAX from the artist wallet `0x284C…180a`, block 98105278, tx `0x7157a415baf0…`; live balance 0.396793622 AVAX ≥ 0.0521 required |
| D. On-chain deployment | Owner signs steps 1–2 in Rabby | NOT STARTED | — |
| E. Activation | Manifest PR + API/indexer/web redeploy | NOT STARTED | — |

**Provisional plan** (read-only dry run from `a64b84e` against live C-Chain at block ~98105872;
addresses are CREATE predictions, valid only while the deployer's nonce stays 3; not an approved plan):

| Step | Nonce | Contract | Constructor | Predicted address | Gas limit | Creation data hash |
|---|---|---|---|---|---|---|
| 1 | 3 | `VoidReleaseFactoryV2RoyaltySettled` | `platformRecipient = 0xb65C…1ce4` | `0xE744D58fA8138042f5f00a28d39f89081539C19B` (implementation `0x36c5D31e9A8e9b4dc9F8CB4B7202C70b3E30734D`) | 6,535,412 | `0x3230f78c…1f9e` |
| 2 | 4 | `ReleaseMarketplaceV4` | `0xb65C…1ce4, 250, 0xE744…C19B` | `0x75964C44cA586b13e98e7c30E74d2B4114f65b06` | 1,802,318 | `0xcc17294c…26d6` |

Artifacts: factory init code hash `0xdf03ecde…0f6e`; settled sale init code hash `0xebe5749b…f012`, reviewed
runtime hash `0x0b6a2a7e…de12`; implementation runtime `0x52dc13a5…dec0`; marketplace init code hash
`0x7c63f9e7…b58a` (the same artifact as the live `0x0e77…`). Estimated cost 0.0347 AVAX at 5 nAVAX max fee;
0.0521 AVAX with headroom. Every plan check passes except the two recipient rows, which stay UNVERIFIED by
design until the owner reads the address on the Nano S Plus.

**Guards added in #238:** the factory must embed the exact reviewed `VoidPrimarySaleSettled` creation code
(an unrelated `PlatformPaid` signature does not satisfy it) and must not embed `VoidPrimarySale`; a new
approved plan for any factory other than `VoidReleaseFactoryV2RoyaltySettled` is refused. The executed plan
for `0x262B…` cannot authorize a new deployment (used nonce, occupied address, binding mismatch; tested).

**Containment after deployment:** contracts cannot be removed. Before activation, nothing routes to them
(the manifest decides). After a replacement release exists, the artist can pause its sale with
`configureSale(..., paused = true)` (`VoidPrimarySaleSettled.configureSale`, artist-only). Rollback of
activation = revert the manifest commit and redeploy services; the original pair keeps working throughout.

## H. Forgive & Forget release completion (updated 2026-10-21 09:20 UTC)

| Item | State | Evidence |
|---|---|---|
| Original release in production | PUBLISHED (release `release-83611741…`, edition `edition-6e35…` published, open edition) | Supabase "The Void Mainnet", read-only queries |
| Original sale on chain | Sold out and ended: `maxSupply` 1, `sold` 1, price 0.25 AVAX, `endTime` 1792489200, not paused | `sales(tokenId)` on `0x6ae8…9aA3`, block ~98106k |
| Existing holder | `0x6a86…d2fb`, balance 1 (tx `0xca613e8b…`, block 98046247); `primary_purchases` row FINALIZED, 0.25 AVAX | `balanceOf`, DB |
| Retirement | **#239** (draft): read-side withdrawal, supersedes #236's archive (archive would cut the holder's protected media and hide the replacement draft in Studio) | `server/media-gateway.js:86`, `retiredByArchivedTitle`; tests in #239 |
| Replacement record | Draft `release-273f5476…` (`forgive-forget-2`), title "Forgive & Forget", same artwork CID, no editions, no contracts. Stored as `EP`; original was `SINGLE` (**owner decision**) | DB |
| Release key | Stale key in the draft is recomputed for the active factory at provisioning (no request exists) | `server/studio-service.js` 519–528 |
| Source media | Artwork `ipfs://bafybeidbhen…qqv4i` (image/png, Pinata 206); preview `ipfs://bafybeiaoy7h…rgd4` (audio/mpeg, 206); full track `asset-155971a7…` (WAV, 65,861,868 B, sha256 `39707a09…`); demo `asset-20e0b78d…` (MP3, 4,007,809 B, sha256 `4ba8386b…`) | `release_metadata`, `media_assets`, gateway range requests |
| Media on the replacement | NOT STARTED. Studio re-attaches already-registered private files (PR #220); needs the artist's Studio session after activation | — |
| Production migrations 040/041 | Applied | `schema_migrations` |
| Sale schedule / first-user test for the replacement | **Not recorded** in the repo or DB. Edition settings (supply, price, window, per-wallet limit) for the replacement are owner decisions. No private purchase will be made through deployed contracts | — |
