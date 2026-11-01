# P0 Pre-Execution Decision Report: Deployer Authority Rotation (Fuji)

**PR #142.** The evidence base was reviewed at `89112ec`. The signing-path helpers and their fork rehearsal are at `eedd088`; this report is in the commit after it.

**Status: BLOCKED.** P0 cannot be executed until the prerequisites in §8 are met.

**Mode:** review only.
- No transaction was signed, broadcast or executed on Fuji or any other network.
- No credential, access list or production setting was changed.
- The cron `crn-dat953e0tbcc73acrepg` stays suspended.
- PR #142 is not merged.

**Scope:** P0 only, which is the live shared release `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6`.
- P1 and ALL are not started.
- **Nothing here claims mainnet readiness.**
- The Fuji archive/reconciliation gate stays in force.

**Evidence base.** Detail is in `DEPLOYER-AUTHORITY-ROTATION-PLAN.md`. The CI, the read-only probes and the local-fork rehearsal are **evidence for review, not authorization to execute.**
- **FORK-EXEC** means a transaction executed on a local anvil fork of Fuji. It never reached Fuji.
- **LIVE-SIM** means an `eth_call` against Fuji state.
- **LIVE-READ** means a state read from Fuji.

---

## 1. Establishing and testing a Fuji Safe signing path

No step below is performed by Claude. Steps marked **owner-run** are actions you take with your own wallets; the rest are read-only checks.

### Phase A — wallet and chain setup (no transactions)

**A1. Configure every wallet that will act.** That is three Safe owners (O1, O2, O3), one backup (B), and any wallet that submits transactions.

| Field | Value |
|---|---|
| Network | Avalanche Fuji C-Chain |
| Chain ID | **43113** (hex `0xa869`) |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` |
| Currency | AVAX (test) |
| Explorer | `https://testnet.snowtrace.io` |

**A2. Check that the RPC reports 43113** (read-only):
```bash
cast chain-id --rpc-url https://api.avax-test.network/ext/bc/C/rpc      # must print 43113
```
or:
```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  https://api.avax-test.network/ext/bc/C/rpc                            # must return "0xa869"
```

**A3. Record only the public address of each wallet.** Do not assume a wallet can sign on Fuji until A4 and Phase C prove it.

**A4 (optional, owner-run, harmless).** Each wallet sends **0 AVAX to itself** on Fuji. Then verify it read-only:
```bash
cast tx <TX_HASH> --rpc-url https://api.avax-test.network/ext/bc/C/rpc chainId   # must print 43113
cast tx <TX_HASH> --rpc-url https://api.avax-test.network/ext/bc/C/rpc from      # must equal that wallet
```
This proves the device signs EIP-155 transactions for 43113. It costs only gas and changes no contract.

### Phase B — create the Safe (owner-run, one transaction)

**B1.** You send me the three owner addresses and a salt number.

**B2.** I generate the creation transaction and validate the inputs:
```bash
SAFE_OWNERS=<O1>,<O2>,<O3> SALT_NONCE=<n> BACKUP_ADMIN=<B> node scripts/authority-rotation-plan.mjs
```
- Field `safeCreation`: `to` = SafeProxyFactory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, value 0.
- The calldata is `createProxyWithNonce(SafeL2 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762, setup(owners, 2, 0x0, 0x, CompatibilityFallbackHandler 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99, 0x0, 0, 0x0), salt)`.
- The generator rejects:
  - fewer or more than 3 owners, or duplicate owners;
  - the old key, `0x284C`, or any rotated contract as an owner;
  - the backup as an owner;
  - any threshold other than 2.

**B3. Predict the Safe address** (read-only `eth_call` simulation):
```bash
cast call 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 <CALLDATA> --from <O1> \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc
```

**B4 (owner-run).** One owner wallet sends the creation transaction (chain 43113, value 0).

**B5. Verify** (read-only):
```bash
SAFE_AUTHORITY=<SAFE> BACKUP_ADMIN=<B> node scripts/safe-readiness-probe.mjs
```
Every check in §2.3 must be true.

### Phase C — harmless Safe test transaction S-0 (owner-run signatures, owner-run submit)

S-0 has the Safe call **itself** with value 0 and empty data (`buildSafeSelfTest`). It:
- consumes one Safe nonce;
- emits `SafeReceived` and `ExecutionSuccess`;
- changes no release, sale, role or balance.

**C1. Generate S-0:**
```bash
SAFE_AUTHORITY=<SAFE> SELF_TEST_NONCE=0 node scripts/authority-rotation-plan.mjs
```
Field `selfTest` gives the `safeTxHash` and the EIP-712 `typedData`, with domain `{chainId: 43113, verifyingContract: SAFE}`.

**C2 (owner-run). Two owners each sign the typed data offline.** Signing broadcasts nothing. Use one of two paths:
- **Path 1: a Safe interface you have confirmed lists Avalanche Fuji (43113).** The hash it shows must equal `safeTxHash`.
- **Path 2: no UI.** Save `typedData` as `s0.json`, then run:
  ```bash
  cast wallet sign --data --from-file s0.json --ledger   # or --trezor
  ```

**STOP** if the device shows a chain other than 43113, a different hash, or a target other than the Safe itself.

**C3. Verify offline** (no network, no keys):
```bash
node scripts/verify-safe-signatures.mjs s0-request.json
```
- `s0-request.json` contains: `safe`, `chainId: 43113`, `owners`, `threshold: 2`, `tx: selfTest.safeTx`, `signatures`.
- The verifier recovers each signer from the exact hash. It **fails closed** on a wrong chain, wrong Safe, wrong nonce, non-owner, duplicate or single signature.
- It prints the signatures in the ascending-owner order Safe requires.

**C4 (owner-run). Any funded wallet submits** `execTransaction(SAFE, 0, 0x, 0, 0, 0, 0, 0x0, 0x0, <signatures>)` on chain 43113.

**C5. Postconditions** (read-only):
- Safe `nonce()` is 1.
- An `ExecutionSuccess` log is emitted.
- Role membership on `0x7Bba` is unchanged:
  ```bash
  SUBJECT=0xaBd3…c174 NEW_AUTHORITY=<SAFE> node scripts/authority-inventory.mjs
  ```
- Then generate P0 with `SAFE_NONCE=1`.

**Rehearsal (FORK-EXEC) — what it proves.** The fork job ran this exact path with test owners:
- generator calldata;
- predicted address;
- creation;
- S-0 signed through `eth_signTypedData_v4` and verified by the offline verifier;
- submission.

It proves the contract-level path. **It does not prove your devices can sign for 43113**; Phase C on Fuji does.

## 2. Safe and backup requirements (no addresses invented)

### 2.1 Primary Safe

- Safe v1.4.1 created from the canonical SafeL2 singleton via the canonical factory. Both are LIVE-READ byte-identical to C-Chain.
- **2-of-3.** Three owners on **separate hardware wallets with separate seeds**, ideally kept in separate locations.
- No modules, no guard. Fallback handler is CompatibilityFallbackHandler (or none).
- No owner is the old key `0xaBd3…c174`, `0x284C…180a`, the backup, or any contract in the inventory.

### 2.2 Backup admin

- An independent hardware-wallet EOA with its own seed, stored apart from the owner keys and kept cold.
- **Not** a Safe owner. Not the old key. Not `0x284C`.
- A small test-AVAX balance for its one proof transaction (P0 step 3).

### 2.3 Checks that must pass before step 1 (`safe-readiness-probe.mjs`, LIVE-READ)

- The master copy is canonical v1.4.1 and `VERSION` is `1.4.1`.
- Threshold ≥ 2 and owners > threshold.
- No modules, no guard, and a canonical or no fallback handler.
- No forbidden owner, and the backup is not an owner.
- Neither the Safe nor the backup holds any role on `0x7Bba` yet.
- **Plus:** S-0 has succeeded on Fuji.

**Wallet support is not assumed.**
- No owner wallet is treated as able to sign on Fuji until it has produced a signature that `verify-safe-signatures.mjs` accepts for chain 43113 (C3), and S-0 has executed (C4–C5).
- The backup is proven only by P0 step 3; A4 is an optional earlier check.

## 3. Compromised-key race and recovery

**The deployed contracts do not support atomic handoff.**
- None of the four releases has `multicall`, a two-step admin transfer or `execute` (LIVE-READ dispatcher check).
- The old key is an EOA and cannot batch calls.
- The grant (old key) and the removal (Safe) are separate transactions from different signers.

**Residual race.** From the inclusion of step 1 until the inclusion of step 4, the old key is still an admin. If it is compromised, it can:
- revoke the Safe or the backup;
- grant admin to a third party;
- pause or unpause;
- mint, until step 3;
- create editions, until step 5.

FORK-EXEC confirmed this: after the grants, the old key revoked the Safe, and the Safe's removal step then failed.

**Mitigations.** These reduce the window; they do not eliminate it.
1. Collect both Safe signatures for steps 4 and 5 **before** step 1, and verify them with C3.
2. Sign steps 1–3 back to back.
3. Submit step 4 the moment step 3 confirms.

**Recovery procedure if the old key revokes a newly granted authority.**

| Situation (detected by `RoleRevoked`/`RoleGranted` on `0x7Bba`, or a failed step-4 receipt) | Response | Evidence |
|---|---|---|
| Safe revoked; backup still admin | 1. STOP all other signing. 2. The **backup** sends `grantRole(DEFAULT_ADMIN_ROLE, SAFE)`. 3. The **backup** sends `revokeRole(DEFAULT_ADMIN_ROLE, old)`, calldata `0xd547741f` + 32 zero bytes + old key, the same as step 4. 4. Resubmit the **same pre-signed** Safe step 4. The failed attempt did not consume the nonce, so it now succeeds as a no-op. 5. Continue with step 5. | FORK-EXEC (§7) |
| Backup revoked; Safe still admin | Submit the pre-signed step 4 immediately. Then the Safe re-grants the backup, as a new Safe transaction. | Same mechanism |
| Both revoked (only the old key is admin) | No on-chain winner exists. Only the old key can re-grant, and the attacker holds it too. **Stop, and treat `0x7Bba` as contested.** Its edition data and sale proceeds are unaffected, but administration is not trustworthy. Fallback: freeze reliance on `0x7Bba` and move releases to FactoryV2 clones, a separate decision. | FORK-EXEC (both-revoked case) |
| Third-party admin granted | After step 4, the Safe revokes it **before anything else**, then re-runs the inventory. | Log reconstruction |
| Paused by the old key | After step 4, the Safe or backup sends `unpause()`. | SOURCE |
| Unauthorized mint before step 3 | Cannot be reversed. Record the `TransferSingle` events. It is bounded by the remaining supply of existing editions. | SOURCE |

## 4. P-1 / P-2 ordering and checks

**Ordering is verified.**
- `configureSale` on `0xcc26` checks ARTIST_ROLE on **its own** release, `0x82b26` (`releases()` LIVE-READ).
- P0 changes roles only on `0x7Bba`. FORK-EXEC confirms the old key can still close after P0.
- The old key loses ARTIST on `0x82b26` only in **P1**. The generator marks that step `requiresCompleted: ["P-1", "P-2"]`, and a unit test enforces it.
- A close attempted after that revoke reverts with `AccessDenied(address)` (FORK-EXEC, LIVE-SIM).

**Manual-signing checks for each pre-step** (old key, chain 43113, to `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1`, value 0):

| | P-1 | P-2 |
|---|---|---|
| Decoded call | `configureSale(33778802922810732976408591241428358474475553907731009337085064305512658576739, 10000000000000000, 25, 1, 0, 0, true)` | `configureSale(86336109522257422783953313092869910591261689395232051112421244253165221467155, 10000000000000000, 25, 20, 0, 0, true)` |
| Calldata | in `DEPLOYER-AUTHORITY-ROTATION-PLAN.md` §14 (unchanged) | same |
| Before signing | Re-run `node scripts/authority-rotation-simulate.mjs`. The live sale parameters must equal the decoded args. | same |
| Expected change | `sales[id].paused`: false → true (slot `sales[id]+4`, byte 16) | same |
| Postcondition | `sales(id).paused == true`. Price, maxSupply, sold, perWallet, start, end and configured are unchanged. `payoutOf(id)` is unchanged. `purchase` reverts `SalePaused(id)`. | same; P-1's edition is still closed |
| STOP if | Receipt status ≠ 1, or any `SaleConfigured` field other than `paused` differs | same |

## 5. What can be prepared now, and what must stay blocked

| Item | Status | Why |
|---|---|---|
| P-1, P-2 calldata and checks | **Prepared** (fully encoded, LIVE-SIM and FORK-EXEC verified) | Independent of the new addresses; still needs your approval and signature |
| Steps 3, 4, 5 calldata (`revokeRole` of the old key) | **Prepared, not executable** | Fixed bytes, but the signer (backup or Safe) does not exist yet |
| Recovery calldata `revokeRole(DEFAULT_ADMIN_ROLE, old)` for the backup | **Prepared** | Same bytes as step 4 |
| Safe creation **parameters** (singleton, factory, handler, threshold 2) | **Prepared** | Canonical and verified |
| Signing tools: typed-data export, `cast` command, offline verifier | **Prepared** | Unit-tested and FORK-EXEC-tested |
| Safe creation **calldata** and predicted address | **BLOCKED** | Needs the 3 owner addresses and a salt |
| S-0 SafeTx and hash | **BLOCKED** | Needs the Safe address (nonce 0 after creation) |
| Step 1 `grantRole(ADMIN, SAFE)` | **BLOCKED** | Needs the Safe address |
| Step 2 `grantRole(ADMIN, BACKUP)` | **BLOCKED** | Needs the backup address |
| SafeTx hashes for steps 4, 5 | **BLOCKED** | Needs the Safe address and the nonce after S-0 |
| Recovery `grantRole(ADMIN, SAFE)` from the backup | **BLOCKED** | Needs the Safe address |
| Readiness checks on the real Safe and backup | **BLOCKED** | Need the addresses |

The generator never encodes a placeholder. Any address-dependent step is emitted with `calldata: null` and `blockedOn` (unit-tested).

## 6. Unresolved items (kept visible)

1. **`0x284C…180a` direct-mint authority (R5).**
   - It holds ARTIST and ISSUER on `0x7Bba` and `0x82b26`, so it can mint without sale payment.
   - It is admin/owner of the FactoryV2 clones, the fee recipient on the legacy sales, and owner of mainnet `0xd1b4`.
   - Its controller is UNVERIFIED. **Unchanged by P0; a separate security decision.**
2. **Six fixed payout destinations.** These editions on `0x82b26` pay the old key permanently:
   - `3297396830…8491`
   - `2368515571…7325`
   - `9404686040…5642`
   - `3377880292…6739` (open; closed by P-1)
   - `8633610952…7155` (open; closed by P-2)
   - `6962177709…0909`

   The 0.019 AVAX pending balance stays withdrawable only by the old key (P-3 deferred).
3. **Locked-sale fee power (R6, accepted).**
   - On `0x51cC`, `0xcc26` and `0x7D1a`, the old key can set the platform fee anywhere from 0 to 500 bps, permanently.
   - It cannot exceed 500 (`FeeAboveCap`), redirect payouts, mint or move funds.
4. **Off-chain cutovers.** All remain unchanged and open; dependencies are in plan §13.
   - GitHub `DEPLOYER_PRIVATE_KEY` and `RELEASE_ADMIN_ADDRESS`. Possible exposure; used by 4 workflows, including the album redeploy and mainnet.
   - The suspended Render cron's key.
   - `MARKETPLACE_ADMIN_WALLETS` and `VERIFICATION_REVIEWER_WALLETS` (contents UNVERIFIED).
   - Studio `artist_owners` rows (UNVERIFIED).
   - The E2E wallet.
5. **App consequences of P0** (recovery paths in plan §9).
   - The E2E mint control stops working from step 3.
   - The in-app publishing-role grant stops working once the old key is no longer admin.
6. **UNVERIFIED:**
   - Safe UI and transaction-service support for 43113 (the config service returns 404);
   - your devices' EIP-712 signing on 43113;
   - a full storage diff of the sale contract;
   - purchase simulation through the public RPC.

## 7. Fork rehearsal of this report's procedures (FORK-EXEC)

Run [37919796085](https://github.com/VoidcallerOC/The-Void/actions/runs/37919796085), job 113784704525, head `eedd088`, on a local anvil fork of Fuji at block 59228174. Nothing reached Fuji. The owners, backup and submitter are anvil test accounts, not proposals.

| Procedure | Result |
|---|---|
| Safe creation from `buildSafeCreation` calldata | status 1, 305,847 gas. Predicted address (`eth_call`) = created address. `VERSION` 1.4.1; 3 owners; threshold 2. |
| S-0 self-test | Offline verifier accepted both signatures. Executed with status 1, 83,722 gas; nonce 0 → 1; **roles on `0x7Bba` unchanged**. |
| P0 steps 1–5 (Safe nonce 1–2 after S-0) | All status 1. Package `safeTxHash` = the Safe's own hash for steps 4 and 5. Offline signature check passed. One signature rejected. Final admins: {SAFE, BACKUP}; the old key cannot administer or mint. |
| Race: the old key revokes the Safe after steps 1–2 | Safe step 4 failed (status 0) and its **nonce was not consumed**. |
| Recovery | The backup re-granted the Safe (status 1) and removed the old admin (status 1). The **same pre-signed** Safe step was then retried (status 1, nonce → 2). Admins: {SAFE, BACKUP}; old key false. |
| Worst case: both new admins revoked | Only the old key remains admin. No on-chain recovery path exists beyond the old key itself. |
| Close still authorized after P0 | true. P0 does not touch `0x82b26`. |
| Other failure cases | Wrong-chain and non-owner Safe signatures rejected; idempotent re-close; close without ARTIST reverts `AccessDenied(address)`; mistaken grant recoverable by the old key; unresolved configuration → BLOCKED. |

## 8. Remaining prerequisites (in order)

1. Three owner wallets and one backup wallet: separate hardware wallets and seeds, each configured for chain 43113 (A1–A3). Public addresses only, sent to me.
2. I validate them (read-only: EOAs, distinct, not forbidden, backup not an owner) and produce the creation calldata and predicted address (B2–B3).
3. You approve and send the Safe creation (B4).
4. Readiness probe passes on the real Safe and backup (B5).
5. S-0 is signed, verified offline, executed and post-checked on Fuji (C1–C5).
6. P0 package generated with real addresses and `SAFE_NONCE=1`. Steps 4 and 5 are pre-signed and verified offline.
7. Decide recovery paths for the E2E mint and in-app grant before or with P0 (plan §9).
8. Your explicit approval of P-1, P-2 and P0 steps 1–5, signed manually per plan §14.

After P0: verify, report and stop. P1 and ALL each need a separate review.

## 9. Next single owner action

**Set up four separate hardware wallets on Avalanche Fuji (chain 43113) — three Safe owners and one backup — and send me only their four public addresses, labelled O1, O2, O3 and BACKUP.**
