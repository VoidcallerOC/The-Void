# Fuji Rabby test of the owner-signing page

**Status: prepared, NOT authorized.** Nothing in this document has been signed or sent. The owner's
explicit approval of the exact transaction below is required before Rabby is asked to sign anything.

## What it proves

The page at `/fuji-rabby-test` is the mainnet owner page (`/owner-deploy`) with a Fuji network
profile. One real Fuji test with the real Rabby extension proves, before any mainnet signature:

- Rabby is found through EIP-6963 (`io.rabby`) and no other wallet is used.
- The page accepts only the deployer account and only the page's own chain, and never switches the network.
- Rabby receives one exact contract creation (no recipient, value 0, the reviewed nonce, gas and chain).
- The result is checked from the public RPC, not from the wallet: receipt, sender, nonce, creation data, created address and the contract's state.
- A reload re-checks the stored hash from the chain instead of signing again.

It deploys `RabbySigningProbe`. The probe has no owner, no state-changing function and cannot hold
AVAX; nothing on the platform uses it.

## Separation from mainnet

| | Fuji test | Mainnet |
|---|---|---|
| Page | `/fuji-rabby-test` (`fuji-rabby-test.html`, `src/owner-deploy/fuji-main.js`) | `/owner-deploy` |
| Chain | 43113 only | 43114 only |
| Plans | `deploy/fuji/approved-plans/` only | `deploy/mainnet/approved-plans/` only |
| Plan kind | `rabby-probe-fuji` | `release-per-contract-mainnet`, `genesis-claim-mainnet` |
| Deployer nonce | 71 (Fuji) | 0 (C-Chain) |

Each page bundles only its own plans: the build puts the mainnet plan only in the mainnet page's
bundle and the Fuji plan only in the Fuji page's bundle. Each validator refuses the other network's
kind, chain and binding (`test/fuji-rabby-path.test.mjs`). The Fuji test uses the same Rabby
account as mainnet, deliberately, because that account is what the test must prove. Its Fuji nonce
(71) gives an address that is not any planned mainnet address, and it consumes no mainnet nonce.

## The exact transaction (approved-plan file `deploy/fuji/approved-plans/rabby-probe-fuji.json`)

| Field | Value |
|---|---|
| Network | Avalanche Fuji testnet, chain 43113 (`0xa869`) |
| From (Rabby) | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` |
| To | none (contract creation) |
| Value | 0 |
| Nonce | 71 |
| Creation data | 366 bytes: `RabbySigningProbe` creation code plus `label = keccak256("the-void/fuji-rabby-probe/v1")` = `0xbdf8a15a…75ccea`; keccak256 `0x792db3538a6af4a16fec5547386b055d0c36cbbc8818128f93e3c5572b198d6a` |
| Creates | `0xac001c79672A266Fa53931553697161400715829` |
| Gas limit | 124,896 (node estimate 104,080 plus 20%) |
| Plan binding | `2a9b11d33e69edfe6b227ed457b879cc1a5138bc1d1c39a379cf595b54b561f1`, source commit `ed7c41adcf4548e286a68bff1676002093e88b75` |
| Observed | Fuji block 59,350,867, 2026-10-12 19:38 UTC: nonce 71 (latest = pending), balance 0.477 Fuji AVAX, target address empty |

**Cost:** test AVAX only, with no real value. At the observed Fuji fee (max 170 wei per gas) the cap is
21,232,320 wei. Even if Rabby proposes 25 gwei, it is at most 0.0031 Fuji AVAX. No funding is needed.

**Expected effects:** the deployer's Fuji nonce becomes 72. A contract exists at `0xac00…5829`, with
`label()` = the label above, `creator()` = the deployer, and a balance of 0. Nothing else changes, on
Fuji or on mainnet.

**Pass criteria (all from the public Fuji RPC):** receipt status 1; transaction chain 43113, from the
deployer, nonce 71, no recipient, value 0, creation-data hash as above; created address equals the
predicted one, with code; `label()`, `creator()` and balance as above. The page shows "Confirmed and
verified on chain" for step 1 and "Test passed". Rabby merely opening, or a hash alone, is not a pass.

**The plan goes stale** when the deployer's Fuji nonce moves, for example because a legacy Fuji
workflow signed with the `DEPLOYER_PRIVATE_KEY` secret. The page then refuses to offer it, and it
must be re-planned (`node scripts/fuji-rabby-probe-plan.mjs`) and re-approved.

## Procedure (owner, browser only)

1. Approval: the owner approves this exact transaction in writing. Merging the PR that carries the
   plan file publishes the page; it is not, by itself, the test authorization.
2. Open `https://the-void-alpha.vercel.app/fuji-rabby-test` in the browser with Rabby. Check the
   yellow FUJI TESTNET ONLY banner.
3. In Rabby, select the deployer account and the Avalanche Fuji network yourself.
4. **Connection check (no transaction):** press **Connect Rabby**. All three rows must read PASS:
   Rabby detected, account is the deployer, chain 43113. Readiness (section 3) must read PASS on every
   row. Stop here if only the connection check was authorized.
5. Section 4: compare step 1 with the table above (nonce 71, creates `0xac00…5829`, data hash
   `0x792d…8d6a`), tick the review box and press **Request approval in Rabby**.
6. In Rabby, check: Fuji, contract deployment, from `0xaBd3…c174`, value 0, nonce 71. Approve.
   (Pressing Reject returns the step to Prepared; nothing is signed.)
7. Wait for "Confirmed and verified on chain" and "Test passed". Send the transaction hash to Claude
   for the test record.
8. Optional: reload the page. The step must come back as confirmed without asking Rabby again.

**Stop and report, sign nothing more, if:** a row is FAIL; Rabby shows another chain, account,
nonce, recipient or a non-zero value; the page shows "Failed verification: stop"; or Rabby returns
an error other than a rejection. Before anything else, check Rabby's activity for a sent transaction.

## Evidence so far (no real wallet)

| Tier | Result |
|---|---|
| Local unit tests | `test/fuji-rabby-path.test.mjs`: chain separation in both directions, connection check, rejection, wrong account, wrong chain, stale nonce, pending transactions, incorrect hash (other data, other chain, failed receipt, wrong probe state), timeout, reload, duplicate request and second hash, stop after failure. |
| Local forge | `test/RabbySigningProbe.t.sol`: label, creator, refuses value. |
| Fuji read-only | The plan was built from the live Fuji state above. The built page, in Chromium with a stand-in wallet, read live Fuji: readiness all PASS, the connection check refused the artist account and chain 43114, and a rejection returned to Prepared. Nothing was sent. |
| Local Fuji fork | The same page against an anvil fork of Fuji (fork transactions only, never sent to Fuji): the stand-in wallet sent the exact transaction and the page verified it (`0xac00…5829`, gas used 103,088, label, creator, balance 0). The confirmation survived a reload. The wallet methods used were `eth_requestAccounts`, `eth_accounts`, `eth_chainId` and `eth_sendTransaction`; there was no network switch. |
| Real Rabby on Fuji | NOT STARTED: awaits the owner's authorization. |
