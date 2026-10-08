# Fuji Chain-Authority Verification

**Probed at:** `2026-10-08T18:33:22.446Z` (initial) / re-checked with corrected ABIs in the same session  
**RPC:** `https://api.avax-test.network/ext/bc/C/rpc`  
**Chain tip at probe:** block `59194272`, chain ID `43113`  
**Authority:** [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md)  
**Repro:** `node scripts/fuji-chain-authority-probe.mjs`

## Verdict

**Deployments and several on-chain publish/sale steps are VERIFIED. A full clean E2E (empty Pinata → collector-owned gated unlock for a designated fixture) is UNVERIFIED. Operator/report “E2E passed” statements are NOT_ACCEPTED_AS_PROOF.**

Indexer silence would not erase the Purchased / TransferSingle receipts below. Downstream sale state (`sold > 0`) is not used to invent missing purchase receipts; where receipts exist, they are cited.

## Evidence tiers used

| Tier | Used here |
|---|---|
| 1 | `eth_getTransactionReceipt`, `eth_getLogs` |
| 2 | `eth_call` contract state / `eth_getCode` |
| 3 | Repository Solidity matching observed selectors/events |
| 4 | `config/fuji-release.json`, `deployments/release-per-contract-fuji.json` |
| 5–7 | Reports / indexer / operator claims — historical only |

---

## Step matrix

| Step | Status | Strongest evidence | Source |
|---|---|---|---|
| Fuji RPC chain ID `43113` | **VERIFIED** | `eth_chainId` → `0xa869` | Tier 1 RPC |
| Legacy V1 deploy `0x262B…757b` | **VERIFIED** | Receipt `0x69eb…33f9` status `1`, block `58428586` | Tier 1; claim from `config/fuji-release.json` |
| Release V2 deploy `0x7Bba…95B6` | **VERIFIED** | Receipt `0x14dd…8c91` status `1`, block `59015108` | Tier 1; claim from `config/fuji-release.json` |
| Primary sale deploy `0x51cC…1aBA` | **VERIFIED** | Receipt `0xc752…dbec` status `1`, block `59015114` | Tier 1 |
| Issuer grant on release V2 | **VERIFIED** | Receipt `0x4733…decf` status `1`, block `59015117`, `to` release V2 | Tier 1 |
| Factory V2 deploy `0xa5Cb…3505` | **VERIFIED** | Receipt `0x734b…5b0d` status `1`, block `59082607` | Tier 1; `deployments/release-per-contract-fuji.json` |
| Marketplace V3 deploy `0x42B7…a744` | **VERIFIED** | Receipt `0x3d08…3861` status `1`, block `59082610` | Tier 1 |
| Runtime bytecode at all claimed addresses | **VERIFIED** | Non-empty `eth_getCode` + keccak hashes recorded in probe JSON | Tier 2 |
| `primarySale.releases() == release V2` | **VERIFIED** | `eth_call releases()` → `0x7Bba…95B6` | Tier 2; ABI `VoidPrimarySale.sol` |
| `marketplace.registry() == factory V2` | **VERIFIED** | `eth_call registry()` → `0xa5Cb…3505` | Tier 2; ABI `ReleaseMarketplaceV3.sol` |
| Factory `implementation` / fee constants | **VERIFIED** | `implementation() == 0xAe32…B8b4`, `PLATFORM_FEE_BPS == 250` | Tier 2 |
| Factory-provisioned releases | **VERIFIED** | `releaseCount() == 2`; two `ReleaseCreated` logs | Tier 1–2 |
| Shared V2 `EditionCreated` activity | **VERIFIED** | 3 logs on release V2 | Tier 1 |
| `forgive-forget-23` createEdition | **VERIFIED** | Tx `0x6a9d…d772` block `59022633` | Tier 1 |
| `forgive-forget-23` sale configured | **VERIFIED** | Tx `0x2102…5601` block `59022663`; `sales(token).configured == true` | Tier 1–2 |
| `forgive-forget-23` collector purchase | **UNVERIFIED** | No `Purchased` log for that token; `sold == 0` | Tier 1–2 (absence is not inferred into a purchase) |
| `forgive-forget-25` purchase + ownership | **VERIFIED** | `Purchased` `0x1b4a…8b9d`; mint `TransferSingle` same tx; `balanceOf(buyer)==1` | Tier 1–2 |
| `fuji-rehearsal-a` purchase + ownership | **VERIFIED** | `Purchased` `0x3587…ef44`; `balanceOf(buyer)==1` | Tier 1–2 |
| Marketplace listing/sale activity | **VERIFIED_ZERO** | No marketplace logs; `nextListingId == 1` | Tier 1–2 |
| Summit createEdition + mint | **UNVERIFIED** | Reports say none submitted; Summit token `artistOf` reverts; no Summit `EditionCreated` reconstructed | Tier 1–2 for absence of Summit edition; reports are tier 6 only |
| Summit cert deployment tx string | **CONFLICT** | Hash in `THE-VOID-SUMMIT-CERTIFICATION.md` is not 32 bytes; legacy hash in `config/fuji-release.json` verifies | Tier 1 wins over report |
| Clean Pinata → gated-media E2E | **UNVERIFIED** | Off-chain Pinata/DB/media steps not reconstructable from chain | Cannot invent from purchase receipts |
| Operator “E2E passed” | **NOT_ACCEPTED_AS_PROOF** | Tier 6–7 only | `CHAIN-AUTHORITY.md` |
| Historical “no Fuji deployment” (2026-09-10) | **CONFLICT / superseded** | Later manifests + live receipts prove deployments | Tier 1 > report tier 6 |
| Manifest `factoryReleaseCountAtVerification: 0` | **VERIFIED_AT_BLOCK** | True at verification time claim; tip state is `2` | Tier 2 tip state; do not erase historical note |

---

## On-chain objects (current tip)

### Shared certified path (`config/fuji-release.json`)

| Object | Address | Runtime bytecode hash |
|---|---|---|
| Release V2 | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `0x67770fc82259050f0db0d6e7545298aeb79e7454a37529bf6ab5b5a9cf010770` |
| Primary sale | `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA` | `0x9c172bda04f5d12cbb020070d13aa297d7c93e6ef646179afc82137bbfabe8db` |
| Legacy V1 | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `0x4ac73a1716d106019215cd4f3f88f4644680705e57652b5cc6b5df92bd09b78f` |

Primary sale linkage: `releases() == 0x7Bba…95B6`, `platformFeeBps == 500`, `platformRecipient == 0x284C…180a`.

### Release-per-contract path (`deployments/release-per-contract-fuji.json`)

| Object | Address | Runtime bytecode hash |
|---|---|---|
| Factory V2 | `0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505` | `0x9d2a362fb584724d685c3a796d20f6b182f3085fea1bbc162140ae0a0ad5b09b` |
| Implementation | `0xAe3257a441C5119Ee496330Dd93Deb06ab0eB8b4` | `0x116fa5438c74f6fe4e46984307ccefb76f85f8b66157a891cc772ebf9595a7db` |
| Marketplace V3 | `0x42B740aA92A6F48380F6D97AD91e332a7921a744` | `0xedced116da380cf82965836ac82cbd4931d2a3ed04c5b683bb1e00c08e56199a` |

Factory `ReleaseCreated` (tier 1):

| Index | Release | Primary sale | Tx | Block |
|---|---|---|---|---|
| 0 | `0x1AaF…9BfC` | `0x1cBc…b996` | `0x537e…2473` | `59083459` |
| 1 | `0x12Ff…0Fe6` | `0x3671…5aFD` | `0x6b70…ad5b` | `59098991` |

Artist for both: `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a`.

---

## Shared V2 edition / sale activity

### Editions (`EditionCreated` on release V2)

| Release | Edition | Token ID | Create tx | Block |
|---|---|---|---|---|
| `forgive-forget-23` | `forgive-forget` | `5539…2836` | `0x6a9d4564e4af6f810ee5416a39c294134d9de74311f55aab8d84676d3c0ad772` | `59022633` |
| `forgive-forget-25` | `forgive-forget` | `6829…6023` | `0x5002a7a8b97201a07b5689d94f4dc906697d5005f3cdd53a900963f8f3fc9b47` | `59037682` |
| `fuji-rehearsal-a-2` | `fuji-rehearsal-a` | `3257…5282` | `0x37f90597c7df5fce82fb9493f091a56b4943d1037de79e3bf5a2f16c9f920795` | `59052118` |

### Purchases (`Purchased` on shared primary sale)

| Token / release | Buyer | Qty | Paid | Tx | Block | `balanceOf` |
|---|---|---|---|---|---|---|
| `forgive-forget-25` (`6829…6023`) | `0x6a86…d2fb` | 1 | 0.01 AVAX | `0x1b4a07ec0531b5c31a031f15739a407dd976f89d29ae0dd7b76cecdb23fa8b9d` | `59038107` | `1` |
| `fuji-rehearsal-a` (`3257…5282`) | `0x284C…180a` | 1 | 0.01 AVAX | `0x3587fe0dbf971f4fd38af84bc49bc32f6006d3f159bc556b5b329afaa7bbef44` | `59053109` | `1` |

Corresponding mint transfers (`TransferSingle` from `0x0`) share those purchase transaction hashes.

### `forgive-forget-23` tip sale state

| Field | Value |
|---|---|
| `configured` | `true` |
| `priceWei` | `10000000000000000` (0.01 AVAX) |
| `sold` | `0` |
| `perWalletLimit` | `2` |
| `paused` | `false` |
| window | `1791082800` → `1791083700` |

Sale configure receipt `0x2102…5601` is VERIFIED. Collector purchase for this token is **UNVERIFIED** (no purchase receipt; `sold == 0`).

---

## Conflicts resolved by chain authority

1. **`THE-VOID-SUMMIT-CERTIFICATION.md` deployment tx**  
   Reported hash ends `…1c2a1b2a7aed…` and is **33 bytes** (`hex string has length 66, want 64`).  
   Canonical legacy hash in `config/fuji-release.json` (`…1c1a2b7aed…`) has a successful receipt.  
   **Winner:** config + receipt (tiers 1/4). Report string is invalid.

2. **`FUJI-CONTRACT-DEPLOYMENT-VERIFICATION.md` (2026-09-10) “no deployment”**  
   Later manifests and live receipts prove V1/V2/factory/marketplace deployments.  
   **Winner:** receipts (tier 1). Treat the 2026-09-10 doc as historical pre-deploy evidence only.

3. **Manifest note `factoryReleaseCountAtVerification: 0` vs tip `releaseCount() == 2`**  
   Not a contradiction of present state. Tip state shows two `ReleaseCreated` events after verification.  
   Label verification-time claim `VERIFIED_AT_BLOCK`; tip claim `VERIFIED`.

4. **Indexer/API drift reports vs chain activity**  
   Even if an indexer shows empty/old contracts, chain tracing establishes Editions/Purchases above.  
   **Winner:** receipts/logs (tier 1). Indexer emptiness is not disproof.

5. **Any handoff claiming full clean E2E**  
   Chain proves some publish + purchase paths. It does **not** prove empty-Pinata clean-room, DB rows, indexer projection, or gated media unlock.  
   Those remain **UNVERIFIED** unless independently reconstructed.

---

## Explicitly not inferred

- Factory tip `releaseCount == 2` does **not** prove Studio UI, Pinata, or API publication succeeded for those releases without their own receipts/logs/state.
- `sales.sold > 0` was **not** used to invent purchase identities; purchases were taken from `Purchased` logs, then checked with `balanceOf`.
- Artist wallet buying `fuji-rehearsal-a` proves a purchase receipt and ownership, not a distinct collector journey or gated-media unlock.
- Marketplace `nextListingId == 1` means no listing counter advance; it does not prove marketplace code is broken.

---

## Artifacts

- Rule: `CHAIN-AUTHORITY.md`
- Probe: `scripts/fuji-chain-authority-probe.mjs`
- This report: `CHAIN-AUTHORITY-FUJI-VERIFICATION.md`
- Session JSON dumps (local/agent): `/opt/cursor/artifacts/fuji-chain-authority-probe.json`, `fuji-chain-authority-decoded.json`
