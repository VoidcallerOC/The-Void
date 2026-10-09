# Deployer Authority Rotation — Inventory, Risk Review and Unsigned Package — 2026-10-09

**Status: PARTIAL.**
- **Done:** the inventory, the live simulation and the risk review.
- **Not yet possible:** the authorization package is final only as a template, because the replacement authority has not been chosen (decision R1).

**Mode:** read-only.
- Nothing was signed or broadcast.
- No credential, environment variable, database row or role was changed.
- The cron `crn-dat953e0tbcc73acrepg` stayed suspended.
- No pull request was merged.

**Subject (old authority):** `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`. This is the Fuji deployer and the cron key.

**Chain access:** this sandbox cannot reach the Fuji RPC. All chain evidence comes from read-only GitHub Actions runs of the "Fuji read-only release probe" on PR #142, against the public RPC.

| Run | Job | What it adds | Fuji tip |
|---|---|---|---|
| [37909396233](https://github.com/VoidcallerOC/The-Void/actions/runs/37909396233) | 113750622584 | `authority-inventory.mjs`: roles, owners, logs, payouts, pending balances | 59225727 |
| [37910301344](https://github.com/VoidcallerOC/The-Void/actions/runs/37910301344) | 113753573531 | adds dispatcher selector checks and the Safe infrastructure check | 59226074 |
| [37911017700](https://github.com/VoidcallerOC/The-Void/actions/runs/37911017700) | 113755901400 | `authority-rotation-simulate.mjs`: an `eth_call`/`eth_estimateGas` simulation of every step | 59226293 |
| [37911342571](https://github.com/VoidcallerOC/The-Void/actions/runs/37911342571) | 113756963527 | adds the pre-rotation sale-close simulation and `perWalletLimit` | 59226369 |

All three inventory runs agree exactly: the `summary` objects are identical. The old key's Fuji nonce is **59** in every run.

**Evidence labels:**
- **LIVE** means read from chain state or simulated against it in the runs above.
- **SOURCE** means derived from repository source.
- **UNVERIFIED** means not readable with the access this session has.

---

## 1. What changed from the 23-step draft

1. **The three legacy sale contracts cannot transfer ownership (LIVE).**
   - The contracts are 0x51cC (live), 0xcc26 and 0x7D1a.
   - Their deployed bytecode has no `transferOwnership(address)` selector.
   - `eth_call transferOwnership(...)` from the owner reverts with empty data. That is the no-matching-function revert; the contracts have no fallback.
   - They were built from `VoidPrimarySale.sol` *before* commit `80c32af` (2026-10-04), the commit that added `transferOwnership`.
   - **Their `owner()` stays the old key permanently.** The draft's three sale `transferOwnership` steps and their fee-proof steps would have reverted, so they are removed.
2. **The new authority's first action is now `revokeRole(DEFAULT_ADMIN_ROLE, old)`, not the ISSUER revoke.**
   - Both revokes prove control equally well.
   - Revoking admin first ends the window in which a possibly-compromised old key could revoke the new authority, one transaction sooner.
3. **The package now has 17 core steps** (4 releases × 4, plus 1 factory transfer), plus up to 3 optional old-key pre-steps (§3, decision R3).
4. **Unit tests now enforce three invariants:**
   - no step revokes or renounces the new authority;
   - no step targets a locked sale;
   - the step count matches the inventory.

## 2. Completed authority inventory (Fuji 43113)

The table uses these source-derived (SOURCE) mechanics:

| Contract type | Grant / revoke | Renounce | Last-admin guard | Transfer | What the role allows |
|---|---|---|---|---|---|
| Release (`VoidRelease1155` / `V2`) | `grantRole` and `revokeRole` by DEFAULT_ADMIN only | `renounceRole(bytes32)`, self only | none | — | Admin: grant, revoke, `pause`/`unpause`. ARTIST: `createEdition`. ISSUER: `mint`/`mintBatch`. |
| Sale (`VoidPrimarySale`, pre-80c32af) | — | — | — | — | Owner: `setPlatformFeeBps(x ≤ cap)` only. `platformRecipient`, the cap and `releases` are immutable. Proceeds go to `payoutOf(tokenId)` as pull balances. |
| Factory (`VoidReleaseFactory` V1) | — | — | — | `transferOwnership`, one step | Owner: `createRelease` |

The LIVE results confirm these mechanics:
- The release entry points exist on all four releases (selector check).
- `grantRole` and `revokeRole` succeed from the old key and revert with `AccessDenied(bytes32,address)` (`0x521dcf0d`) for an unprivileged caller and for `0x284C`.
- `renounceRole(DEFAULT_ADMIN_ROLE)` by the sole admin **succeeds** on all four releases. **There is no on-chain last-admin guard.**
- The factory transfer succeeds from the owner and reverts with `NotOwner()` (`0x30cd7471`) otherwise.

### Inventory by contract

| # | Contract | Privilege | Holders (LIVE: `hasRole`/`owner()` plus full RoleGranted/RoleRevoked reconstruction) | Old key? | Transfer path (LIVE) |
|---|---|---|---|---|---|
| 1 | **`0x7Bba0690…95B6`** shared release V2. **LIVE / P0**; holds every published Fuji edition | DEFAULT_ADMIN | old key only | yes | grant, then revoke ✔ |
| | | ARTIST | old key, `0x284C09a7…180a` | yes | revoke ✔ |
| | | ISSUER | old key, sale `0x51cC`, `0x284C` | yes | revoke ✔ |
| | | paused | false | — | — |
| 2 | **`0x51cCD2d5…1aBA`** shared primary sale. **LIVE / P0** | owner | old key | yes | **none: locked permanently** |
| | | fee | 500 bps = cap 500, recipient `0x284C` (immutable) | — | owner can only lower it (`setPlatformFeeBps(0)` simulates OK) |
| 3 | `0x262B774c…757b` release V1 (legacy certified) | DEFAULT_ADMIN, ARTIST, ISSUER | old key only, for every role | yes | grant, then revoke ✔ |
| 4 | `0x82b26Da2…82e5` release (legacy marketplace token) | DEFAULT_ADMIN | old key only | yes | grant, then revoke ✔ |
| | | ARTIST | old key, `0x284C` | yes | ✔ |
| | | ISSUER | old key, sale `0xcc26`, `0x284C` | yes | ✔ |
| 5 | `0xcc26cd6D…60F1` sale for 0x82b26 | owner | old key | yes | **locked permanently** |
| | | fee | 500 = cap, recipient `0x284C` | — | lower only |
| 6 | `0x7A78F13B…Fc6e` release (superseded, 0 editions) | DEFAULT_ADMIN, ARTIST | old key only | yes | ✔ |
| | | ISSUER | old key, sale `0x7D1a` | yes | ✔ |
| 7 | `0x7D1a068F…5363` sale for 0x7A78 | owner | old key | yes | **locked permanently** |
| | | fee | 500 = cap | — | lower only |
| 8 | `0x8291A4F1…c265` VoidReleaseFactory V1 (unused) | owner | old key (OwnershipTransferred `0x0 → old`, tx `0xa37afcae…5810`, block 59050635) | yes | `transferOwnership` ✔ (one step) |
| 9 | `0xa5CbA0F9…3505` FactoryV2 (canonical) | — | ownerless by design. Its dispatcher contains `transferOwnership` selectors only inside the embedded sale creation code. | no | — |
| 10–11 | clones `0x1AaF…9BfC`, `0x12Ff…0Fe6` | admin/owner, ARTIST | `0x284C` | no | out of scope |
| | | ISSUER | each clone's own sale | no | — |
| 12–13 | clone sales `0x1cBc…b996`, `0x3671…aFD` | owner | FactoryV2 | no | — |

Notes:
- **No unexpected role holder exists (LIVE).** The full log reconstruction finds no holder other than the old key, `0x284C`, and the sale contracts.
- **Avalanche C-Chain (LIVE):** the old key has nonce 0, balance 0 and no authority. `0xd1b4…98ee` has owner `0x284C`; its implementation has owner zero.
- **ISSUER on `0x284C` (LIVE).** `0x284C` holds ISSUER on the live release `0x7Bba` and on `0x82b26`, so it can mint directly, bypassing the sale and its payment.
  - This is not the old key, so it is outside this rotation, but it is a second privileged key on the live release (decision R5).
  - Who controls `0x284C` is UNVERIFIED. It is the platform fee recipient on the legacy sales and the owner of the mainnet collection.

## 3. Payout destinations, pending balances and editions that pay the old key

Payout addresses are fixed per edition (`payoutOf`, set at `createEdition`). No setter exists (SOURCE). Sale proceeds accrue as pull balances that only the payee can `withdraw()`.

| Sale | Release | Edition token (prefix) | `artistOf` / `payoutOf` | Sale state (LIVE) |
|---|---|---|---|---|
| `0xcc26` | `0x82b26` | 3297396830… | old key | not configured |
| | | 2368515571… | old key | not configured |
| | | 9404686040… | old key | not configured |
| | | **3377880292…** | old key | **OPEN: 0.01 AVAX, 2/25 sold, no start/end, not paused** |
| | | **8633610952…** | old key | **OPEN: 0.01 AVAX, 0/25 sold, no start/end, not paused** |
| | | 6962177709… | old key | not configured |
| `0xcc26` | `0x82b26` | 3 further editions | `0x284C` | — |
| `0x51cC` | `0x7Bba` | 5539478311…, 6829544612…, 3257665426… | `0x284C` | — |

Pending pull balances (LIVE, run 3):
- `0xcc26`: **old key 0.019 AVAX** (19000000000000000 wei); `0x284C` 0.021 AVAX.
- `0x51cC`: 0 for the old key. `0x7D1a`: 0 for the old key.
- `withdraw()` from the old key on `0xcc26` simulates OK (42,291 gas).

Consequences:
- **Any purchase of the two OPEN editions pays the old key, forever.** This holds whoever administers the contracts afterwards.
- Only the edition artist can call `configureSale`, which needs ARTIST_ROLE **and** `artistOf == msg.sender`. That is the old key, and **only until step 12 revokes its ARTIST_ROLE.**
- After step 12, the only way to stop those sales is for the new admin to `pause()` all of `0x82b26`. That also freezes transfers of every token on that release.
- Hence the optional old-key pre-steps P-1/P-2 below (decision R3).
- The old key keeps the right to `withdraw()` its 0.019 AVAX whatever is rotated. That function is not role-gated.

**Optional pre-steps** (signer: old key; before step 9; same sale parameters with `paused = true`):

| Step | To | Call | Calldata | Live simulation (run 37911342571) |
|---|---|---|---|---|
| P-1 | `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` | `configureSale` token 3377880292…, price 10000000000000000, maxSupply 25, perWallet 1, start 0, end 0, **paused true** | `0x23a126174aae1ffba437e9e91d04ea8032dfa64a3e8ed673475793a65bea7c266cf12563000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001` | OK from old key (≈56.0k gas); `AccessDenied(address)` from unprivileged |
| P-2 | `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` | `configureSale` token 8633610952…, price 10000000000000000, maxSupply 25, perWallet 20, start 0, end 0, **paused true** | `0x23a12617bee0819ca9eed9d3493d57d05d81ffbd949d97dd4fdab700a285dcad6cbe5413000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001` | OK from old key (≈56.0k gas); `AccessDenied(address)` from unprivileged |
| P-3 | `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` | `withdraw` | `0x3ccfd60b` | OK from old key (42,291 gas) |

## 4. Off-chain privilege inventory (separate from the on-chain rotation)

| Credential / list | Where | What it can do | Evidence | Status |
|---|---|---|---|---|
| `DEPLOYER_PRIVATE_KEY` (repo secret) | `deploy-release-fuji.yml`, `deploy-release-per-contract-fuji.yml`, `deploy-release-v2-fuji.yml` (×2 jobs), `deploy-release-v2-mainnet.yml` | Signs Fuji deploys and grants. The **mainnet** workflow would use the same key. | The 2026-09-26 preflight (run 36273658527, job 108492192803) printed `DEPLOYER/ADMIN MATCH: YES` and balance 0.489999998756591424 AVAX; it masked the address as `***` because it equals the `RELEASE_ADMIN_ADDRESS` secret. The old key held about 0.49 AVAX on Fuji then (0.4875 now). | Controls the old key: **strongly indicated, UNVERIFIED** (the address is masked) |
| `RELEASE_ADMIN_ADDRESS` (repo secret) | 4 workflows | The two Fuji workflows require it to equal the deployer, so they fail closed if only the key changes | source | value UNVERIFIED (masked) |
| Mainnet workflow | `deploy-release-v2-mainnet.yml`, `workflow_dispatch` plus typed confirmation | Would deploy to mainnet with `DEPLOYER_PRIVATE_KEY`, then hand off to `ADMIN_SAFE_ADDRESS` | **0 runs ever** (GitHub API) | LIVE |
| Render cron env | `crn-dat953e0tbcc73acrepg` (suspended) | Holds a deployer key. Broadcasts from this cron were signed by the old key. | Render run logs and on-chain creator (reconciliation report §8) | VERIFIED as present by inference; value not read |
| Render API and indexer env | `the-void-api-fuji`, indexer | No signing path in source. Holds `MARKETPLACE_ADMIN_WALLETS` (`server/marketplace-presentation-service.js:22`) and `VERIFICATION_REVIEWER_WALLETS` (`server/verification-service.js:33`). | No env read tool is available without exposing values | **UNVERIFIED** whether the old key is listed |
| Vercel production env | the-void project | No deployer key. Stale `VITE_FUJI_LISTING_MARKETPLACE_ADDRESS` is bundled but inert. | Vercel env list (earlier session) | VERIFIED |
| Studio DB `artist_owners` | API Postgres | Wallet-to-artist ownership for Studio publishing | Migration 032 removed the old key from `voidcaller-5`. Render has **no** Postgres; the only Supabase project is INACTIVE and is not the API DB, so there is no read path. | **UNVERIFIED** |
| E2E wallet | `FUJI_E2E_WALLET` = old key (`server/production-gate-readiness.test.js:24`) | Browser E2E publish and collect as the old key | source | Key location UNVERIFIED (assumed to be the owner's browser wallet) |

**API dependence on Fuji roles (SOURCE).** The API trusts on-chain authority only for:
- mainnet `0xd1b4` `owner()` (artist verification);
- FactoryV2 clone `owner()`.

So rotating the Fuji roles does **not** break API authentication. It **does** stop any E2E or manual flow that publishes or mints on `0x7Bba` as the old key.

Read-only query for the owner to run (it returns owner rows, no secrets):

```sql
SELECT artist_id, role FROM artist_owners WHERE lower(owner_wallet) = '0xabd3746e8b852f55be52fc44fab6cab908b1c174';
```

## 5. Fuji Safe infrastructure (LIVE)

Canonical Safe v1.4.1 contracts have code on Fuji:
- SafeProxyFactory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
- Safe `0x41675C099F32341bf84BFc5382aF534df5C7461a`
- SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`

**What this does not show:**
- that any proposed Safe exists;
- its owners or threshold;
- that the Safe web app or transaction service supports chain 43113.

No Safe address was provided. The `ADMIN_SAFE_ADDRESS` secret is mainnet-only and its value is masked. Nothing here assumes a Safe exists or can act.

If R1 is a Safe:
1. Run `NEW_AUTHORITY=<safe> node scripts/authority-inventory.mjs`.
2. Read `getOwners()`, `getThreshold()` and the code at the address before step 1.
3. Every new-authority step becomes a Safe transaction with the same `to` and calldata. **Signing it end to end is the proof of control.**

## 6. Transaction-by-transaction risk review

Gas (LIVE `eth_estimateGas`): grant ≈ 48.9k, admin revoke ≈ 29.8k, role revoke ≈ 32.4k, `transferOwnership` ≈ 28.8k. `eth_gasPrice` was 160 wei.

Totals:
- old key: about 0.25M gas including the optional steps; it holds 0.4875 test AVAX;
- new authority: about 0.38M gas, so it **must be funded before step 2**. A small test-AVAX amount is enough; the wallet quotes the exact fee.

| Step | Signer | Call | Depends on | Failure / race | Reversible? | Recovery |
|---|---|---|---|---|---|---|
| P-1, P-2 (opt.) | old | `0xcc26.configureSale(token, same params, paused=true)` | before 12 | Wrong parameters revert harmlessly (validated). | yes; the old key can un-pause until step 12 | — |
| P-3 (opt.) | old | `0xcc26.withdraw()` | none | — | n/a | not time-critical; stays available after rotation |
| 1 | old | `0x7Bba.grantRole(ADMIN, NEW)` | NEW funded and validated; `hasRole(ADMIN, NEW)` must be false first | **Typo or wrong NEW → that address becomes admin.** | **yes**, while the old key is admin | old key: `revokeRole(ADMIN, NEW)` (`0xd547741f` + 32 zero bytes + NEW) |
| 2 | **NEW** | `0x7Bba.revokeRole(ADMIN, old)` | step 1 confirmed; `hasRole(ADMIN, NEW)` true | **Race window 1→2:** a compromised old key could revoke NEW or grant a third party. Step 2 is the first point where only NEW administers. | no for the old key; NEW can re-grant | if NEW cannot sign: **do not proceed**, revoke NEW with the old key, re-plan |
| 3 | NEW | `revokeRole(ISSUER, old)` | 2 | Until confirmed, the old key can mint existing editions directly | NEW can re-grant | — |
| 4 | NEW | `revokeRole(ARTIST, old)` | 2 | none (the old key is artist of no `0x7Bba` edition) | NEW can re-grant | — |
| 5–8 | as 1–4 | `0x262B` V1 | 4 (P0 proven) | Same; no sale contract references `0x262B` | as above | as above |
| 9–12 | as 1–4 | `0x82b26` | P-1/P-2 if chosen | **12 freezes `configureSale` for the 6 old-key editions.** Any still OPEN keep selling to the old key. | NEW can re-grant ARTIST to the old key | NEW `pause()` on `0x82b26`, which halts all its sales and transfers |
| 13–16 | as 1–4 | `0x7A78` | — | none (0 editions) | as above | — |
| 17 | old | `0x8291.transferOwnership(NEW)` | **after 2 has proven NEW** | **Irreversible.** A wrong address is permanent. | **no** | none; only the unused factory V1 is affected |

**Not in the package, and why:**
- **Sale ownership** on `0x51cC`, `0xcc26` and `0x7D1a` is impossible (§1). **Residual risk:** the old key, or anyone holding it, can set the platform fee on those sales to anything from 0 to 500 bps.
  - It cannot raise the fee above 500, redirect payouts, mint or move funds.
  - This lasts while those sales are in use. Retiring them is decision R6.
- `renounceRole` is never used. The new authority revokes instead, so the action is attributable and the proof is built in.

### Cross-cutting risks

1. **Compromised-key race.**
   - No on-chain hierarchy can win an admin war: two admins can revoke each other indefinitely.
   - Mitigations:
     - send step 2 immediately after step 1 is confirmed;
     - run P0 first;
     - re-run `NEW_AUTHORITY=<new> node scripts/authority-inventory.mjs` after each release. The log reconstruction must show DEFAULT_ADMIN = {NEW} and no new holders.
   - If a third-party grant appears, NEW revokes it before continuing.
2. **Last-admin lockout.**
   - The guard is LIVE-confirmed absent. After step 2, NEW is the **only** admin of each release. If NEW's key or Safe becomes unusable, those releases can never be administered again (no pause, no grant).
   - Mitigation (decision R2): grant DEFAULT_ADMIN to a second, independently held recovery authority in the same session, or use a multi-owner Safe.
   - The package never revokes or renounces NEW (unit-tested).
3. **Irreversible ownership.** Only step 17 is irreversible. It is ordered after NEW has proven control on the live release.
4. **Ordering dependency.** Old-key steps (1, 5, 9, 13, 17, P-x) need the old key to keep its authority. Do every old-key step for a release before NEW revokes on that release; the plan's per-release order guarantees this.
5. **A passing test is not a safe live sequence.**
   - Simulations prove each call's gate and encoding against current state.
   - They cannot prove sequential behaviour, mempool ordering or the signer's custody.
   - The NEW-signed revokes were simulated from the current admin, which passes the same `onlyRole(DEFAULT_ADMIN_ROLE)` gate in source.

## 7. Credential cutover (off-chain)

Do these only after §6 is complete and verified, and only on approval:

1. **GitHub:**
   - Delete the repo secret `DEPLOYER_PRIVATE_KEY`. Do not replace it with the new authority's key; keep no hot admin key in CI.
   - Set `RELEASE_ADMIN_ADDRESS` to NEW only if the Fuji deploy workflows are still wanted. Without the key they fail closed at preflight.
   - Mainnet deploys should be redesigned around the Safe before any use.
2. **Render cron `crn-dat953e0tbcc73acrepg`:**
   - Delete its deployer-key environment variable, or delete the service. It stays suspended either way.
   - An env update does not trigger a run (verified earlier).
3. **Render API:** remove the old key from `MARKETPLACE_ADMIN_WALLETS` and `VERIFICATION_REVIEWER_WALLETS` if it is listed. This is UNVERIFIED and a production env change.
4. **DB:** after running the §4 query, remove or replace old-key `artist_owners` rows through a reviewed migration.
5. **E2E:** move `FUJI_E2E_WALLET` to a dedicated test wallet that holds no admin role. Update `server/production-gate-readiness.test.js` and the acceptance matrix.
6. **Old key:** after the cutover it keeps:
   - the locked sale-fee power (§6);
   - its 0.019 AVAX pull balance;
   - its 0.4875 test AVAX.

   Optionally sweep the AVAX. **Never import the old key into a new tool** to do so; use whichever existing signer the owner already controls.

## 8. Compromise assessment

**Potentially exposed, with no evidence of misuse.**
- The key sat in a Render cron env and a GitHub secret, and the cron broadcast unreviewed deployments.
- Old key nonce 59; last transaction is nonce 58 (2026-10-06 03:13:59 UTC, the cron deploy), unchanged across four runs today.
- No unexpected role holders. No mainnet activity (nonce 0).
- Pending balances are untouched.

This does not prove the key is uncompromised.

## 9. Unresolved access blockers

| Item | Why blocked | How to resolve |
|---|---|---|
| Old-key membership of `MARKETPLACE_ADMIN_WALLETS` / `VERIFICATION_REVIEWER_WALLETS` | No read path that would not expose values | The owner checks the Render dashboard |
| `artist_owners` rows for the old key | No access to the production DB | The owner runs the §4 query |
| Proof that `DEPLOYER_PRIVATE_KEY` is the old key | GitHub masks the address | Accepted as strongly indicated; deleting the secret makes this moot |
| E2E key custody | Off-system | The owner confirms |
| Controller of `0x284C` | Off-system | The owner confirms |
| Safe support for Fuji in the owner's tooling | Not testable read-only | The owner confirms, if R1 is a Safe |

## 10. Decisions requiring approval

| # | Decision | Recommendation |
|---|---|---|
| **R1** | Replacement authority: a hardware-wallet EOA or a Fuji Safe (address supplied by you) | You decide; it must be a fresh address. Verify it with the inventory script first. |
| **R2** | Add a second recovery admin, or a multi-owner Safe, against lockout | Yes, for `0x7Bba` at minimum |
| **R3** | Close the two OPEN old-key editions (P-1/P-2) before step 12, and/or withdraw 0.019 AVAX (P-3) | Close yes; withdraw optional |
| **R4** | Scope: P0 only (steps 1–4), P1 (1–12) or ALL (1–17) | P0 now; P1 and ALL in the same session if P0 verifies |
| **R5** | Have NEW revoke `0x284C`'s ISSUER on `0x7Bba`/`0x82b26` | Decide after confirming who controls `0x284C`; not in the package |
| **R6** | Accept the permanent old-key fee power on the 3 legacy sales, or retire them in favour of FactoryV2 clones | Accept for Fuji; retire before mainnet |
| **R7** | Signing path for old-key steps | Use the signer where you already hold the key. No new key export or import. A one-shot CI workflow using the secret is possible but is a new automated signing path, so it is not recommended. |
| **R8** | Off-chain cutover items 1–5 in §7 | Approve each individually after on-chain verification |

## 11. Unsigned authorization package (template until R1)

Generate the final package, with every calldata filled in and validated, after R1:

```bash
NEW_AUTHORITY=0x<your address> SCOPE=P0|P1|ALL node scripts/authority-rotation-plan.mjs
```

The script rejects:
- the zero address, the old key and any rotated contract;
- an address with a bad checksum.

It never signs and has no RPC access.

All steps: chain 43113, value 0. **NEW** = the replacement authority.

| # | Signer | To | Function | Calldata |
|---|---|---|---|---|
| 1 | old key | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `grantRole(DEFAULT_ADMIN_ROLE, NEW)` | `0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000{NEW, 24 zero hex + 40 hex}` |
| 2 | **NEW** | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `revokeRole(DEFAULT_ADMIN_ROLE, old)` | `0xd547741f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 3 | **NEW** | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `revokeRole(ISSUER_ROLE, old)` | `0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 4 | **NEW** | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `revokeRole(ARTIST_ROLE, old)` | `0xd547741f877a78dc988c0ec5f58453b44888a55eb39755c3d5ed8d8ea990912aa3ef29c6000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 5 | old key | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `grantRole(DEFAULT_ADMIN_ROLE, NEW)` | `0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000{NEW, 24 zero hex + 40 hex}` |
| 6 | **NEW** | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `revokeRole(DEFAULT_ADMIN_ROLE, old)` | `0xd547741f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 7 | **NEW** | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `revokeRole(ISSUER_ROLE, old)` | `0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 8 | **NEW** | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `revokeRole(ARTIST_ROLE, old)` | `0xd547741f877a78dc988c0ec5f58453b44888a55eb39755c3d5ed8d8ea990912aa3ef29c6000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 9 | old key | `0x82b26Da27136935454Bdf1e40801190B521b82e5` | `grantRole(DEFAULT_ADMIN_ROLE, NEW)` | `0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000{NEW, 24 zero hex + 40 hex}` |
| 10 | **NEW** | `0x82b26Da27136935454Bdf1e40801190B521b82e5` | `revokeRole(DEFAULT_ADMIN_ROLE, old)` | `0xd547741f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 11 | **NEW** | `0x82b26Da27136935454Bdf1e40801190B521b82e5` | `revokeRole(ISSUER_ROLE, old)` | `0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 12 | **NEW** | `0x82b26Da27136935454Bdf1e40801190B521b82e5` | `revokeRole(ARTIST_ROLE, old)` | `0xd547741f877a78dc988c0ec5f58453b44888a55eb39755c3d5ed8d8ea990912aa3ef29c6000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 13 | old key | `0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e` | `grantRole(DEFAULT_ADMIN_ROLE, NEW)` | `0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000{NEW, 24 zero hex + 40 hex}` |
| 14 | **NEW** | `0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e` | `revokeRole(DEFAULT_ADMIN_ROLE, old)` | `0xd547741f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 15 | **NEW** | `0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e` | `revokeRole(ISSUER_ROLE, old)` | `0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 16 | **NEW** | `0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e` | `revokeRole(ARTIST_ROLE, old)` | `0xd547741f877a78dc988c0ec5f58453b44888a55eb39755c3d5ed8d8ea990912aa3ef29c6000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` |
| 17 | old key | `0x8291A4F1936C1c5C6D8917b0966c80757cd5c265` | `transferOwnership(NEW)` | `0xf2fde38b{NEW, 24 zero hex + 40 hex}` |

Scopes: **P0** = steps 1–4. **P1** = 1–12, with P-1…P-3 offered. **ALL** = 1–17.

Recovery template (old key, only if NEW cannot sign step 2): `revokeRole(DEFAULT_ADMIN_ROLE, NEW)` = `0xd547741f` + 64 zero hex + NEW left-padded.

**Verification after each release (read-only):**

```bash
SUBJECT=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174 NEW_AUTHORITY=0x<new> node scripts/authority-inventory.mjs
```

Pass condition per release:
- `newAuthority.DEFAULT_ADMIN_ROLE == true`;
- `subject.*` all false;
- `roleHoldersFromLogs.DEFAULT_ADMIN_ROLE == [NEW]` (plus R2's recovery admin, if chosen).

For step 17: `owner() == NEW` on `0x8291`.

Re-run `node scripts/authority-rotation-simulate.mjs` immediately before signing. It must show:
- OPEN states unchanged;
- grants and revokes OK from the old key;
- `AccessDenied` for the unprivileged caller.
