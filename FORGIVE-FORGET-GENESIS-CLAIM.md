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

**Other "Forgive & Forget" records (reported, not acted on):**
- `forgive-forget-23` and `forgive-forget-25` are still `PUBLISHED` in the database, although `-23` is described as archived.
- `forgive-forget-28` (`0x4b27…`) is excluded because its sale started.
- `forgive-forget-27` is a pending provisioning request from a different wallet (`0x40cd…`).

**Live tooling check:** `scripts/deploy-genesis-claim.mjs --dry-run` against this target refused with "Token 1 does not exist on release 0x12Ff…". It ran with a throwaway key and broadcast nothing, after passing the live chain-ID and C-Chain snapshot-hash checks.

**Verdict.** The recorded target cannot carry an uncapped open edition. The smallest correction needs an owner decision:

- **A. Recommended.** One new Forgive & Forget release from artist `0x284C…` on the album-capable Factory V2 `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8`. Its implementation (`0x45c3…E452`, source `3861d74`) supports `maxSupply 0`, and the `0x4b27` edition already proves this live. That gives one clone and one open edition via `createEditionWithMintEnd(…, 0, …, mintEnd = publicSaleEnd)`. Draft `forgive-forget-26` and its empty clone stay unused.
- **B.** Wait for Factory V3. It is source-only, behind its audit and review gates.
- **Not acceptable:** a huge finite cap on `0x12Ff`. That would invent a supply cap.

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
| Closed | `t ≥ T + 8d` | `SaleEnded`, the claim window, and the edition's `mintEnd = T + 8d − 1` (`MintingEnded` even for a direct issuer mint) |

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

1. **Owner:** authorize option A and choose the snapshot block (C-Chain number and hash) and `T`.
2. **Artist wallet, Studio:**
   1. create the release on Factory V2;
   2. create the open edition with `mintEnd = T + 8d − 1`;
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
