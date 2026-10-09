# Deployer Authority Rotation — P0 Review and Unsigned Package — 2026-10-09

**Status: BLOCKED for signing; PARTIAL overall.**
- **Done:** the inventory, the live simulations, the local-fork rehearsal and the P0 review.
- **Blocked:** the P0 package cannot become executable yet. No replacement Safe exists, no backup address has been supplied, and a working Fuji Safe signing workflow has not been verified (R1 blockers, §5).
- **Not part of this review:** P1/ALL are deliberately not reviewed or packaged here.

**Mode:** read-only.
- Nothing was signed or broadcast to Fuji or any other network.
- No credential, environment variable, access list, database row or role was changed.
- The cron `crn-dat953e0tbcc73acrepg` stays suspended.
- PR #142 is not merged.
- The Fuji archive/reconciliation gate still stands, and nothing here claims mainnet readiness.

**Subject (old authority):** `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`. This is the Fuji deployer and the cron key.

**Evidence tiers** (kept separate throughout):

| Tier | Meaning | Source |
|---|---|---|
| **LIVE-READ** | Read from Fuji state | `eth_call`, `eth_getStorageAt`, `eth_getCode`, logs, via the public RPC from GitHub Actions |
| **LIVE-SIM** | Simulated against current Fuji state; nothing executed | `eth_call` / `eth_estimateGas`. **LIVE-SIM+OVR** adds `eth_call` state overrides that model earlier steps' effects. |
| **FORK-EXEC** | Real transactions executed on a **local anvil fork** of Fuji | Never sent to Fuji. The old key is impersonated; test signers are anvil's unlocked dev accounts; no private key anywhere. |
| **SOURCE** | Derived from repository source and compiler output | — |
| **UNVERIFIED** | Not readable with this session's access | — |

**Runs used (latest first):**

| Run / job | Head | What it adds | Fuji block |
|---|---|---|---|
| [37915673243](https://github.com/VoidcallerOC/The-Void/actions/runs/37915673243) / 113771126783 `fork-rehearsal` | `770b22c` | FORK-EXEC of P-1, P-2, a 2-of-3 test Safe and the generated P0 package, with failure cases | fork at 59227256 |
| [37914566511](https://github.com/VoidcallerOC/The-Void/actions/runs/37914566511) / 113767503241 `probe` | `7d634a4` | Inventory, LIVE-SIM(+OVR), Safe readiness, legacy-sale bytecode identity | 59227031–59227042 |
| [37913533268](https://github.com/VoidcallerOC/The-Void/actions/runs/37913533268) / 113764115785 `probe` | `3c027f7` | First Safe readiness run, sequential P0 simulation with overrides, sale-close gates | 59226824–59226830 |
| 37909396233, 37910301344, 37911017700, 37911342571, 37911815871 | earlier | Inventory and first simulations (previous report) | 59225727–59226472 |

All seven inventory runs return an identical `summary`. **The old key's Fuji nonce is 59 in every run.** Its last transaction (nonce 58) was the cron deploy on 2026-10-06.

---

## 1. Owner decisions recorded (input to this review)

| # | Decision |
|---|---|
| R1 | Replacement authority: a fresh Fuji Safe, provided its creation, signing, execution, owners and threshold workflow is verified. Do not invent an address or assume Safe UI support. |
| R2 | Add an independently controlled backup admin. It must be able to administer before the old sole admin is removed. |
| R3 | Close the two open editions on `0x82b26` before the old key's ARTIST_ROLE is revoked. Defer P-3 (the 0.019 AVAX withdrawal). |
| R4 | P0 first; stop for verification and approval before P1/ALL. |
| R5 | Do not change `0x284C` in this package. Its direct mint authority is a separate open security decision. |
| R6 | Accept the permanent fee-lowering power of locked sales `0x51cC`, `0xcc26` and `0x7D1a`. No ownership transfers. |
| R7 | The owner reviews and signs manually through the existing wallet workflow. No private keys in automation, logs, prompts or repository files. |
| R8 | GitHub, Render, API lists, `artist_owners` and E2E wallet are separate cutover items. Inventory their dependencies first; change nothing yet; keep the cron suspended. |

## 2. Head and CI status

| Head | `build-and-test` | `probe` | `fork-rehearsal` | Note |
|---|---|---|---|---|
| `3c027f7` | success (job 113764117033) | success (job 113764115785) | — (job added later) | head named in the request |
| `9ded5a8` | — | — | **failure** (job 113767007039) | my bug: the rehearsal's sale ABI lacked `configureSale`; fixed in `7d634a4` |
| `7d634a4` | success (113767503381) | success (113767503241) | **hung** (113767503011) | confirmation-based receipt wait stalled after `evm_revert`; fixed in `770b22c` |
| `770b22c` | success (113771125677) | success (113771126532) | success (113771126783) | last commit that changes scripts or workflows |

Commits after `770b22c` change only this document. All three checks still re-run on every push, because `pull_request` path filters evaluate the whole PR diff. The status for the latest head is on the PR checks page and in the final report; this document does not assert it.

## 3. Authority inventory (Fuji 43113)

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

## 4. Payout destinations, pending balances and editions that pay the old key

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
- Only the edition artist can call `configureSale`, which needs ARTIST_ROLE **and** `artistOf == msg.sender`. That is the old key, and **only until the P1 step that revokes its ARTIST_ROLE on `0x82b26`.**
- After that revoke, the only way to stop those sales is for the new admin to `pause()` all of `0x82b26`. That also freezes transfers of every token on that release.
- Hence the old-key pre-steps P-1/P-2 (decision R3: required), verified in §6.
- The old key keeps the right to `withdraw()` its 0.019 AVAX whatever is rotated. That function is not role-gated.

P-3 (withdraw the 0.019 AVAX) is deferred by decision R3.

## 5. Replacement Safe and backup admin (R1, R2)

### 5.1 Safe readiness on Fuji

| Check | Result | Tier |
|---|---|---|
| Chain ID | `eth_chainId` = 43113 | LIVE-READ |
| Safe v1.4.1 contracts present | SafeProxyFactory `0x4e1D…ec67`, Safe `0x4167…461a`, SafeL2 `0x29fc…C762`, CompatibilityFallbackHandler `0xfd07…Ec99`, MultiSend, MultiSendCallOnly, SignMessageLib, CreateCall, SimulateTxAccessor: all 9 have code on Fuji, **byte-identical** to Avalanche C-Chain | LIVE-READ |
| SafeTx hash parity | The package's offline EIP-712 hash equals `getTransactionHash()` on the live Safe and SafeL2 singletons (`0xa3b8…f48c`, `0x641d…ee8e`) | LIVE-SIM |
| Official Safe config service | `safe-config.safe.global/api/v1/chains/43113/` → **HTTP 404**. Fuji is not listed. | LIVE-READ (public GET) |
| Official Safe client gateway | `safe-client.safe.global/v1/chains/43113` and `/43114` → **HTTP 403** from GitHub runners | **inconclusive** (blocked from CI) |
| Contract-level workflow on a test Safe | Executed end to end; see 5.2 | FORK-EXEC |

**Conclusion.** The Safe contracts on Fuji are canonical and work. **Official Safe{Wallet} web-app or transaction-service support for Fuji is not verified.** The config service does not list chain 43113. No proposed Safe address or backup address exists.

**R1 is therefore BLOCKED at the signing-workflow and address stage. This review stops there.**

### 5.2 What the local fork proved (FORK-EXEC, fork block 59227256)

1. A Safe was created through the canonical factory: `createProxyWithNonce(SafeL2, setup(3 owners, threshold 2, CompatibilityFallbackHandler))`, gas 305,847. `VERSION` reads `1.4.1`; the owners and threshold read back as configured.
2. Safe transactions executed with two owner EIP-712 signatures (`eth_signTypedData_v4`):
   - step 4 used 91,057 gas; step 5 used 74,329;
   - **any** account can submit once the signatures exist.
3. Rejected cases:
   - a single signature;
   - signatures made for chain 43114;
   - a signature from a non-owner (the backup).
4. The generated package's `safeTxHash` equals the test Safe's own `getTransactionHash` for steps 4 and 5.
5. A Safe transaction whose inner call fails reverted as a whole (`Error(string)`, GS013). Per Safe 1.4.1 source, with `safeTxGas = 0` and `gasPrice = 0`, a failed inner call reverts `execTransaction`, so the **nonce is not consumed** and a pre-signed transaction can be retried. The revert is FORK-EXEC; the nonce statement is SOURCE.

**Not proven:**
- that **the owner's** wallets can sign EIP-712 SafeTx data for chain 43113;
- that any UI or transaction service works for Fuji;
- anything about the real Safe, which does not exist yet.

### 5.3 STOP: what the owner must do to clear R1

1. **Choose and confirm the Fuji Safe signing path yourself.** Options:
   - a Safe interface you confirm lists Avalanche Fuji (43113) and shows a SafeTx hash you can compare with the package;
   - your own hardware wallets signing EIP-712 SafeTx data offline, with any account submitting `execTransaction`. The calldata and hashes are in the package; this path needs no UI or transaction service.

   If neither is available on Fuji, decide whether to change R1, for example to a hardware-wallet EOA primary. Do not proceed on an unverified workflow.
2. **Create the Safe** (you sign the creation):
   - SafeL2 v1.4.1 via the canonical factory;
   - 3 owners, threshold 2;
   - no modules, no guard, CompatibilityFallbackHandler (or none).
3. **Choose the backup admin:** a separate hardware wallet with its own seed, stored separately. It must not be a Safe owner, must not be the old key and must not be `0x284C`. Fund it with a small amount of test AVAX.
4. **Send me only the two public addresses.** I then run:
   - `SAFE_AUTHORITY=… BACKUP_ADMIN=… node scripts/safe-readiness-probe.mjs`;
   - the simulator with the same variables.

   All checks in 5.4 must pass.
5. **Recommended live proof before step 1 (S-0).** The Safe executes one no-op transaction to itself (to = Safe, value 0, data `0x`) through your chosen path. This proves on Fuji that your owners can sign and execute, without touching any release contract. It consumes Safe nonce 0, so the package is then generated with `SAFE_NONCE=1`.

### 5.4 Owner/threshold design and the checks enforced before signing

| Element | Design | Why |
|---|---|---|
| Primary | Fresh Safe v1.4.1 (SafeL2), **2-of-3** owners on separate hardware wallets / seeds; no modules, no guard | Survives the loss of one key; needs two compromises |
| Backup | Independent hardware-wallet EOA, cold, **not** a Safe owner | Independent recovery path. For mainnet, upgrade it to its own Safe. |
| Role granted | `DEFAULT_ADMIN_ROLE` only, on `0x7Bba` in P0 | The only role needed to administer (grant, revoke, pause). Neither needs ARTIST or ISSUER. |

`safe-readiness-probe.mjs` (LIVE-READ, run once addresses exist) **must** report:
- the master copy is the canonical Safe or SafeL2 v1.4.1;
- `VERSION` is `1.4.1`;
- threshold ≥ 2 and owners > threshold;
- no modules, no guard, and a canonical or no fallback handler;
- no owner equals the old key, `0x284C` or the backup;
- the backup is not a Safe owner;
- if the backup is a Safe, it shares no owner with the primary;
- current role membership on `0x7Bba` is false for both before step 1.

**Both authorities can administer: FORK-EXEC.**
- After the full P0 run, `grantRole` as a no-op simulates OK from the Safe and from the backup.
- From the old key it is rejected; the old key also cannot mint.
- LIVE-SIM+OVR on current Fuji state gives the same result.

**Lockout paths rejected:**
- The generator never revokes or renounces the Safe or the backup.
- The old admin is removed only by the Safe's own transaction, after both grants and after the backup has acted.
- Unresolved addresses produce **BLOCKED** steps with no calldata.

All of the above is unit-tested in `scripts/authority-rotation-plan.test.mjs`. The verifier also rejects a threshold that cannot tolerate a lost key.

**Residual:** if both the Safe (two of three keys) **and** the backup are lost, `0x7Bba` is permanently unadministered. No on-chain guard exists: renounce by the sole admin simulates OK (LIVE-SIM).

## 6. Legacy sale layout and the two sale closes (R3)

### 6.1 Exact deployed bytecode → source → storage layout (LIVE-READ + SOURCE)

`scripts/legacy-sale-bytecode-check.mjs` compares each deployed runtime with four candidate builds:
- two pre-`80c32af` sources: `fd31295`, `66f4938`;
- two compiler settings: repo `foundry.toml` (solc 0.8.24, optimizer 200, cancun) and the Render image's defaults (solc 0.8.30, optimizer off, prague).

The comparison zeroes immutables and strips metadata. The fingerprints are in `scripts/data/legacy-sale-fingerprints.json`.

| Sale | Runtime bytes | Unique match | `transferOwnership` |
|---|---|---|---|
| `0x51cC` (live) | 4331 | `66f4938`, solc 0.8.24 opt 200 | absent |
| **`0xcc26`** (P-1/P-2 target) | 4196 | **`fd31295`, solc 0.8.24 opt 200** | absent |
| `0x7D1a` | 4196 | `fd31295`, solc 0.8.24 opt 200 | absent |

Storage layout of the matched builds (solc `storageLayout`):

| Slot | Variable |
|---|---|
| 0 | `_status` |
| 1 | `platformFeeBps` |
| 2 | `owner` |
| 3 | `sales` (mapping) |
| 4 | `walletPurchased` |
| 5 | `balances` |

The `Sale` struct occupies five slots:
- `+0` priceWei
- `+1` maxSupply
- `+2` sold
- `+3` perWalletLimit
- `+4` one packed word:
  - startTime: bytes 0–7
  - endTime: bytes 8–15
  - paused: byte 16
  - configured: byte 17

Cross-checked live:
- `eth_getStorageAt(slot 2)` equals `owner()`;
- slot 1 equals `platformFeeBps()`;
- the `sales[token]` slots equal the `sales()` getter for both editions.

### 6.2 P-1 and P-2

| | P-1 | P-2 |
|---|---|---|
| Target | sale `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` (release `0x82b26Da2…82e5`, verified via `releases()`) | same |
| Edition | `33778802922810732976408591241428358474475553907731009337085064305512658576739` | `86336109522257422783953313092869910591261689395232051112421244253165221467155` |
| `artistOf` / `payoutOf` (LIVE-READ) | old key / old key | old key / old key |
| Live sale | price 0.01 AVAX, maxSupply 25 (edition max 25), sold 2, perWallet 1, start 0, end 0, paused false, configured true | price 0.01 AVAX, maxSupply 25, sold 0, perWallet 20, start 0, end 0, paused false, configured true |
| Decoded call | `configureSale(id, 10000000000000000, 25, 1, 0, 0, true)` | `configureSale(id, 10000000000000000, 25, 20, 0, 0, true)` |
| Slot written | `0x55bfa2e9…e0ae52af` (`sales[id]+4`) | `0xb91c1b75…824f8b58` (`sales[id]+4`) |
| Expected delta | byte 16 (`paused`) 0x00 → 0x01; every other byte and slot unchanged | same |
| LIVE-SIM | OK from the old key (56,005 gas) | OK (55,993 gas) |
| LIVE-SIM rejections | unprivileged → `AccessDenied(address)`; `0x284C` → `NotEditionArtist`; old key with ARTIST removed (OVR) → `AccessDenied(address)` | same |
| FORK-EXEC | status 1, 55,203 gas | status 1, 55,191 gas |
| FORK-EXEC storage | **only** `+4` of this edition changed (of the 10 monitored slots of both editions) | same |
| FORK-EXEC log | `SaleConfigured`: price, max and perWallet unchanged; `paused = true` | same |
| FORK-EXEC postconditions | price, maxSupply, sold, perWallet, start, end and configured unchanged; `payoutOf` unchanged | same |
| FORK-EXEC purchases | before close OK; after close `SalePaused(id)` (`0x4616a078`); P-2's edition still open after P-1 | P-1's edition stays closed |

**Payout cannot be redirected.**
- `configureSale` has no payout parameter. `purchase()` reads `releases.payoutOf(tokenId)` (SOURCE), and that value is unchanged after the close (FORK-EXEC).
- `configureSale` writes only `sales[tokenId]` (SOURCE).
- The fork run observed exactly one changed word among the monitored slots.

**Limit:** a full-contract storage diff was not taken. The public RPC returns "unsupported operation" for `eth_createAccessList`, and the fork run monitored the edition slots only.

**Unrelated editions.** The other four old-key editions on `0x82b26` are unconfigured (`SaleNotConfigured`). They stay unsellable, and become permanently unconfigurable after the P1 ARTIST revoke.

**Failure cases:**
- Re-sending a close succeeds and changes nothing (idempotent; FORK-EXEC).
- A close after the old key loses ARTIST reverts `AccessDenied(address)` (FORK-EXEC and LIVE-SIM+OVR).

**The public-RPC purchase simulation was inconclusive** ("missing revert data", even before the close), so the purchase behaviour above rests on FORK-EXEC.

**Ordering.**
- P-1/P-2 must execute before the old key's ARTIST_ROLE is revoked on `0x82b26`. That revoke is a **P1** step, enforced by `requiresCompleted` and a unit test.
- P0 does not touch `0x82b26`.
- P-1/P-2 do not depend on R1 and are fully encoded, so they may be signed in the P0 session.
- Immediately before signing, re-run the simulator and confirm the sale parameters are unchanged.

## 7. P0 sequence: evidence by step and failure cases

The P0 package covers `0x7Bba` only. LIVE-SIM+OVR is from probe run 37913533268 with stand-in addresses; FORK-EXEC is from run 37915673243, with fork-only test Safe and backup.

| # | Signer | Call on `0x7Bba` | LIVE-SIM(+OVR) | FORK-EXEC | Admins after (FORK) |
|---|---|---|---|---|---|
| — | Safe (control) | `revokeRole(ADMIN, old)` before any grant | `AccessDenied(bytes32,address)` | — | {old} |
| 1 | old key | `grantRole(ADMIN, SAFE)` | OK (48,884 gas, LIVE estimate) | status 1, 48,725 gas, `RoleGranted(ADMIN, SAFE, sender old)` | {old, SAFE} |
| 2 | old key | `grantRole(ADMIN, BACKUP)` | OK | status 1, 48,725 gas, `RoleGranted(ADMIN, BACKUP, old)` | {old, SAFE, BACKUP} |
| 3 | BACKUP | `revokeRole(ISSUER, old)` | OK | status 1, 27,090 gas, `RoleRevoked(ISSUER, old, sender BACKUP)`; old key ISSUER false | {old, SAFE, BACKUP} |
| 4 | SAFE (2-of-3) | `revokeRole(ADMIN, old)` | OK | status 1, 91,057 gas, `RoleRevoked(ADMIN, old, sender SAFE)`; one signature rejected | **{SAFE, BACKUP}** |
| 5 | SAFE (2-of-3) | `revokeRole(ARTIST, old)` | OK | status 1, 74,329 gas, `RoleRevoked(ARTIST, old, SAFE)` | {SAFE, BACKUP} |
| end | — | old key grant / mint; Safe / backup admin no-op | old: `AccessDenied`; Safe and backup: OK | same | — |

**Failure cases:**

| Case | Result | Tier |
|---|---|---|
| Wrong address (zero, old key, `0x284C`, a rotated contract, a bad checksum, Safe == backup) | rejected by the generator; no calldata | unit tests |
| Wrong address actually granted | recoverable: the old key revokes it before step 4 | FORK-EXEC |
| Wrong chain | Safe signatures for 43114 rejected by the Safe. EOA steps: the package fixes `chainId` 43113; an EIP-155 signature for another chain is invalid on Fuji. | FORK-EXEC / SOURCE |
| Already-closed edition | idempotent re-close | FORK-EXEC |
| Missing roles | Safe before grant: `AccessDenied(bytes32,address)`; unprivileged grant or revoke: `AccessDenied`; close without ARTIST: `AccessDenied(address)` | LIVE-SIM(+OVR), FORK-EXEC |
| Unresolved Safe configuration | package **BLOCKED** on steps 1–5 (`SAFE_AUTHORITY`, `BACKUP_ADMIN`, `SAFE_NONCE`) | FORK-EXEC output, unit tests |
| Insufficient or foreign signatures | one signature, or a non-owner signature: rejected | FORK-EXEC |
| Old key acts between grant and removal | Safe step 4 fails (see §8) | FORK-EXEC |

**No batch or two-step admin path exists (LIVE-READ).** None of `multicall(bytes[])`, `multicall(uint256,bytes[])`, `beginDefaultAdminTransfer`, `acceptDefaultAdminTransfer` or `execute(address,uint256,bytes)` is present in any of the four release dispatchers.

## 8. Compromised-key race (honest assessment)

**Can a compromised old key act between grant and revoke? Yes.**
- FORK-EXEC: after step 1 the old key revoked the Safe's admin role, and the Safe's step-4 transaction then failed.
- Until step 4 is included in a block, the old key can do anything an admin can:
  - revoke the Safe or backup;
  - grant admin to a third party;
  - pause or unpause;
  - mint, until step 3;
  - create editions, until step 5.

**Is an atomic handoff supported? No.**
- The release contracts have no batch, two-step or execute entry point (LIVE-READ).
- The old key is an EOA, which cannot batch. EIP-7702 delegation could in principle batch an EOA's calls, but C-Chain support is UNVERIFIED, and it would put new code in control of the old key. Not proposed.
- A Safe MultiSend batches only the Safe's own calls (steps 4–5). The grant must come from the old key first, so the window always spans at least two transactions from different signers.
- A helper contract would itself need the admin grant first, which gives the same window.

**Mitigations.** These reduce the race; they do not eliminate it.
1. Collect the Safe signatures for steps 4 and 5 **before** step 1. The hash depends only on the Safe address, chain, nonce and calldata, and the package hash is proven equal to the Safe's own. Step 4 can then be submitted the moment step 3 confirms.
2. Sign steps 1–3 back to back.
3. Between steps, check `RoleGranted`/`RoleRevoked` on `0x7Bba` (§14 STOP conditions).
4. A failed Safe step does not consume the nonce (SOURCE), so it can be retried after re-granting.
5. If hostile actions appear, nobody wins on-chain: there is no role hierarchy.
   - The decisive defensive act is completing step 4.
   - If it is contested repeatedly, the fallback is to abandon `0x7Bba` (Fuji) and move releases to FactoryV2 clones.

**Residual risk.**
- There is no evidence the key is compromised: nonce 59 is unchanged since 2026-10-06, and there are no unexpected role holders.
- The exposure window runs from step 1's inclusion to step 4's inclusion. With pre-signed Safe transactions that should be seconds to minutes.
- The window is **not** zero, and this package does not claim it is.

## 9. App dependencies on the old key and their recovery paths

### 9.1 E2E mint control

**Code.**
- `src/lib/fuji-release.js:20-28`: `FUJI_E2E_MINT.wallet` is hard-coded to the old key.
- That module's plan, encode, preflight and verify functions use it:
  - `assertFujiE2EMintPlan` (~443);
  - `encodeFujiE2EMint` mints `to` that wallet (~457);
  - `readFujiE2EMintPreflight` (~466) requires the connected wallet to be that address **and** to hold ARTIST and ISSUER on `FUJI_RELEASE_CONFIG.contractAddress` = `0x7Bba`;
  - `verifyFujiE2EMint` (~489).

**UI consumers: none.** No component imports these functions (SOURCE). No production user flow calls them. They serve the Fuji certification/E2E procedure.

**Coupled constant.** `src/lib/studio-wallet-catalog.js:6` (`STUDIO_ADMIN_DEPLOYER_WALLET = FUJI_E2E_MINT.wallet`), used by `ArtistStudioPage.jsx:197`, hides Voidcaller profiles when the deployer wallet connects. Role rotation does not affect it, but changing the E2E wallet would silently change this filter.

**Tests:**
- `src/lib/fuji-release.test.js` and `src/lib/studio-wallet-catalog.test.js` (mocked; no chain);
- `server/production-gate-readiness.test.js` uses the address only as a DB fixture.

**Effect of P0.** The preflight fails from step 3 (ISSUER) and step 5 (ARTIST). E2E mint on `0x7Bba` is unavailable until migrated.

**Recovery plan.** A separate PR after approval; nothing is changed now.
1. Decouple `STUDIO_ADMIN_DEPLOYER_WALLET` into its own constant.
2. Move the E2E wallet into `config/fuji-release.json` (`e2eWallet`). Make it a **fresh test EOA with no admin role**.
3. Either:
   - (a) preferred: run E2E on a FactoryV2 clone owned by the E2E wallet, which needs no platform grant; or
   - (b) have the Safe grant ARTIST and ISSUER on `0x7Bba` to the E2E wallet (one Safe transaction each).
4. Update both unit-test files, and add a test asserting the E2E wallet holds no admin role.
5. Re-run the E2E acceptance matrix.

### 9.2 In-app publishing-role grant

**Code.**
- `src/components/VerifyPages.jsx:500-548`: `OnChainRolesPanel` on route `verify/review/:id`.
- The grant button appears only if the connected wallet holds DEFAULT_ADMIN on `0x7Bba` (`canMutateFujiPublishingRoles`, `src/lib/fuji-release.js:708-710`).
- `grantPublishingRoles` (`src/lib/fuji-release.js:748+`) also supports a reviewer path through `VoidRoleGranter`. However, `config/fuji-release.json` has no `roleGranterAddress` (it is not deployed), and the panel's admin gate hides the button before that path is reached.
- Test: `src/components/OnChainRolesPanel.test.jsx`.

**Affected flow.** A reviewer approves an application; an admin wallet then grants ARTIST and ISSUER on `0x7Bba` so the artist can publish on the shared release.

**Effect of P0.**
- The only admins are the Safe and the cold backup.
- A Safe cannot use this dapp button on Fuji unless a Safe app or WalletConnect path supports 43113 (UNVERIFIED; the config service returns 404).
- The backup should not be used for routine grants.
- **The in-app grant stops working for `0x7Bba`.**

**Recovery paths:**
- **A, immediate:** the Safe executes `grantRole(ARTIST, artist)` and `grantRole(ISSUER, artist)` through the verified Safe workflow, per approved application. This is manual. The generator can be extended to emit these with hashes.
- **B, recommended engineering path:** a separate PR plus a separate owner-signed deployment.
  1. Deploy `contracts/VoidRoleGranter.sol` for `0x7Bba` with `owner = SAFE` and an explicit reviewer list.
  2. The Safe grants it DEFAULT_ADMIN_ROLE. The custom AccessControl requires admin to call `grantRole`. Its code can only grant or revoke ARTIST and ISSUER, and cannot touch the Safe or backup (SOURCE).
  3. Set `roleGranterAddress`.
  4. Change `OnChainRolesPanel` to show the button for granter reviewers; `readRoleGranterReviewer` and the library path already exist.
  5. Add tests.

  Note: this adds a contract admin, and ISSUER grants still allow direct unpaid minting, as today.
- **C, long term:** onboard artists on FactoryV2 per-artist releases, which need no platform role grant. This depends on the album redeploy decisions D1–D5.

## 10. Residual risks

1. **Locked-sale fee power (R6, accepted).**
   - The old key, or anyone holding it, can set the platform fee on `0x51cC`, `0xcc26` and `0x7D1a` to any value from 0 to 500 bps, permanently.
   - It cannot raise the fee: above 500 reverts `FeeAboveCap` (`0x7159abd8`, LIVE-SIM).
   - It cannot redirect payouts, mint or move funds. The worst case is loss of the platform's 5% share on those sales.
2. **Six immutable payout destinations on `0x82b26`.** These pay the old key forever:

   ```
   32973968306772830434393710851061790601314118564265222743771059411608976358491
   23685155712394957401511510495110946071855190423032439714405816634523406427325
   9404686040103260377530222232027412559186112217689961434973498871367969795642
   33778802922810732976408591241428358474475553907731009337085064305512658576739
   86336109522257422783953313092869910591261689395232051112421244253165221467155
   69621777096996404494569967715110965261109496187347335164928263396549073080909
   ```

   - The two OPEN ones are closed by P-1/P-2.
   - The other four are unconfigured, and become unconfigurable after the P1 ARTIST revoke.
   - 0.019 AVAX stays withdrawable only by the old key (P-3 deferred).
3. **`0x284C` mint authority (R5, unresolved).**
   - It holds ARTIST and ISSUER on `0x7Bba` and `0x82b26`, so it can mint directly without sale payment.
   - It is admin/owner of the FactoryV2 clones, platform fee recipient on the legacy sales, and owner of mainnet `0xd1b4`.
   - Its controller is UNVERIFIED. **This needs a separate security decision.**
4. **Possible GitHub secret exposure.**
   - `DEPLOYER_PRIVATE_KEY` is strongly indicated to be the old key; the address is masked.
   - It is referenced by 4 workflows, including the per-contract album redeploy and mainnet.
   - The mainnet workflow has never run.
   - All are `workflow_dispatch`, so anyone with write access could dispatch the Fuji workflows using this key.
   - Other possible copies (the Render cron env, local machines) are UNVERIFIED.
5. **Unverified off-chain items:**
   - the contents of `MARKETPLACE_ADMIN_WALLETS` and `VERIFICATION_REVIEWER_WALLETS`;
   - the `artist_owners` rows for the old key;
   - who holds the E2E wallet key;
   - who controls `0x284C`;
   - the owner's ability to sign Fuji SafeTx data;
   - Safe UI and transaction-service support for 43113.

## 11. Remaining blockers

| # | Blocker | Owner action |
|---|---|---|
| B1 | No verified Fuji Safe signing workflow | §5.3 step 1 |
| B2 | No Safe address (`SAFE_AUTHORITY`) and no Safe nonce | §5.3 steps 2 and 5 |
| B3 | No backup address (`BACKUP_ADMIN`) | §5.3 step 3 |
| B4 | Readiness checks on the real Safe and backup not yet run | Send the two public addresses |
| B5 | App dependencies: E2E and in-app grant | Approve recovery path 9.1 and 9.2 (A/B/C) before or with P0 |
| B6 | Off-chain read access: API lists, `artist_owners` | Owner checks (§12) |

## 12. Off-chain privilege inventory (R8 input)

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

## 13. R8 cutover items: dependencies first, nothing changed

Each item is independent of the on-chain rotation and of the others. Do not delete or modify anything until its replacement is verified.

| Item | What depends on it today | Replacement needed first | Verify before change | Earliest point |
|---|---|---|---|---|
| GitHub `DEPLOYER_PRIVATE_KEY` (+ `RELEASE_ADMIN_ADDRESS`) | `deploy-release-fuji.yml`, `deploy-release-per-contract-fuji.yml` (the pending album redeploy, D1–D5), `deploy-release-v2-fuji.yml` (×2), `deploy-release-v2-mainnet.yml` (never run) | A decision on who deploys the album-capable FactoryV2. Recommended: owner-signed, with no hot key in CI. | The Fuji workflows fail closed at preflight without the key (SOURCE); confirm no scheduled workflow uses it | After P0..ALL verified, before any album redeploy |
| Render cron `crn-dat953e0tbcc73acrepg` key | Only the suspended cron | None. The cron stays suspended; retiring it is M1. | Suspended state (`suspenders ["user"]`); an env change does not trigger a run (verified earlier) | Any time after the owner approves; not required for P0 |
| Render API `MARKETPLACE_ADMIN_WALLETS`, `VERIFICATION_REVIEWER_WALLETS` | Marketplace presentation admin and verification reviewers (`server/marketplace-presentation-service.js:22`, `server/verification-service.js:33`). Unset means fail closed. | The intended reviewer and admin wallets | Owner reads the values in the Render dashboard (UNVERIFIED here) | After the owner confirms whether the old key is listed |
| Studio `artist_owners` | Studio publishing authorization (`/studio/catalog`) | The owning wallet for each affected artist | Owner runs the §12 query | Through a reviewed migration only |
| E2E wallet | §9.1: `FUJI_E2E_MINT.wallet`, coupled Studio filter constant, acceptance matrix | Fresh test EOA, or a FactoryV2 clone owned by it | Unit tests updated; E2E re-run | Separate PR; E2E is unavailable on `0x7Bba` from P0 step 3 |

## 14. P0 unsigned package and manual signing checklist

**Package status: BLOCKED.** `SCOPE=P0 node scripts/authority-rotation-plan.mjs` returns `status: BLOCKED`, `blockedOn: [SAFE_AUTHORITY, BACKUP_ADMIN, SAFE_NONCE]`.

Calldata for steps 1–2 is **not encoded**, because it depends on unresolved addresses. Steps 3–5 have fixed calldata but remain blocked. Re-generate with the real addresses after §5.3. The generator then also emits the SafeTx and `safeTxHash` for steps 4–5.

**Chain for every step: Avalanche Fuji C-Chain, chainId 43113. Value 0.** Abort if the wallet shows any other chain.

### Pre-flight (read-only, immediately before signing)

1. Run `SAFE_AUTHORITY=… BACKUP_ADMIN=… node scripts/safe-readiness-probe.mjs`. Every check in §5.4 must be true.
2. Run `SAFE_AUTHORITY=… BACKUP_ADMIN=… node scripts/authority-rotation-simulate.mjs`. Every step must simulate OK; the sale parameters for P-1/P-2 must be unchanged.
3. Run `SUBJECT=0xaBd3…c174 NEW_AUTHORITY=<SAFE> node scripts/authority-inventory.mjs`. Role holders on `0x7Bba` must be:
   - DEFAULT_ADMIN = {old};
   - ARTIST = {old, `0x284C`};
   - ISSUER = {old, `0x51cC`, `0x284C`}.

   **STOP** if anything else appears.
4. Check funding:
   - the old key holds 0.4875 test AVAX;
   - the backup and the Safe-transaction submitter each hold a small amount of test AVAX.
5. Safe owners pre-sign steps 4 and 5. Each owner compares the hash on their device with `safeTxHash` in the package. **STOP** on any mismatch.
6. Optional (recommended): S-0, the Safe no-op self-transaction (§5.3, step 5).

### Pre-steps (independent of R1; may run in the P0 session)

| Step | Signer | To | Function / decoded args | Calldata | Expected change | Gas | Evidence | Postcondition | STOP if |
|---|---|---|---|---|---|---|---|---|---|
| P-1 | old key (EOA) | `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` | `configureSale(33778802922810732976408591241428358474475553907731009337085064305512658576739, 10000000000000000, 25, 1, 0, 0, true)` | `0x23a126174aae1ffba437e9e91d04ea8032dfa64a3e8ed673475793a65bea7c266cf12563000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001` | `sales[id].paused` false → true | LIVE est. 56,005; FORK 55,203 | LIVE-SIM OK; FORK-EXEC OK | `sales(id).paused == true`; other fields unchanged; `payoutOf` unchanged | Receipt status ≠ 1, or any `SaleConfigured` field other than `paused` differs |
| P-2 | old key (EOA) | same | `configureSale(86336109522257422783953313092869910591261689395232051112421244253165221467155, 10000000000000000, 25, 20, 0, 0, true)` | `0x23a12617bee0819ca9eed9d3493d57d05d81ffbd949d97dd4fdab700a285dcad6cbe5413000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001` | same | LIVE 55,993; FORK 55,191 | same | same | same |

### P0 (`0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6`)

| Step | Signer | Function / decoded args | Calldata | Expected change | Gas | Evidence | Postcondition | STOP if |
|---|---|---|---|---|---|---|---|---|
| 1 | old key (EOA) | `grantRole(DEFAULT_ADMIN_ROLE, SAFE)` | **BLOCKED: SAFE_AUTHORITY** | SAFE becomes admin; old key keeps all roles | ≈48.7–48.9k | LIVE-SIM+OVR OK; FORK-EXEC OK | `hasRole(ADMIN, SAFE)`; exactly one `RoleGranted`, naming SAFE | Status ≠ 1, or any other grant or revoke on `0x7Bba` |
| 2 | old key (EOA) | `grantRole(DEFAULT_ADMIN_ROLE, BACKUP)` | **BLOCKED: BACKUP_ADMIN** | BACKUP becomes admin | ≈48.7–48.9k | same | Admin holders = {old, SAFE, BACKUP} | Same; or SAFE's admin role was revoked: go straight to step 4 only if SAFE is still admin |
| 3 | BACKUP | `revokeRole(ISSUER_ROLE, 0xaBd3…c174)` | `0xd547741f114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` (fixed; **BLOCKED** until BACKUP is verified) | Old key loses ISSUER; proves the backup | ≈27.1k (FORK) / ≈32.4k (LIVE estimate) | LIVE-SIM+OVR OK; FORK-EXEC OK | `RoleRevoked(ISSUER, old, sender BACKUP)` | The backup cannot sign or the transaction reverts. **Do not run step 4.** Recovery: the old key revokes BACKUP and SAFE, then re-plan. |
| 4 | SAFE (2-of-3, CALL) | `revokeRole(DEFAULT_ADMIN_ROLE, 0xaBd3…c174)` | `0xd547741f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` (fixed; **BLOCKED: SAFE_AUTHORITY, SAFE_NONCE**) | Old key loses admin; proves the Safe | ≈91k for the submitter | LIVE-SIM+OVR OK; FORK-EXEC OK; hash parity OK | Admin holders = {SAFE, BACKUP} **exactly** | Any third admin appears: the Safe revokes it **before** anything else. If execution fails, the nonce is not consumed; investigate the race (§8). |
| 5 | SAFE (2-of-3, CALL) | `revokeRole(ARTIST_ROLE, 0xaBd3…c174)` | `0xd547741f877a78dc988c0ec5f58453b44888a55eb39755c3d5ed8d8ea990912aa3ef29c6000000000000000000000000abd3746e8b852f55be52fc44fab6cab908b1c174` (fixed; **BLOCKED: SAFE_AUTHORITY, SAFE_NONCE**) | Old key loses ARTIST | ≈74k | same | Old key has no role on `0x7Bba` | Status ≠ 1 |

### After P0 (read-only)

1. Re-run the inventory with `NEW_AUTHORITY=<SAFE>` and confirm on `0x7Bba`:
   - DEFAULT_ADMIN = {SAFE, BACKUP};
   - ARTIST = {`0x284C`};
   - ISSUER = {`0x51cC`, `0x284C`};
   - every `subject.*` is false.
2. Confirm that live sales on `0x51cC` still work. The sale holds its own ISSUER role, which the rotation does not change.
3. **STOP.** Report, and wait for owner approval before any P1 or ALL work.

All rows above are **unsigned instructions**. "OK" in an evidence column means a simulation or a local-fork execution, **never** an executed Fuji transaction.

## 15. Gates kept

- **The Fuji archive/reconciliation gate stands.** P0 changes no marketplace, listing or indexer configuration, and does not undo the legacy marketplace deployments.
- **No mainnet-readiness claim.** The mainnet workflow still references `DEPLOYER_PRIVATE_KEY`, and its handoff design must be re-reviewed against this rotation before any mainnet work.
- **P1 and ALL are not covered by this review.** They need their own review and approval after P0 is executed and verified.
