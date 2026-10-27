# Genesis Recovery — Final Signing Checklist — 2026-10-27

**STATUS: READY FOR OWNER DECISION** (all technical checks pass; allocation semantics and schedule are owner-confirmation items, called out separately below — the schedule was already owner-approved at 11:00 AM ET on 2026-10-27)

## 1. Repository state (verified 2026-10-27 13:42:06 UTC)
- Remote: `https://github.com/VoidcallerOC/The-Void` (origin, verified via `git remote -v`)
- Branch: `main`, HEAD `ccb2d99a4a4a36c95144d72af3278232e39a20ef` ("feat: add Genesis recovery claim contract and fail-closed Grotto bridge path")
- Worktree: clean except the untracked preflight report `GENESIS-RECOVERY-PREFLIGHT-2026-10-27.md`. No modifications to any tracked file.
- Note: the previously reported branch `codex/genesis-recovery-preflight` does not exist on the remote; `ccb2d99` on `main` is the authoritative recovery implementation.

## 2. Claim schedule verification (live evidence)
Observed: block 98,695,429, timestamp `1793108544` = **2026-10-27 13:42:24 UTC** (9:42:24 AM EDT). Official RPC `https://api.avax.network/ext/bc/C/rpc`, chain ID `43114`.

| Field | Value | UTC | America/New_York (EDT, UTC-4) |
| --- | --- | --- | --- |
| claimStart | 1793113200 | 2026-10-27 15:00:00 | 2026-10-27 11:00:00 |
| claimEnd = claimStart + 86400 | 1793199600 | 2026-10-28 15:00:00 | 2026-10-28 11:00:00 |
| publicSaleStart | 1793019600 | 2026-10-26 13:00:00 | 2026-10-26 09:00:00 |
| publicSaleEnd | 1793710799 | 2026-11-03 12:59:59 | 2026-11-03 08:59:59 |

**Boundary semantics** (source: `contracts/GenesisHolderClaimRecovery.sol`):
- `claim()` reverts `ClaimNotOpen(claimStart, block.timestamp)` while `block.timestamp < claimStart` (line 220).
- Reverts `ClaimWindowClosed(claimEnd, block.timestamp)` once `block.timestamp >= claimEnd` (line 221), where `claimEnd = claimStart + claimWindow` (line 179).
- Effective claimable seconds: **[1793113200, 1793199599] inclusive** — first claim 2026-10-27 15:00:00 UTC, last 2026-10-28 14:59:59 UTC (10:59:59 AM EDT).
- Individual vouchers additionally expire via `voucher.deadline` (line 222), separate from the window.

**Validity for a new deployment:** claimStart is ~78 minutes in the future at observation time and well within a reasonable signing window; the constructor places no lower bound on claimStart, so later signing still works — claims simply open at 15:00 UTC regardless of deploy time.
**Sale-window constraints:** live sale (`0xB4dAAe…3845`) is configured, unpaused, active (start 1793019600 < now < end 1793710799, observed `sales(1)`: price 0.25 AVAX, maxSupply 0, sold 1, perWallet 3). The 1-day claim window is shorter than the 8-day public window, satisfying the API's rule that claims close strictly before the public sale ends (`server/genesis-claim.js` claimSchedule). The claim window ends 5.9 days before the sale end. **No conflict.**

## 3. Allocation semantics — OWNER CONFIRMATION REQUIRED
- **`allocation = 0`** — means **uncapped** for recovery claims, not disabled.
  - Constructor (`GenesisHolderClaimRecovery.sol` line 166): `if (cfg.allocation != 0 && cfg.allocation < cfg.baselineClaimedSupply) revert InvalidConfiguration();` — zero skips the baseline sanity check.
  - Claim (line 230): `if (allocation != 0 && voucher.quantity > allocation - claimedSupply) revert AllocationExhausted(...)` — zero disables the cap entirely.
  - Practical effect: every eligible Genesis holder (balance > 0 across token ids 0–3, enforced by `_assertGenesisHolder`, lines 254–261) can claim exactly 1 (`CLAIM_QUANTITY = 1`, one-time via `hasClaimed`, line 228). There is **no maximum total** on recovery claims; the only supply control is Genesis-holder gating.
  - Tests: `testBaselineAndPriorClaimantsAreSeeded`, `testEligibleWalletClaimsOnceAndSupplyInvariantHolds`, `testIncorrectBaselineOrClaimantSeedReverts` (`test/GenesisHolderClaimRecovery.t.sol`).
- **`publicAllocation = 0`** — means **open (uncapped) paid sale**, and it is a *binding mirror* of live state, not a flag.
  - Constructor line 164: `sale.maxSupply != cfg.publicAllocation` reverts unless the live sale's maxSupply **equals** publicAllocation. Live observed maxSupply = 0 (open edition), so 0 is required — any other value would make deployment revert.
  - Re-checked at every claim via `_assertPublicAllocation` (line 243).
  - Practical effect: the paid sale remains uncapped; the supply invariant `mintedSupply == sale.sold + claimedSupply` (lines 168–169, 247) is what ties paid mints and recovery claims together. Tests: `GenesisHolderClaimRecoveryMainnetFork.t.sol` (asserts live `maxSupply == 0`, `sold == 1`, `mintedSupply == 3`).
- **Owner decisions still needed (do not deploy without them):** confirm acceptance of (a) an uncapped recovery claim gate (holder-gated, 1 per holder) and (b) publicAllocation 0 mirroring the live open edition. Changing either requires editing `scripts/deploy-genesis-claim-recovery.mjs` (hardcoded 0n values) and re-simulation.

## 4. Deployment nonce and predicted address (live, official RPC)
- Deployer for the unsigned tx: `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` (per `deploy/mainnet/DEPLOYMENT-AUTHORITY.md`; owner signs in Rabby).
- Chain ID: `43114` ✓ (cast chain-id).
- Latest confirmed nonce: **15** (`eth_getTransactionCount` "latest").
- Pending nonce: **15** (`eth_getTransactionCount` "pending").
- Difference: none — no pending transaction in the mempool at observation (block 98,695,429, 13:42:24 UTC). (Earlier today the nonce was 14; one deployer tx was observed between 09:32 and 09:37 UTC, which is why the earlier nonce-14 prediction `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` was superseded.)
- Predicted CREATE address (recomputed from verified deployer + nonce 15 via `ethers.getCreateAddress`): **`0xd70dBA7fF6419481d62D4689bDf271ad441766b8`** — **matches** the previously reported fork-simulation result `0xd70dBA7Ff6419481D62d4689BDF271ad441766B8` (same address, different checksum casing).
- Consequence of a pending/interleaved tx: any deployer transaction before signing increments the nonce and changes the CREATE address. Re-derive immediately before signing; do not reuse this prediction blindly.

## 5. Wallet funding (live, block 98,695,429, 13:42:24 UTC)
| Wallet | Balance (wei) | Balance (AVAX) | Required (est.) | Sufficient? |
| --- | --- | --- | --- | --- |
| Deployer `0xaBd374…c174` | 100,000,000,000,000,000 | 0.1 | see below | YES |
| Artist/admin `0x284C09…80a` | 173,150,390,113,124,580 | ≈0.17315 | see below | YES |

**Gas-price assumption:** base fee observed `2,500,000,000` wei (2.5 gwei); `eth_gasPrice` `2,500,000,150`. Estimates use 2.5 gwei with a **4x safety margin (10 gwei)**:
- Deployment: 1,881,995 gas → 0.004705 AVAX @ 2.5 gwei; **0.01882 AVAX @ 10 gwei** — deployer 0.1 AVAX covers with >5x margin.
- ISSUER_ROLE grant: 51,834 gas → 0.0001296 AVAX @ 2.5 gwei; **0.000518 AVAX @ 10 gwei** — artist 0.17315 AVAX covers with >300x margin.

## 6. Unsigned creation transaction (validated from a fresh dry-run, not a copied JSON)
Fresh run of `node scripts/deploy-genesis-claim-recovery.mjs` (exit 0, mode `DRY_RUN`) with the owner-approved schedule; output `/tmp/dryrun-signing.json` on the executor sandbox.

Fields **present** in the unsigned transaction payload:
- `to`: null (contract creation), `value`: `0x0` (0), `data`: full initcode, **11,588 bytes**.
- Initcode hashes: **SHA-256 `fff9de6935133fd7ea37589beb508648303458470c39889cd7824e5111601d9c`**, **keccak-256 `0xbd9ee51fdc28cbb52207f43b378e12e3576ac73624a583376a56d7271c2b7f2e`**.
- Constructor arguments (decoded from the same payload): `RecoveryConfig { releaseContract: 0xF0C091A159DE16cF0F306b2B61d37685EC5A830e, primarySale: 0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845, tokenId: 1, allocation: 0, publicAllocation: 0, claimStart: 1793113200, claimWindow: 86400, publicSaleStart: 1793019600, publicSaleEnd: 1793710799, publicPriceWei: 250000000000000000, baselineClaimedSupply: 2, admin: 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a, signer: 0xAD3A1026b06c2A0B2091322410254363e2764c4e }`, `priorClaimants: [0x6a86EfA012fEDA64b70112022487fEE22E67d2fb, 0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174]`.

Fields **to be populated at signing time** (not in the dry-run payload): `from` (deployer 0xaBd…c174), `nonce` (15 as of observation — re-check), `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` (est. 1,881,995 @ ~2.5 gwei base fee), signature (owner's Rabby key — never in automation).

**Artifact provenance:** `out/GenesisHolderClaimRecovery.sol/GenesisHolderClaimRecovery.json`, built by `forge build` from `foundry.toml` (`solc_version = "0.8.24"`, optimizer 200 runs), solc `0.8.24+commit.e11b9ed9`, bytecode object 11,045 bytes (plus constructor args in the initcode). Artifact is the one consumed by the deploy script (`RECOVERY_ARTIFACT` constant) and the one used in the 2026-10-27 fork simulation. Provenance verified — not BLOCKED.

**Consistency with prior simulation:** the transaction simulated on the anvil fork on 2026-10-27 (status 1, gasUsed 1,881,995, issuer grant status 1) used the identical artifact and constructor arguments except `claimStart` (fork used the then-proposed 1794000000 in the first run and 1793113200 in the final run — the final run's payload is the one described here). Local fork simulation does **not** guarantee live deployment success; it demonstrates constructor validity against live state at fork block 98,695,094.

## 7. Outstanding owner decisions
1. **Allocation semantics** (Section 3): accept uncapped recovery claims (holder-gated, 1 per holder) and publicAllocation 0 = open edition binding. Required before signing.
2. **Timing:** claimStart 1793113200 opens claims at 15:00 UTC today; if signing slips past that, the window still works but the owner should confirm the open timestamp remains desired.

## 8. Production safety
No transaction was signed or broadcast. No deployment, no ISSUER_ROLE grant, no API activation, no bridge eligibility change, no production environment modification, no replacement of the original claim contract `0x8512be04a4E54cd8551738165F9c05C3303187a0`. All live reads were read-only RPC calls; all mutations were on a local anvil fork. No secrets or private keys are printed in this report.

## NEXT ACTION (one concrete action)
Owner: after confirming the Section 7 allocation decisions, sign the creation transaction in Rabby from `0xaBd374…c174` — re-derive the nonce immediately before signing (predicted address `0xd70dBA7fF6419481d62D4689bDf271ad441766b8` only while the nonce is 15).
