# Deploying the owner's existing 2-of-3 Safe on Fuji (no Safe web app, no Safe Pro)

**Status: BLOCKED** on one input: the Safe's exact setup data (§3). Everything else is verified.

**Mode:**
- Read-only investigation and offline preparation.
- Nothing was signed, broadcast or deployed.
- The cron stays suspended.
- PR #142 is not merged.

**Safe:** `0xec40c3CE983A2F3bB4a241EBAd4e0a8C261aeA10`. The checksum is valid. The Safe is configured in the owner's Safe app as 2-of-3 and is **not activated**: there is no code on Fuji (43113) or C-Chain (43114) (probe run 37926037488).

## 1. Can the same Safe exist on Fuji at the same address? Yes, if its setup is recovered exactly

A Safe's address is computed (CREATE2) from five inputs:
- the factory address;
- the salt nonce;
- the initializer, which holds the owners, threshold, fallback handler and any setup call;
- the singleton;
- the factory's proxy creation code.

If the Safe was set up with `createProxyWithNonce` (no chain id in the salt), the same inputs give the **same address on every chain** whose factory, singleton and proxy code are identical.

The address is a one-way hash, so **the owners cannot be read back from it**. A candidate setup is proven exact only when it recomputes to this address. `scripts/safe-counterfactual.mjs` does that check.

## 2. What is verified on-chain (read-only, run 37928170405, head `929750b`)

| Check | Safe 1.4.1 | Safe 1.3.0 |
|---|---|---|
| Factory code, Fuji = C-Chain | identical (`0x4e1D…ec67`) | identical (`0xa6B7…6AB2`) |
| Singleton and SafeL2 singleton, Fuji = C-Chain | identical | identical |
| Fallback handler, Fuji = C-Chain | identical | identical |
| `proxyCreationCode()`, Fuji = C-Chain | identical (`0x1856e0ee…`) | identical (`0x44425997…`) |
| Offline address predictor vs the live factory (`eth_call`, both chains) | match, plain and chain-specific | match |
| Same predicted address on both chains (plain salt) | yes | yes |
| Predictor vs a Safe actually created (local fork, run 37928170405 `fork-rehearsal`) | match (`offlinePredictorMatchesCreated: true`) | — |

Both chains report their chain IDs correctly (43113 and 43114).

**Conclusion.**
- **The factory, singleton, proxy creation method and deployment bytecode are correct and identical on Fuji.**
- **The address computation is independently verified** against the live factories and against a real deployment.

## 3. Missing input (the only blocker)

The Safe app stores an un-activated Safe's setup locally, not on-chain. To recover and **prove** the owners, and to rebuild the identical deployment, `scripts/safe-replay-check.mjs` needs:
- the 3 owner addresses and the threshold;
- the **salt nonce**;
- the Safe version, or the singleton (L1 or L2);
- the fallback handler;
- any `to`/`data` setup call;
- the payment fields.

The Safe app's data export (Settings → Data → Export) holds these under `undeployedSafes` → `43114` → `0xec40…A10` → `props`. That it includes undeployed Safes is **UNVERIFIED** for your app version. The entry contains public addresses and a number only; it holds no keys.

**If the salt nonce cannot be recovered,** the identical address is unreachable. The fallback is §5 option B.

## 4. Deployment and signing without the Safe web app (owner-run; prepared, not executed)

1. **Run the read-only check:**
   ```bash
   SAFE_SETUP_FILE=setup.json SAFE_TARGET=0xec40c3CE983A2F3bB4a241EBAd4e0a8C261aeA10 node scripts/safe-replay-check.mjs
   ```
   It must report `READY FOR OWNER REVIEW`, which means:
   - exactly one setup recomputes to the address, so the owners and threshold are proven;
   - every referenced contract is identical on Fuji;
   - the target has no code yet on Fuji;
   - the Fuji `eth_call` of the factory returns the same address.

   It prints the unsigned Fuji creation transaction: chain 43113, `to` = factory, value 0, plus the calldata and a gas estimate.
2. **Creation needs no owner signatures.** Creation is an ordinary factory call that **any funded account can send**. The owners and threshold are fixed by the calldata. Recommended: one owner's Ledger, funded with free Fuji test AVAX from a faucet.
   - Check the account (read-only): `cast wallet address --ledger --mnemonic-derivation-path "<path>"`.
   - Send: `cast send 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 <CALLDATA> --ledger --mnemonic-derivation-path "<path>" --chain 43113 --rpc-url https://api.avax-test.network/ext/bc/C/rpc`.
   - The Ledger Ethereum app needs "Blind signing" enabled for contract data.
   - The device must show chain 43113. Stop if it shows anything else.
3. **Postcheck** (read-only): `SAFE_CANDIDATE=0xec40…A10 node scripts/safe-identity-probe.mjs`. Code must exist on Fuji, and the owners and threshold must equal the recovered setup.
4. **Safe transactions** (S-0 self-test, then P0 steps 4–5) need **two of the three Ledger owners**:
   1. Generate the typed data (`buildSafeSelfTest` / the plan generator).
   2. Each owner runs `cast wallet sign --ledger --mnemonic-derivation-path "<path>" --data --from-file safetx.json`.
   3. The device shows the EIP-712 domain hash and message hash. Compare both with `safeTypedDataHashes()` before approving.
   4. Run `node scripts/verify-safe-signatures.mjs` offline to check the signatures and order them.
   5. Any funded account submits `execTransaction(...)` with `cast send … --ledger --chain 43113`.

   The S-0 self-test is harmless (the Safe calls itself, value 0) and proves the Ledger EIP-712 path before anything touches the release contracts. Whether your devices and firmware sign EIP-712 data on 43113 through `cast` is **UNVERIFIED** until S-0.

**Cost:** Fuji test AVAX only. About 306k gas to create, about 84k for S-0. No Safe Pro, no subscription, no new signer wallets.

## 5. Options

| | Path | Needs | Result |
|---|---|---|---|
| **A (recommended, cheapest)** | Replay the exact setup on Fuji | The setup data (§3) | Same address `0xec40…A10` and the same owners and threshold on Fuji. A later activation on C-Chain gives the same address there too. |
| B (fallback) | Deploy on Fuji with the same 3 owners and threshold 2 but a new salt (`buildSafeCreation`) | Only the 3 owner addresses | Same signers and threshold, **different address** |

## 6. Open items and decisions

- **Backup admin (R2).** The approved design adds an independent backup admin that is not a Safe owner. You've said you don't want new signer wallets. Decide between:
  - an existing wallet that is not a Safe owner; or
  - proceeding with the Safe as the only new admin. A 2-of-3 still survives one lost key, but there would be no independent recovery path.
- **Unchanged and still open:**
  - `0x284C` mint authority;
  - the six fixed payout destinations;
  - the locked-sale fee power;
  - the off-chain credential cutovers;
  - P1 and ALL not started.

  None of this claims mainnet readiness.
