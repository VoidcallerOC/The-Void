# Forgive & Forget sequential-ID launch: irreversible steps for owner approval

Prerequisites 0.1–0.3 and steps 1–3 are **COMPLETE**; step 4 is **PARTIAL** (the switch PR is open, not merged);
steps 5–10 are **NOT STARTED**. Nothing has been switched or migrated. Each step needs the owner's explicit approval; the
deployer only ever created the two contracts, and every release action is signed by the artist wallet.

| Role | Address |
|---|---|
| Deployer (contracts only) | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` |
| Platform fee recipient (Nano S Plus, passive) | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` |
| Artist wallet (releases, editions, sale) | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` |
| Production factory kept in the new marketplace | `0x262B774cf9a1949170B58E2d57F6189980FE757b` |
| Genesis collection (ids 0-3, royalty receiver = artist) | `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` |
| Current factory, retired for new releases (no holders on any of its 6 clones) | `0xE744D58fA8138042f5f00a28d39f89081539C19B` |
| Existing marketplace, kept for its open listings (listing 1: Genesis token 0) | `0x75964C44cA586b13e98e7c30E74d2B4114f65b06` |

Rehearsed on a local fork of C-Chain (nothing broadcast): `MAINNET_FORK_RPC=https://api.avax.network/ext/bc/C/rpc forge test --match-path test/SequentialLaunchMainnetFork.t.sol`
(token 1, settled sale, purchase, resale 2.5/2.5/95, provenance anchor, both marketplaces, live Genesis listing 1).

## 0. Prerequisites

| # | Step | Status | Detail |
|---|---|---|---|
| 0.1 | Fund the deployer | COMPLETE | The owner sent 0.34914248576834783 AVAX in `0xbb926dbb4b6696a1899201765008af32ab2ac1e9880ff97b3268d45c083c2a1c` (block 98363910). Balance 0.349163505768347828 AVAX at nonce 6; the plan requires 0.056123769084133278 AVAX (gas estimate plus 50% headroom): PASS. |
| 0.2 | Merge the code PR | COMPLETE | PR #278 merged by the owner on 2026-10-23 at 20:13:17Z as `7d8485848cf408ad7506d0784d1d0c9e192b35f3` (CI green on its head `b15ba36a72429132d7ac413aa2f777bdf4167e5f`). Inert until 0.3–5. |
| 0.3 | Approval PR (merge = approval of the two exact transactions) | COMPLETE | PR #279 merged by the owner on 2026-10-23 at 20:50:54Z as `63e4889e4a029713fcc5df8e320ba56185710ab8`. Key-less plan from live C-Chain with `RELEASE_FACTORY_PROFILE=sequential` (`npm run deploy:release-per-contract:mainnet` with `DEPLOY_NETWORK=mainnet EXPECTED_DEPLOYER_ADDRESS=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174 EXPECTED_DEPLOYER_NONCE=6 RELEASE_PLATFORM_RECIPIENT=0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`), bound to `7d8485848cf408ad7506d0784d1d0c9e192b35f3` (digest `c025c2364f5146edf768d9b668da97ee61f89537059a1d9311caffd676e7b1fe`) in `deploy/mainnet/approved-plans/release-per-contract-mainnet.json`. The executed plan for `0xE744D58fA8138042f5f00a28d39f89081539C19B` is kept in `executed-plans/`. Live checks at block 98365376: every check PASS except *platformRecipient verified* and *marketplaceFeeRecipient verified*, which stay **UNVERIFIED** until the owner confirms `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` on the Nano S Plus. Both creation-data hashes equal the provisional dry run's. |

## 1. Deploy the factory — signer: deployer, in Rabby, on `/owner-deploy`

**COMPLETE:** `0xac4b33067500783a6d0b23fb934f1187a57ee17caea279b91d60af1fbaa1aeb3`, block 98367434, status 1, nonce 6,
gas used 5,414,336. Factory created at `0xEa0c345cE84025b4e8462d145100dce1848254B4`, implementation at
`0x4409913aC043E1772b1b7Ff2D5F8CE31868F9ddA`; creation data hashes to the approved value; runtime code matches the
artifacts (immutables masked) and every expected value below reads back on-chain.

- **Transaction:** contract creation, nonce 6, value 0, `VoidReleaseFactoryV4Sequential(platformRecipient = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4)`.
- **Predicted:** factory `0xEa0c345cE84025b4e8462d145100dce1848254B4`; its constructor creates the implementation `VoidRelease1155V6Sequential` at `0x4409913aC043E1772b1b7Ff2D5F8CE31868F9ddA` (factory nonce 1).
- **Creation-data hash (approved plan):** `0x0fd69956814dcec0a10b0202204b7bcd1e540ebb7aa0e22cb4d0b624c3ffa493`.
- **Expected:** `RELEASE_VERSION() == 4`, `PLATFORM_FEE_BPS() == 250`, `REQUIRED_ROYALTY_BPS() == 250`, `platformRecipient() == 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`; implementation `IMPLEMENTATION_VERSION() == 6`, `nextTokenId() == 1`, `tokenIdFor(0x0, bytes32(1)) == 1`, `REQUIRED_ROYALTY_BPS() == 250`, `platformFeeRecipient() == 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`; runtime code equals the compiled artifacts.
- **Verify:** the page checks these itself (`scripts/mainnet-onchain-checks.mjs`); then Actions → *Verify mainnet deployment* (`release-per-contract-mainnet`, the hash). Manually: `cast call <factory> "RELEASE_VERSION()(uint16)" --rpc-url https://api.avax.network/ext/bc/C/rpc` and `cast call <implementation> "nextTokenId()(uint256)" …`.

## 2. Deploy the marketplace — signer: deployer, offered only after step 1 is verified

**COMPLETE:** `0x84b9d080361b925a8d7fc02510c2cb8de0c165f7d1e6e61c025cb10b762aae44`, block 98367443, status 1, nonce 7,
gas used 1,858,058. Marketplace created at `0x0F5930113Ec750d867741E05F302053472115eb2`; creation data hashes to the
approved value; runtime code matches the artifact (immutables masked); the six immutables, chain 43114, fees 250/250
and 0/500, `assetClassOf(0xD1B4367dd9f235f9ee61878019d66E31511E98eE, 1) == 2` (GENESIS) and the old clone's token
UNSUPPORTED (0) read back on-chain.

- **Transaction:** contract creation, nonce 7, value 0, `VoidUnifiedMarketplace(feeRecipient = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4, releaseFactory = <step-1 factory>, legacyReleaseFactory = 0x262B774cf9a1949170B58E2d57F6189980FE757b, genesisCollection = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE, genesisMaxTokenId = 3, genesisRoyaltyReceiver = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a)`.
- **Predicted:** `0x0F5930113Ec750d867741E05F302053472115eb2`. Creation-data hash (approved plan) `0x6fde9ed019ef23e5118ef6d79b1b5c1ec88d20de4e14b162fda4c31cd1c600d3`.
- **Expected:** those six immutables, `deploymentChainId() == 43114`, fees 250/250 (factory releases) and 0/500 (Genesis); `assetClassOf(0xD1B4367dd9f235f9ee61878019d66E31511E98eE, 1) == GENESIS`, `assetClassOf(<new clone>, 1) == FACTORY_RELEASE`, `assetClassOf(0xF9C48A2BBCeBA7577FF17A2eeD20Fcef70eA480d, <old id>) == UNSUPPORTED`.
- **Verify:** as step 1; `cast call <marketplace> "releaseFactory()(address)" …`.

## 3. Record the deployment — PR, no transaction

`npm run verify:mainnet -- --write-record` (or the workflow) writes `deployments/release-per-contract-mainnet-<factory>.json`;
the record PR also adds the executed plan under `deploy/mainnet/executed-plans/`. Merge = record accepted.

**COMPLETE:** `node scripts/mainnet-owner-signing.mjs verify --write-record` returned `VERIFIED` for both transactions and
wrote `deployments/release-per-contract-mainnet-0xEa0c345cE84025b4e8462d145100dce1848254B4.json`; the executed plan is
`deploy/mainnet/executed-plans/release-per-contract-mainnet-0xEa0c345cE84025b4e8462d145100dce1848254B4.json`. PR #280
merged by the owner on 2026-10-23 at 21:19:55Z as `558338dde255f1267eca43c6907e469d686072f7`. The on-chain fee
recipient is `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`; that this address is the owner's Nano S Plus rests on the
owner's device confirmation during signing.

## 4. Switch production to the new pair — config PR, then manual Render redeploys

**PARTIAL:** the switch PR is open as a draft, not merged. Production still serves `0xE744D58fA8138042f5f00a28d39f89081539C19B` /
`0x75964C44cA586b13e98e7c30E74d2B4114f65b06`.

**What the PR changes (configuration only, no contract or code change):**
- `config/mainnet-release-per-contract.json`: active factory `0xEa0c345cE84025b4e8462d145100dce1848254B4`, implementation
  `0x4409913aC043E1772b1b7Ff2D5F8CE31868F9ddA`, marketplace `0x0F5930113Ec750d867741E05F302053472115eb2`, deployment blocks
  98367434 / 98367443, `source: "VoidReleaseFactoryV4Sequential"`, `releaseVersion: 4`, `tokenIdScheme: "sequential"`,
  `record`. The `0xE744D58fA8138042f5f00a28d39f89081539C19B` pair moves verbatim to `historicalDeployments[0]` (ahead of
  `0x262B774cf9a1949170B58E2d57F6189980FE757b`). Only the top-level factory provisions new releases
  (`provisioningFactoryConfig` in `server/studio-service.js`, `assertReleaseFactoryV2Configured` in `src/lib/fuji-release.js`);
  historical entries carry no provisioning flag and stay readable, routable and indexed for the releases they hold.
- `config/unified-marketplace.json`: new listings go to `0x0F5930113Ec750d867741E05F302053472115eb2` (release factory
  `0xEa0c345cE84025b4e8462d145100dce1848254B4`, legacy factory `0x262B774cf9a1949170B58E2d57F6189980FE757b`, Genesis
  unchanged). `retainedMarketplaces` keeps `0x75964C44cA586b13e98e7c30E74d2B4114f65b06` (its own factories
  `0xE744D58fA8138042f5f00a28d39f89081539C19B` + `0x262B774cf9a1949170B58E2d57F6189980FE757b`, block 98161532) readable,
  buyable, cancellable and indexed; no new listing is ever created on it. Genesis listing 1 (token 0) stays reachable there.
- `deploy/vercel-mainnet/vercel.json` and `package.json` `build:mainnet`: `VITE_MARKETPLACE_ADDRESS=0x0F5930113Ec750d867741E05F302053472115eb2`.

**Indexer coverage after the switch.** With `INDEXER_INCLUDE_RELEASE_MANIFEST` unset or `true` (the default), the worker and
the API add, on top of `INDEXER_CONTRACTS_JSON`: `withManifestReleaseDeployments` → every recorded factory and its marketplace
(`0xEa0c345cE84025b4e8462d145100dce1848254B4` from 98367434, `0xE744D58fA8138042f5f00a28d39f89081539C19B` from 98161422,
`0x262B774cf9a1949170B58E2d57F6189980FE757b` from 97619965, `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` from 97619978);
then `withUnifiedMarketplace` → `0x0F5930113Ec750d867741E05F302053472115eb2` from 98367443 and the retained
`0x75964C44cA586b13e98e7c30E74d2B4114f65b06` from 98161532, both with the per-asset fee policy (0 bps Genesis, 250 bps
releases). No Render change is needed in that case. **The production value of `INDEXER_INCLUDE_RELEASE_MANIFEST` is
UNVERIFIED.** If it is `false`, neither helper runs and `INDEXER_CONTRACTS_JSON` alone decides; the proposed additions are then:
```json
{"address":"0xEa0c345cE84025b4e8462d145100dce1848254B4","contractType":"RELEASE_FACTORY","startBlock":98367434},
{"address":"0x0F5930113Ec750d867741E05F302053472115eb2","contractType":"MARKETPLACE","startBlock":98367443}
```
Omit `platformFeeBps` on the marketplace entry: a flat 250 would reject Genesis resales (0 bps) on the unified marketplace,
and the per-asset check exists only with the manifest included. Render `MARKETPLACE_ADDRESS` is not read by server code.

**Sequence (each step is an owner action; Claude verifies read-only between them):**
1. Merge the switch PR. The Vercel mainnet project rebuilds the website from `main` (auto-deploy on `main`: UNVERIFIED, check
   the Vercel project). Render does not redeploy: both mainnet services use `autoDeployTrigger: "off"`.
2. Render → *Manual Deploy* of the merge commit: `the-void-indexer-mainnet`, then `the-void-api-mainnet`. No env change unless
   `INDEXER_INCLUDE_RELEASE_MANIFEST` is `false` (above).
3. **Gate before step 6** (read-only):
   - the live website bundle contains `0x0F5930113Ec750d867741E05F302053472115eb2` and `0xEa0c345cE84025b4e8462d145100dce1848254B4`;
   - `curl https://the-void-api-mainnet.onrender.com/api/health/ready` lists `0xea0c345ce84025b4e8462d145100dce1848254b4`
     (RELEASE_FACTORY) and `0x0f5930113ec750d867741e05f302053472115eb2` (MARKETPLACE), and still lists
     `0x75964c44ca586b13e98e7c30e74d2b4114f65b06`;
   - Genesis listing 1 on `0x75964C44cA586b13e98e7c30E74d2B4114f65b06` still shows buy/cancel on the site;
   - Studio prepares a **new** release on `0xEa0c345cE84025b4e8462d145100dce1848254B4` (no transaction sent). A release that
     already has a provisioning request stays on the factory recorded there, so step 6 starts from a new Studio release, never
     from `forgive-forget-6`.

**Rollback.** Before step 6 the new factory holds no releases: revert the merge (the website rebuilds the old pair) and
manually redeploy both Render services. After step 6 a plain revert would drop `0xEa0c345cE84025b4e8462d145100dce1848254B4`
from the manifests and hide its release; roll back instead by moving it into `historicalDeployments` (and the new marketplace
into `retainedMarketplaces`). Nothing on-chain changes either way.

**Known gaps:** the six `0xE744D58fA8138042f5f00a28d39f89081539C19B` clones (no holders) lose the listing surface, since the new
marketplace does not accept them and the retained one only settles existing listings. The indexer's aggregate checkpoint is
held back by the old Forgive & Forget clone `0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d` (stalled since 17:44Z on 2026-10-23);
both factories were within about 2,000 blocks of head at 21:23Z. Primary-sale fee settlement is not live-verified: no
settled-sale purchase has happened.

## 5. Retire the old Forgive & Forget in the app — reviewed migration, applied on API start

Move the reviewed file from `deploy/mainnet/pending-migrations/` into `server/migrations/` in its own PR (prepared by
the migration workstream). Merge + API deploy applies it. Chain records are untouched.
**Verify:** `/api/releases` and `/api/editions` no longer list `release-e3743294-2ea3-46ae-b006-f0402606af65` / `edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d`; Studio does not offer them.

## 6. Create the release — signer: artist wallet, in Studio

- `factory.createRelease(applicationReleaseId, releaseKey, "Forgive & Forget", "FNF", contractURI)` with
  `releaseKey = keccak256(abi.encode("the-void:studio-release:v2", 43114, <factory>, applicationReleaseId, 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a))` (Studio prepares it).
- **Expected:** `ReleaseCreated(..., version 4)`; a new clone, its `VoidPrimarySaleSettled` and `VoidProvenanceAnchor`.
- **Verify:** `factory.releaseContractOf(releaseKey) == <clone>`, `<clone>.nextTokenId() == 1`, `<clone>.name() == "Forgive & Forget"`.

## 7. Publish token 1 — signer: artist wallet. The FIRST creation on this clone; no rehearsal on it

- `<clone>.createEdition(releaseKey, 0x0000000000000000000000000000000000000000000000000000000000000001, 0, <metadataUri>, 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a, 250)`
  (open edition; Studio simulates first). The metadata `name` is the track title "Forgive & Forget", fixed with the URI.
- **Expected:** `EditionCreated(tokenId = 1, releaseId = releaseKey, editionId = bytes32(1), artist, 0, metadataUri)`.
- **Verify:** `<clone>.lastTokenId() == 1`, `<clone>.uri(1) == <metadataUri>`, the IPFS document's `name == "Forgive & Forget"`; Studio confirm records token 1.

## 8. Anchor provenance — signer: artist wallet

`<anchor>.anchor(releaseKey, bytes32(1), <provenanceRoot>)` (Studio prepares it). **Verify:** `<anchor>.isAnchored(releaseKey, bytes32(1), <root>) == true`.

## 9. Configure the sale — signer: artist wallet

`<sale>.configureSale(1, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused)` with owner-chosen values (open
edition: `endTime` required). **Verify:** `<sale>.sales(1)` shows `configured = true` and the values.

## 10. First public purchase and checks

A collector calls `<sale>.purchase(1, 1)` with exactly `priceWei`. **Expected:** `PlatformPaid(0xb65C575CaE01574296Fab6E620B9A15cC0121ce4, 2.5%)`,
`Purchased(1, buyer, 1, …)`, `balanceOf(buyer, 1) == 1`, 97.5% in `<sale>.balances(0x284C09a7CC187E096cbbdc88d99DEFE6df32180a)`. **Verify:** the indexer
shows the ownership, the collection page shows "Forgive & Forget · Token #1", and a listing of token 1 goes to the new marketplace.

## Rollback

Before step 4 the new contracts are unused. After step 4, revert the manifest PR (the old pair keeps working). The
migration has documented reversal SQL. Once token 1 exists it cannot be undone or renumbered.
