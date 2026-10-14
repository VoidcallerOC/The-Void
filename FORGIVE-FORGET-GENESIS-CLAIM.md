# Forgive & Forget: Genesis claim + open edition

**Status (2026-10-12, PR for the Fuji Rabby path):** PARTIAL. Code and local tests are done; nothing exists on any chain.

| Item | Evidence tier | Status |
|---|---|---|
| Claim contract, live-ownership eligibility, used-unit ledger, API, UI, deployment tooling | Local tests | COMPLETE in code: merged on `main` (`f37e0e8`, `c6914c8`, migration `039`). 52 forge tests (`GenesisHolderClaim*`) and 76 API tests pass locally; the 5 Postgres store tests run only in CI (`TEST_DATABASE_URL`). |
| Migration `039` applied to the production database | — | UNVERIFIED: not read in this session. |
| Uncapped open edition on the mainnet implementation (`VoidRelease1155V4Royalty` via `VoidReleaseFactoryV2Royalty`) | Local tests | PASS: `GenesisHolderClaimRoyaltyRelease.t.sol` (`maxSupply 0`, allocations 0, 250 bps locked royalty, claim, public sale, resale on `ReleaseMarketplaceV4`). Not exercised on any live chain. |
| Uncapped open edition on Fuji Factory V2 implementation `0x45c3…E452` | Fuji on-chain record (read-only) | PASS: release ‑28 is a live open edition (`maxSupply 0`) on a clone of this implementation (§1b). Not re-read in this session. |
| Recorded Fuji target `0x12Ff…0Fe6` / `0x3671…5aFD` / token `1` | Fuji read-only | BLOCKED: its implementation reverts `maxSupply 0` (§1). Resolution: the separate plan in §4a. |
| Live claim, public mint and closure on Fuji | Fuji transactions | NOT STARTED: needs the §4a plan approved and signed by the artist wallet. Step 4 (deploying the claim in Rabby with the dedicated voucher signer) is built and fork-rehearsed; no plan exists and nothing is authorized (`deploy/fuji/GENESIS-CLAIM-DEPLOY.md`). |
| Mainnet release, edition, sale, claim, `ISSUER_ROLE`, activation | Mainnet | NOT STARTED and not authorized (§7). The claim UI is still bound to Fuji (`src/lib/claim-state.js`). |

> **2026-10-12: eligibility changed from a fixed snapshot to live ownership, with an off-chain used-unit ledger: each free claim uses one Genesis unit's eligibility, and a used unit cannot qualify again after resale (§2). Genesis tokens are never moved or burned.** The owner replaced the
> fixed C-Chain snapshot with a live read of the connected wallet's current Genesis balances. Sections that
> describe the snapshot (§1 row 12, the §6 simulation) are kept as history of what was tested at the time.

Nothing here was signed, broadcast or changed in production. The evidence was gathered with read-only RPC calls (including `eth_call` simulations), database `SELECT`s and log reads, on 2026-10-11 18:47–19:04 UTC (Fuji block about 59313024).

## 1. Target reconciliation

**Verified on-chain (Fuji 43113):**

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Release `0x12FfEbdD18D42Ea24c2CdD99C08Bd78c6F5c0Fe6` has code | Yes: a 45-byte clone, `name()` = "Forgive & Forget" | `eth_getCode`, `name()` |
| 2 | Sale `0x3671E19307Eec5F7F2882C790A12cfE242245aFD` has code | Yes (4551 bytes) | `eth_getCode` |
| 3 | Sale bound to the release | Yes: `releases()` = `0x12Ff…`, and `ISSUER_ROLE` was granted to the sale at creation | `releases()`, `RoleGranted` log |
| 4 | Token ID from the creation receipt | **None.** Creation tx `0x6b7019e6…5b`, block 59098991, from artist `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` through factory `0xa5Cb…3505`. It emitted role grants and ownership/URI events only. No `EditionCreated` has ever been emitted by `0x12Ff`. | full log scan, blocks 59098991 → head |
| 5 | Uncapped open edition possible | **No.** The clone's implementation `0xAe32…B8b4` is `VoidRelease1155V4` at `9ec82e2`, whose `_createEdition` reverts on `maxSupply == 0`. An `eth_call` of `createEdition(…, maxSupply 0, …)` from the artist reverts `InvalidSupply()`; the same call with `maxSupply 1` succeeds. The bytecode has no `createEditionWithMintEnd` or album entry points. | simulation; `git show 9ec82e2:contracts/VoidCollection1155.sol` L260 |
| 6 | Sale cap and supply | `sales(1)` is all zeros, `configured = false` | `sales(1)` |
| 7 | Primary purchase or other mint | None: no `TransferSingle`, `Purchased` or `SaleConfigured` logs | log scan |
| 8 | Public sale started | No: never configured | `sales(1)` |
| 9 | Sale start, end, price | Not set | `sales(1)` |
| 10 | 24-hour Genesis phase enforceable | Not with the deployed claim code (there is none). The reworked `GenesisHolderClaim` in this PR enforces it (§3). | — |
| 11 | Corrected economics on this target | **No**, for two reasons. The deployed implementation cannot create a `maxSupply 0` edition. And token IDs are `keccak256("the-void:release-edition:v1", editionId)`, so token ID `1` cannot be produced. | `tokenIdFor` at `9ec82e2` |
| 12 | Fixed C-Chain snapshot supported (historical; superseded by live ownership, §2) | Before PR #169, no (live `balanceOf`). PR #169 added it; the 2026-10-12 change returns to live ownership. Historical `eth_call` at the snapshot block is served by `api.avax.network`, checked 1,000,000 blocks back. | — |

**Repository and database records:**
- `0x12Ff` is release `release-21249304…` (`forgive-forget-26`): status DRAFT, no editions, provisioned 2026-10-06 on the pre-album factory `0xa5Cb`.
- The pre-album factory is recorded in `config/fuji-release-per-contract-v2.json` as historical, `albumCapable: false`.

**Live tooling check:** `scripts/deploy-genesis-claim.mjs --dry-run` against this target refused with "Token 1 does not exist on release 0x12Ff…". It ran with a throwaway key and broadcast nothing, after passing the live chain-ID and C-Chain snapshot-hash checks.

**Verdict.** The recorded target cannot carry an uncapped open edition, and none of ‑23, ‑25 or ‑26 can either (§1b). With ‑28 excluded by the owner, a new release is necessary.

- **A. One new Forgive & Forget release from artist `0x284C…` on the album-capable Factory V2 `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8`.** Its implementation (`0x45c3…E452`, source `3861d74`) supports `maxSupply 0`, as the live ‑28 edition shows. Create exactly one open edition (`maxSupply 0`, royalty 250 bps as Studio's default, payout the artist). Draft `forgive-forget-26` and its empty clone stay unused.
  - **Mint deadline.** Studio's standalone-edition path (`encodeCreateReleaseEdition`) sets no `mintEnd`. The contract's `createEditionWithMintEnd(…, mintEnd = T + 8d − 1)` would also stop any direct issuer mint after the public window, but Studio only exposes `mintEnd` for album tracks. Without it, closure rests on the sale's end time and the claim window: only the sale and the claim hold `ISSUER_ROLE`, though the artist, as admin, could grant it to another address later. Using `createEditionWithMintEnd` needs a direct artist-wallet call or a small Studio change; the owner decides.
- **B.** Wait for Factory V3. It is source-only, behind its audit and review gates.
- **Not acceptable:** a huge finite cap on `0x12Ff`. That would invent a supply cap.

## 1b. Published "Forgive & Forget" records

Read on 2026-10-11 19:10 UTC, Fuji block 59313592. Sources: the database, `GET /api/editions`, and chain logs and state.

| Record | Status in database / public API | Contract, token | On-chain edition | Sale | Holders |
|---|---|---|---|---|---|
| `forgive-forget-23` | PUBLISHED / **not served** | legacy shared `0x7Bba…95B6`, token `5539…2836` | open edition (`maxSupply 0`), created block 59022633 (`0x6a9d4564…`), 0 minted | legacy sale `0x51cC…1aBA` (fee 500 bps): `SaleConfigured` `0x2102efa7…`, 0.01 AVAX, per-wallet 2, 03:00–03:15 UTC 2026-10-04, ended, 0 `Purchased` | none |
| `forgive-forget-25` | PUBLISHED / **served** | legacy shared `0x7Bba…95B6`, token `6829…6023` | open edition, created block 59037682 (`0x5002a7a8…`), 1 minted | `0x51cC…1aBA`: `SaleConfigured` `0x058ae67a…`, 0.01 AVAX, 14:45–15:00 UTC 2026-10-04, ended; 1 `Purchased` (`0x1b4a07ec…`, buyer `0x6a86…`, 0.01 AVAX) | `0x6a86…d2fb` holds 1; its protected DEMO experience is PUBLISHED |
| `forgive-forget-28` | PUBLISHED / **served** | Factory V2 clone `0x4b27…bB0`, token `2567…3312`, sale `0xfb13…7Cc3` | open edition, created block 59276831 (`0x0b62e365…`), 1 minted, `mintEnd` 0 | 0.01 AVAX, ended 2026-10-10 19:30 UTC, 1 sold | `0x284C…` (artist) holds 1, after the A4 purchase and the A7 resale back |
| `forgive-forget-26` | DRAFT | clone `0x12Ff…` | no edition (§1) | not configured | none |
| `forgive-forget-27` | DRAFT, different artist account (`voidcaller-10`, wallet `0x40cd…`) | none: provisioning request PENDING, never sent | — | — | — |

So the public catalog currently shows **two** "Forgive & Forget" editions: ‑28 and ‑25.

**Identity.**
- ‑23 and ‑25 are historical attempts on the legacy shared contract `0x7Bba…`. The deployer created that contract directly (`0x14dd51d9…`, block 59015108); it did not come from a factory. ‑23 is owner-designated as archived and not to be reused.
- ‑26 is an abandoned draft attempt on the pre-album factory.
- ‑28 is the current published Forgive & Forget on Factory V2. It is excluded by the owner.

**‑23 and ‑25 cannot be the claim target.** They live on the legacy shared contract, which `GenesisHolderClaim` refuses by construction (`LEGACY_FUJI_SINGLETON`). Both sales have ended.

**‑28 is excluded by the owner's instruction (2026-10-11), and that stands.** For the record, it would work under this PR's contract. It was excluded only because its sale had already started. That rule belonged to the old claim contract, which closed claims as soon as the sale's start time passed. In the new contract the claim window is fixed from `claimStart`, and the sale only has to be configured as the future public phase.

**Local fork proof.** I ran a forge test against a local fork of Fuji at block ~59313592; nothing was sent to the chain, and the test file was deleted. On the real ‑28 contracts:
1. the artist reconfigured the sale (0.25 AVAX, uncapped, opening at `claimEnd`, closing 7 days later);
2. a `GenesisHolderClaim` was deployed and granted `ISSUER_ROLE`;
3. a voucher claim minted for free;
4. a public purchase was refused before `claimEnd`, succeeded at `claimEnd`, and failed with `SaleEnded` after the 7 days.

Supply accounting holds: minted 1 = sold 1.

**Caveats for ‑28:**
- It has no token-level `mintEnd`, which can only be set when an edition is created. Closure therefore rests on the sale's end time and the closed claim window; only the sale and the claim contract hold `ISSUER_ROLE`.
- It is the certification fixture of `SYSTEM-CHAIN-CERTIFICATION.md` §2. It carries one test copy sold at 0.01 AVAX.
- Its metadata lists "A Demo Preview".

**Options for the owner. Each is a decision, and its transactions need separate authorization:**
- **A. One new release on Factory V2** (§1 verdict). This is the path while ‑28 stays excluded.
- **A0. Reuse ‑28.** Not selected. It would need the owner to lift the exclusion.
- **Record cleanup, either way.** Not done; these are production database changes that need authorization:
  - archive ‑23;
  - decide on ‑25: archiving it hides its protected experience from its one holder;
  - archive the empty ‑26 draft;
  - cancel ‑27's never-sent request.

## 2. Genesis eligibility: live ownership, one free claim per Genesis unit

**Genesis contract evidence (read 2026-10-12, read-only):**
- `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` on C-Chain (43114) is an EIP-1167 clone of `0x2e61967a569bc18affc5e1b9f71e00af93a268c7`. The clone has no upgrade path.
- The implementation is Joepegs Launchpeg `ERC1155SingleBundle` (verified source via Routescan; solc 0.8.13) on OpenZeppelin `ERC1155Upgradeable`. It is named "Voidcaller", and its `owner()` is the artist `0x284C…`.
- Every mint is a bundle: `_mint` calls `_mintBatch(to, _tokenSet, [amount…])`, one unit of each ID in the token set per bundle. Bundles minted: 235 dev plus 1,400 public. `tokenSet()` is now `[3]`; IDs 0–2 came from earlier sets.
- **Units are fungible.** ERC-1155 keeps only `balanceOf(wallet, id)`. A unit has no identity, so no unit can be told apart from another of the same ID.
- From all 1,056 `TransferSingle`/`TransferBatch` logs:

  | ID | Units | Holder wallets | Largest holding |
  |---|---|---|---|
  | 0 | ≈470 | 255 | 15 |
  | 1 | 459 | 104 | 220 |
  | 2 | 101 | 63 | 10 |
  | 3 | 605 | 151 | 66 |

  481 distinct wallets hold at least one. `0x6a86…` holds 4 / 2 / 0 / 21.
- **Transfers are plain.** `safeTransferFrom` and `safeBatchTransferFrom` add only an OpenSea-style operator-filter check, which applies to approved operators. There is no transfer hook a third party could use, and no `totalSupply`.

**Why the live balance alone is not enough.** A balance says how many units a wallet holds now, not whether those units already backed a claim. A per-wallet `hasClaimed` stops one wallet claiming twice, but not the same unit qualifying wallet after wallet. A per-token-ID "used" flag is wrong: each ID has hundreds of units, so it would allow at most four claims in total.

**Asset rule.** Genesis tokens are never burned, transferred, escrowed, locked, approved or modified by the claim:
- The server only reads Genesis: `eth_call` to `balanceOf`, `eth_getLogs`, the block number and the chain ID.
- The claim contract never calls the Genesis collection.
- The ledger below is off-chain eligibility accounting. Marking a unit "used" changes no on-chain balance or ownership, and no supply.

**Mechanism: a used-unit ledger** (`server/genesis-claim-ledger.js`, `server/genesis-claim-store.js`, migration `039`):
1. **What a claim consumes.** A wallet qualifies if it holds at least one unit of IDs 0–3 that no earlier claim used. Each successful voucher issuance, at C-Chain block `B`, marks exactly one of the wallet's unused units used: one unit of the lowest ID that has one. That ID is stored as `used_token_id`. The wallet's other units stay unused.
2. **One copy per wallet.** The claimant receives one Forgive & Forget token, minted directly to it. One claim per wallet still applies (`hasClaimed`).
3. **Transfers.** The ledger replays Genesis `TransferSingle`/`TransferBatch` logs. When a wallet sends units of an ID, its used units of that ID go first, so the claimed unit leaves with the first transfer. Remaining units are unused and qualify their new holders. Units are fungible, so "the claimed unit" can only be defined by this rule.
4. **Eligibility.** A wallet is eligible while it holds an unused unit at the current C-Chain head, has not claimed, and the window is open.
5. **Concurrency and expiry.** Issuance runs under a Postgres advisory lock per claim contract. A repeat request returns the same voucher, with the same nonce. A voucher still unredeemed 120 s past its deadline (destination-chain time) is settled through `hasClaimed`; if it was never redeemed, it becomes EXPIRED and its unit is released.
6. **Fail closed.** A wrong chain, a failed balance or log read, a provider behind the ledger, or an inconsistent ledger returns 503 and nothing is signed. The service refuses to start without the store.

**Example.** `0x6a86…` holds 4 / 2 / 0 / 21 units of IDs 0–3.
1. It claims. One ID-0 unit becomes used, and 26 units stay unused.
2. If it then sells one ID-0 unit, the buyer receives the used unit and cannot claim.
3. If it sells another ID-0 unit, that buyer can claim.
4. Units of IDs 1 and 3 it sends to others qualify their new holders.

**What is preserved:**
- Live eligibility, with no snapshot.
- Genesis tokens stay freely tradable.
- One free copy per wallet.
- The open edition and the public sale stay uncapped, with no global free-claim cap.
- The claim window, the switch to the public sale, and replay protection.
- Prices: 0.01 AVAX on Fuji and 0.25 AVAX on mainnet.

The contract changes only its `ELIGIBILITY_RULE` text (`v3`) and comments.

**Tradeoffs and limits:**
- **Server-enforced.** The claim contract cannot see C-Chain transfer history. This is the same trust model as before.
- **The ledger is private.** It is the reservations table plus public chain logs, so a third party cannot audit it without the table.
- **Operational dependencies.** It needs a C-Chain RPC that serves `eth_getLogs` in 2,048-block ranges, plus Postgres migration `039`.
- **Bound on free claims.** Each Genesis unit can back at most one free claim, so at most ≈1,635 free claims in total, set by the collection's supply rather than a cap. A holder of N units can therefore produce up to N free claims by spreading units across N wallets, before or after its own claim. Each unit still backs only one claim.

**Evidence:**
- `server/genesis-claim.test.js`: adversarial cases.
  - A multi-unit, multi-ID holder: one claim uses one unit. Resale of the used unit is denied; resale of an unused unit, and a batch of unused units, each qualify.
  - A batch carrying the used unit: the receiver keeps its eligibility from the unused units in the batch.
  - A wallet that received a used unit claims with one of its own unused units.
  - A single claimed unit resold A→B→C, after redemption and while A's voucher is pending.
  - Concurrent requests: the same holding is serialized, and independent holders are not blocked.
  - Repeat request and repeat claim.
  - Expiry versus redemption.
  - Fail-closed paths, and no voucher after the window.
  - Reads only: the Genesis provider sees only `getNetwork`, `getBlockNumber`, `getLogs`, and `call` with the `balanceOf` selector, and claims leave balances unchanged.
- `server/genesis-claim-ledger.test.js`: replay rules, including one unit per reservation, the lowest-ID choice, and the used unit inside a multi-unit transfer.
- `server/genesis-claim-store-db.test.js` (Postgres, run in CI): RLS; upsert including `used_token_id`; rollback; serialization across connections; rejected rows.
- Forge:
  - `test/GenesisHolderClaim.t.sol`: a claim succeeds with the Genesis address made to revert on any call, so the claim makes zero Genesis calls; it mints exactly one token, to the claimant.
  - `test/GenesisHolderClaimOpenEdition.t.sol`: the same voucher twice and from another wallet, no free mint after the window, and an uncapped public mint.
- **Mutation check.** Removing the lock fails the concurrency test. Disabling the ledger fails 9 tests.
- **Local C-Chain fork, not live:** 11 of 11 checks passed. The run used the real Genesis contract, with real `safeTransferFrom` / `safeBatchTransferFrom` from impersonated `0x6a86…`. Issuing vouchers sent no C-Chain transaction (no new fork block) and left every Genesis balance unchanged. Resale of the used unit was denied; resale of unused units, single and batch, qualified.

## 3. Schedule and supply (contract-enforced)

**Phases** (`T` = `claimStart`):

| Phase | Window | Enforced by |
|---|---|---|
| Genesis claim, free | `T ≤ t < T + 24h` | `GenesisHolderClaim.claim` (`ClaimNotOpen`, `ClaimWindowClosed`) |
| Public mint, ungated, 0.25 AVAX | `T + 24h ≤ t ≤ T + 8d − 1` (exactly 7 days) | the token's own `VoidPrimarySale` (`SaleNotStarted`, `SaleEnded`, `WrongPayment`) |
| Closed | `t ≥ T + 8d` | `SaleEnded` and the closed claim window. With option A, the edition's `mintEnd = T + 8d − 1` also refuses a direct issuer mint (`MintingEnded`); ‑28 (option A0) has no `mintEnd`. |

**On every claim, the claim contract re-checks the sale:**
- the sale opens exactly at `claimEnd`;
- it closes at `publicSaleEnd`;
- its price is `publicPriceWei`;
- its cap equals `publicAllocation`;
- minted supply equals sold + claimed.

Any drift reverts every claim (`PublicSaleSchedule`, `PublicPriceChanged`, `PublicAllocationChanged`, `SupplyAccountingMismatch`). Studio blocks such edits while claims are live.

**Supply:**
- `allocation = 0` and `publicAllocation = 0` mean uncapped. This is allowed only on an edition with `maxSupply 0`; a capped edition still needs finite allocations.
- The sale uses `maxSupply 0` with `perWalletLimit 0` (no caps). Deployed `VoidPrimarySale` code accepts this for an open edition and requires an end time.

**Royalty and fees:** unchanged. The edition's royalty is whatever the artist sets at `createEdition` (Studio default). The sale's platform fee is sealed by the factory (250 bps).

## 4. Runbook after the owner chooses the target

Every step below is a transaction or a production change. **None is authorized by this PR.**

1. **Owner:** approve the new release (option A) and choose `T` (§5).
2. **Artist wallet:**
   1. create the release on Factory V2;
   2. create the open edition (`maxSupply 0`, with or without `mintEnd = T + 8d − 1`, §1);
   3. `configureSale(tokenId, 0.25 AVAX, 0, 0, T + 24h, T + 8d − 1, false)`.
3. **Dry run:** run `Deploy Genesis holder claim to Fuji` with `broadcast_deployment=false`. Review its plan: predicted address, schedule, eligibility rule, constructor simulation, follow-ups.
4. **Owner:** authorize the broadcast with `I_CONFIRM_FUJI_GENESIS_CLAIM_DEPLOY`, the reviewed deployer and the reviewed nonce.
5. **Artist wallet:** send the printed `grantRole(ISSUER_ROLE, claim)` before `T`.
6. **Owner:** authorize setting the printed `GENESIS_*` values on Render, including the server-only signer key and `GENESIS_CLAIM_ENABLED=true`.
7. **Verify:**
   - `GET /api/claims/config` returns 200 with the exact target;
   - a wallet that currently holds Genesis claims once and its receipt and balance are confirmed;
   - an ineligible wallet gets 403;
   - after `T + 24h`, a non-holder mints at 0.25 AVAX;
   - after `T + 8d`, the mint is refused.

## 4a. Definition of the launch objects, and the separate Fuji plan

**What is created, by whom.** The artist wallet `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` holds every artist role; the deployer only deploys the claim contract and holds no role afterwards.

| Object | Exact definition | Signed by |
|---|---|---|
| Release | `factory.createRelease(applicationReleaseId, releaseKey, "Forgive & Forget", symbol, contractURI)`; `releaseKey = keccak256(abi.encode("the-void:studio-release:v2", chainId, factory, applicationReleaseId, artist))`. The artist becomes the release admin; the factory keeps no role. | Artist |
| Edition / token | `createEditionWithMintEnd(releaseKey, editionId, 0, metadataUri, artist, 250, T + 8d − 1)`: uncapped (`maxSupply 0`), royalty exactly 250 bps to the artist (enforced on chain by V4Royalty), no mint after `T + 8d − 1`. | Artist |
| Sale | `configureSale(tokenId, 250000000000000000, 0, 0, T + 86400, T + 691199, false)`: 0.25 AVAX, no cap, no per-wallet limit, public window exactly 7 days. Platform fee 250 bps to the Nano S Plus, sealed in the factory. | Artist |
| Claim | `GenesisHolderClaim(release, sale, tokenId, 0, 0, T, 86400, 604800, 0.25 AVAX, admin, signer)`: free, one per wallet, quantity 1, vouchers bound to the live-ownership rule, only `T ≤ t < T + 24h`. | Deployer (Rabby) |
| Issuer permission | `release.grantRole(ISSUER_ROLE, claim)` before `T`; only the release admin can grant or revoke it (`testUnauthorizedRoleChangesAreRejected`). | Artist |
| Closure | Claims end at `T + 86400` (`ClaimWindowClosed`); the sale ends after `T + 691199` (`SaleEnded`); the edition's `mintEnd` refuses any issuer mint after it (`MintingEnded`). No further mint path (`testNoMintPathRemainsAfterClosure`). | — |

**Fuji plan (option A), separate from mainnet and NOT authorized here.** It resolves the §1 incompatibility without touching `0x12Ff…`. All transactions are on Fuji (43113), on Factory V2 `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8` (implementation `0x45c3…E452`, which accepts `maxSupply 0`), with the accelerated Fuji windows of §6 and 0.01 AVAX:
1. Artist: `createRelease` (new release; never ‑26's `0x12Ff…`).
2. Artist: `createEditionWithMintEnd(…, 0, …, mintEnd = T + claimWindow + publicWindow − 1)`.
3. Artist: `configureSale(tokenId, 0.01 AVAX, 0, 0, T + claimWindow, T + claimWindow + publicWindow − 1, false)`.
4. Deployer (Rabby, on `/fuji-rabby-test`; admin = artist, voucher signer = the dedicated Genesis signer `0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47`; its private key is a server-side secret only): the claim. Procedure, placeholder checks and evidence: `deploy/fuji/GENESIS-CLAIM-DEPLOY.md`. The old `Deploy Genesis holder claim to Fuji` workflow signed with the deleted `DEPLOYER_PRIVATE_KEY` secret and is not used.
5. Artist: `grantRole(ISSUER_ROLE, claim)`.
6. Render configuration and enablement (a production change; separate authorization).
Each step needs the owner's explicit approval of its exact calldata, prepared as an unsigned plan for the artist wallet in Rabby. The artist steps are not yet available on the owner-signing page, which today offers contract creations only. That extension is a follow-up, and must keep the artist and deployer accounts separate.

**Test coverage against the required cases** (local; forge unless marked API):

| Case | Test |
|---|---|
| Eligible / ineligible / zero balance | API: "denies a wallet that holds no Genesis token now", "issues one quantity-one voucher…" |
| Multiple units | API: "uses exactly one unit of a multi-unit, multi-ID holding…" |
| Resale after use | API: "denies the next wallet when a claimed single unit is resold…"; forge `testAClaimedTokenResellsOnMarketplaceV4AtTheExactSplit` |
| Duplicates / replay | `testSameWalletCannotClaimTwiceEvenWithDifferentValidVoucher`, `testNonceReplayRejectedAcrossClaimants`, `testFreeClaimMintsOneTokenToTheClaimantAndRejectsDuplicatesAndReplays`; API "returns the same voucher to a repeat request…" |
| Time boundaries | `testClaimRejectedBeforeTheClaimWindowOpens`, `testClaimIsFreeFromTheFirstToTheLastSecondOfTheWindow`, `testClaimRejectedAtAndAfterTheWindowCloses`; API "refuses vouchers before the window opens and from the second it closes" |
| Public sale start and end | `testPublicMintBlockedUntilTheGenesisWindowEnds`, `testPublicMintOpenOnItsLastSecondAndClosedAfterSevenDays` |
| Payment | `testPublicMintIsUngatedAtExactlyQuarterAvaxFromTheFirstSecond`, `testWrongPaymentIsRejectedWithoutMintingOrKeepingFunds`, `testMainnetRefusesAnyPriceOtherThanProduction` |
| Supply (uncapped) | `testOpenEditionHasNoSupplyCapAndClaimHasNoAllocationCap`, `testMixedClaimAndPublicSaleAccountingRemainsExact` |
| Closure | `testNoMintPathRemainsAfterClosure` |
| Unauthorized role changes | `testUnauthorizedRoleChangesAreRejected` (new), `testSignerRotationIsAdminControlled`, `testPausedClaimRejectedAndAdminCanResume` |
| Genesis never moved or burned | `testClaimMintsOnlyTheReleaseTokenToTheClaimantAndNeverTouchesGenesis`; API "only reads Genesis…" |

## 5. Claim start: constraints

**Genesis collection.** `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` on Avalanche C-Chain (43114). It is an EIP-1167 proxy (45 bytes of code) with an ERC-1155 interface, and its first activity was at block ~41,322,659.

**Eligibility source.** Live `balanceOf(wallet, 0..3)` at the latest C-Chain block, read when a voucher is requested (§2). The deploy preflight only checks that the Genesis collection has code on C-Chain; there is no block or hash to choose. Any C-Chain RPC works; no historical state is needed.

**Claim start `T`.**
- Claims are accepted while `T ≤ now < T + 86,400`.
- The sale must be configured with `startTime = T + 86,400` and `endTime = T + 8 × 86,400 − 1`, at exactly 250000000000000000 wei.
- `VoidPrimarySale` accepts purchases up to and including `endTime`, so the public window is exactly 604,800 seconds.

**Ordering, before `T`:**
1. If the edition uses `mintEnd`, `T` must be fixed before the edition is created, because `mintEnd` is set at creation.
2. The sale is configured.
3. The claim is deployed. The constructor requires `T ≥ block.timestamp`, and the preflight requires `T` to be at least 600 seconds after the latest Fuji block.
4. The artist grants `ISSUER_ROLE`. The API now refuses with 503 until this grant exists.
5. The Render values are set and enabled.

**Other constructor values (owner decisions; none is a supply cap):**
- `admin`: may pause, rotate the signer, and transfer admin.
- `signer`: the public address of a server-only key that must be generated and stored on Render.
- Claim allocation `0` and public allocation `0`, meaning uncapped.

## 6. Fuji test schedule vs. mainnet production schedule

| | Fuji (accelerated test, release ‑28) | Mainnet (production) |
|---|---|---|
| Genesis claim | `claimWindow` configurable, minimum 60 s; test plan 300 s (5 min) | exactly 86,400 s (24 h) |
| Public mint | `publicWindow` configurable, minimum 60 s; test plan 600 s (10 min) | exactly 604,800 s (7 days) |
| Price | 0.01 AVAX, ‑28's existing price, unchanged | exactly 0.25 AVAX |
| Supply | uncapped (`maxSupply 0`, allocations 0) | uncapped |

**Where each rule is enforced:**
- **Contract** (`GenesisHolderClaim` constructor): on chain 43114 it reverts unless the windows are exactly 1 day and 7 days and the price is exactly 0.25 AVAX (`PRODUCTION_PUBLIC_PRICE_WEI`). On Fuji each window must be at least 60 seconds. On every claim the sale must still match the claim's price and schedule.
- **API** (`claimSchedule` in `server/genesis-claim.js`): with `RELEASE_NETWORK=mainnet` it refuses to load unless the windows are 86,400 s and 604,800 s and the price is 0.25 AVAX. It also checks the deployed claim's `claimWindow` and `publicWindow`.
- **Deploy script** (`DEPLOY_NETWORK=fuji|mainnet`): applies the same rules. A mainnet broadcast needs `CONFIRM_MAINNET_DEPLOY`.

None of these rules disables a timing, price, signature, eligibility, role or replay check.

**Fuji ‑28 test parameters** for a chosen start `T`:
- sale: `configureSale(2567…3312, 10000000000000000, 0, 0, T + 300, T + 899, false)`;
- claim constructor: windows `300` and `600`, price `10000000000000000`;
- API: `GENESIS_CLAIM_WINDOW_SECONDS=300`, `GENESIS_PUBLIC_WINDOW_SECONDS=600`.

**Local fork simulation (2026-10-11 19:30–19:45 UTC; run against the snapshot design, before the 2026-10-12 live-ownership change).** Not live: everything ran on anvil forks of Fuji (block ~59314100) and C-Chain (block ~97304200). It used the real ‑28 contracts, the real Genesis balances, the real claim service and HTTP handler, and the real deploy preflight. 24 of 24 checks passed:
- **Deployment:**
  - preflight passed, including the constructor simulation;
  - the claim was mined at the predicted address;
  - `/api/claims/config` returned 503 before the `ISSUER_ROLE` grant and 200 after it.
- **Genesis window:**
  - no voucher was issued before `T`;
  - snapshot holder `0x6a86…` claimed for free (receipt status 1, +1 token);
  - wallet `0x284C…`, with no Genesis token, got 403;
  - a second voucher was refused with 409, and the replayed voucher was refused on-chain;
  - a wallet that received a Genesis token on C-Chain after the snapshot got 403 (under live ownership this wallet is now eligible, §2).
- **Public window:**
  - minting was refused before `claimEnd`;
  - 0.25 AVAX and 0.01 AVAX − 1 wei were rejected with no funds kept and no mint;
  - an ungated mint at 0.01 AVAX succeeded at `claimEnd`;
  - a mint succeeded on the last second (`publicEnd`);
  - a mint at `publicEnd + 1` was mined and reverted.
- **Accounting:** minted 4 = sold 3 + claimed 1. Sold includes the pre-existing A4 purchase.

The UI and the indexer were not part of the simulation.

**Defect found by the simulation and fixed.** The server's default voucher nonce was `BigInt(randomBytes(32).toString("hex"))`. ethers' `randomBytes` returns a `Uint8Array`, which ignores `"hex"` and produces comma-separated decimals, so `BigInt` threw. Every real voucher request would have returned 503. The unit tests injected a nonce and missed it. Fixed with `hexlify`, and a regression test that fails on the old code was added.

## 7. Mainnet readiness: none of these exist on chain 43114 as of block 97304353

Read-only facts:
- No factory, release, sale or claim on C-Chain.
- `config/mainnet-release.json` is `deployed: false` and describes the legacy shared design, not release-per-contract.
- Deployer `0xaBd3…` has 0 AVAX and nonce 0; artist `0x284C…` has 0 AVAX.
- Production API, indexer and frontend are Fuji-only: `RELEASE_NETWORK` defaults to `fuji`, the Render services index 43113, and the claim UI binding requires chain 43113 (`src/lib/claim-state.js`).
- A mainnet release is the first one on that chain, so it is not a duplicate of ‑28, but it is a new on-chain release and token that needs explicit authorization.

**Order on mainnet, each step a separate authorization:**
1. A reviewed factory on 43114: Factory V2 source `3861d74` (live-proven on Fuji), or V3 after its audit and independent-review gates.
2. Artist creates the release.
3. Artist creates the open edition: `maxSupply 0`, royalty 250 bps to the artist, `mintEnd = T + 8d − 1` optional.
4. `configureSale(token, 250000000000000000, 0, 0, T + 86400, T + 691199, false)`.
5. Dry run, then broadcast of the claim with windows 86,400 and 604,800.
6. `grantRole(ISSUER_ROLE, claim)` before `T`.
7. Mainnet API, indexer and frontend deployment and configuration.
8. Enable the claim.

**Stop conditions:**
- any preflight refusal;
- a predicted-address or nonce mismatch;
- `/api/claims/config` not returning 200 after the grant;
- any acceptance check failing.

**Rollback:** the claim admin can `pause()` the claim. The artist can pause the sale (`configureSale(..., paused = true)`). Mints cannot be undone.
