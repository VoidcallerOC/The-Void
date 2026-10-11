# Forgive & Forget: Genesis claim + open edition

**Status:**

| Item | Status |
|---|---|
| Code (claim contract, snapshot eligibility, API, UI, deployment tooling) | PARTIAL: implemented and tested in this PR, not merged or deployed |
| Recorded target `0x12Ff…0Fe6` / `0x3671…5aFD` / token `1` | BLOCKED: cannot hold an uncapped open edition (§1) |
| Live claim, public mint and closure on Fuji | NOT STARTED |

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
| 12 | Fixed C-Chain snapshot supported | Before this PR, no (live `balanceOf`). Now yes (§2). Historical `eth_call` at the snapshot block is served by `api.avax.network`, checked 1,000,000 blocks back. | — |

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

## 2. Genesis eligibility: fixed snapshot

- **The rule.** A wallet qualifies only if `balanceOf(wallet, id) > 0` for some `id` in 0–3 on `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` (C-Chain 43114) **at `GENESIS_SNAPSHOT_BLOCK`**.
- **Where it is checked.** The server reads balances with `eth_call` at that block tag, after confirming the block's hash equals `GENESIS_SNAPSHOT_BLOCK_HASH`. A provider on another chain, a hash mismatch or a provider without historical state fails closed (503 `ELIGIBILITY_UNAVAILABLE`).
- **What the contract stores.** `ELIGIBILITY_RULE = keccak256(text)`, where the text names chain, collection, block, hash and token IDs (`genesisEligibilityRule`). Every voucher carries the rule, so a voucher for another snapshot is invalid on-chain.
- **Transfers.** A token transferred after the snapshot creates no new eligibility, and a holder who transfers away stays eligible. Each wallet claims once: `hasClaimed` on-chain, plus a server pre-check.
- **Reproducibility.** Anyone can recompute eligibility with `balanceOf(wallet, id)` at that block.

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

1. **Owner:** approve the new release (option A) and choose the snapshot block and `T` (§5).
2. **Artist wallet:**
   1. create the release on Factory V2;
   2. create the open edition (`maxSupply 0`, with or without `mintEnd = T + 8d − 1`, §1);
   3. `configureSale(tokenId, 0.25 AVAX, 0, 0, T + 24h, T + 8d − 1, false)`.
3. **Dry run:** run `Deploy Genesis holder claim to Fuji` with `broadcast_deployment=false`. Review its plan: predicted address, schedule, snapshot, constructor simulation, follow-ups.
4. **Owner:** authorize the broadcast with `I_CONFIRM_FUJI_GENESIS_CLAIM_DEPLOY`, the reviewed deployer and the reviewed nonce.
5. **Artist wallet:** send the printed `grantRole(ISSUER_ROLE, claim)` before `T`.
6. **Owner:** authorize setting the printed `GENESIS_*` values on Render, including the server-only signer key and `GENESIS_CLAIM_ENABLED=true`.
7. **Verify:**
   - `GET /api/claims/config` returns 200 with the exact target;
   - an eligible snapshot wallet claims once and its receipt and balance are confirmed;
   - an ineligible wallet gets 403;
   - after `T + 24h`, a non-holder mints at 0.25 AVAX;
   - after `T + 8d`, the mint is refused.

## 5. Snapshot block and claim start: constraints

**Genesis collection.** `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` on Avalanche C-Chain (43114). It is an EIP-1167 proxy (45 bytes of code) with an ERC-1155 interface, and its first activity was at block ~41,322,659.

**Snapshot block.**
- It must already exist when the claim is deployed, because the preflight and the API both check its hash.
- It is set once, in the claim contract's `ELIGIBILITY_RULE`, and cannot be changed after deployment.
- Choose it by rule, not by convenience: the last C-Chain block at or before a published snapshot time. That time should come before, or at, the moment the claim is announced, so nobody can buy into eligibility after learning of it.
- Record both the number and the hash.

**Verifying eligibility.** For each wallet, check `balanceOf(wallet, 0..3)` with an `eth_call` at that block. `api.avax.network` serves historical state; this was checked 1,000,000 blocks back. A full holder list for an announcement can be derived from the collection's `TransferSingle` and `TransferBatch` logs up to the snapshot, then cross-checked with those calls. No list is needed for the claim itself.

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

None of these rules disables a timing, price, signature, snapshot, role or replay check.

**Fuji ‑28 test parameters** for a chosen start `T`:
- sale: `configureSale(2567…3312, 10000000000000000, 0, 0, T + 300, T + 899, false)`;
- claim constructor: windows `300` and `600`, price `10000000000000000`;
- API: `GENESIS_CLAIM_WINDOW_SECONDS=300`, `GENESIS_PUBLIC_WINDOW_SECONDS=600`.

**Local fork simulation (2026-10-11 19:30–19:45 UTC).** Not live: everything ran on anvil forks of Fuji (block ~59314100) and C-Chain (block ~97304200). It used the real ‑28 contracts, the real Genesis balances, the real claim service and HTTP handler, and the real deploy preflight. 24 of 24 checks passed:
- **Deployment:**
  - preflight passed, including the constructor simulation;
  - the claim was mined at the predicted address;
  - `/api/claims/config` returned 503 before the `ISSUER_ROLE` grant and 200 after it.
- **Genesis window:**
  - no voucher was issued before `T`;
  - snapshot holder `0x6a86…` claimed for free (receipt status 1, +1 token);
  - wallet `0x284C…`, with no Genesis token, got 403;
  - a second voucher was refused with 409, and the replayed voucher was refused on-chain;
  - a wallet that received a Genesis token on C-Chain after the snapshot got 403.
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
