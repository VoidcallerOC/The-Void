# Fuji-first gate: PR #171 royalty-locked launch candidate

**Outcome: BLOCKED — awaiting owner authorization of one Fuji broadcast.** The path is prepared and
the gate is **not satisfied**. No live Fuji evidence exists yet, and no exception is proposed.

## 1. The requirement

- `PRODUCTION-INFRASTRUCTURE-AUDIT.md` (and `docs/` copy), line 78: *"deploy the reviewed contract
  to Avalanche Fuji first and Avalanche C-Chain mainnet only after an independent review … Add
  contract tests against a fork and testnet."*
- Same file, line 184: *"deploy and verify the ERC-1155 and marketplace contracts … Run a full
  testnet rehearsal before mainnet."*
- `LAUNCH-GATE.md`, staging step 3: *"Independently review ERC-1155 and marketplace
  source/parameters. Deploy them on Fuji…"*

The text names marketplace and ERC-1155 contracts and contains no exception mechanism. The
launch candidate adds exactly those: `ReleaseMarketplaceV4`, and `VoidRelease1155V4Royalty` behind
`VoidReleaseFactoryV2Royalty`. The requirement therefore applies.

An exception is not proposed. A compliant additive rehearsal is cheap: the deployer holds
0.4875 Fuji AVAX, and Fuji fees are negligible. It is safe, because it is new addresses only, and
it is already prepared. An exception would waive a mandatory written gate for no material saving.

## 2. Answers

| # | Question | Answer and evidence |
| --- | --- | --- |
| 1 | Does the existing Fuji factory support the royalty-locked implementation? | **No.** `VoidReleaseFactoryV2` at `0x3e4E…3aC8` sets `implementation` immutably in its constructor (`VoidRelease1155V4` `0x45c3…E452`). Only a new `VoidReleaseFactoryV2Royalty` clones `VoidRelease1155V4Royalty`. |
| 2 | Can the contracts be deployed additively? | **Yes.** They come from the deployer's next nonces (plan at Fuji block 59338353, nonce 61). Predicted factory `0x0459…D338`, implementation `0x5f37…59A5`, marketplace `0x717c…3158`: none matches the 12 recorded Fuji contracts, and none has code. Nothing in `config/` changes, so the Fuji app and indexer never see them. |
| 3 | Can a release and edition be created? | **Yes.** `scripts/rehearse-royalty-fuji.mjs` creates a release from the deployer and a 2.5% edition paid to a passive payout (the artist wallet `0x284C…180a`, granted `ARTIST_ROLE`). |
| 4 | Primary and secondary sales at the final split? | **Yes.** It runs a primary purchase (2.5% credited to `0xb65C…1ce4`, 97.5% to the payout), then a listing and a resale on `ReleaseMarketplaceV4`. The resale must show exactly 2.5% fee, 2.5% royalty and 95% to the seller in the `ListingSold` event and in balance deltas. |
| 5 | Direct bypass attempts revert? | **Yes.** On the live clone it simulates a 500 bps royalty, a 0 bps royalty, the platform recipient as payout, an unauthorized payout, and listing an existing Fuji V2 release. Each must revert with its enforcing error (`RoyaltyPolicyViolation`, `UnauthorizedRoyaltyRecipient`, `UnsupportedRelease`). |
| 6 | Genesis claim against a new Fuji release, without `-28`, `-23` or `-25`? | **Technically yes, but not required.** The policy names marketplace and ERC-1155 contracts. `GenesisHolderClaim.sol` is unchanged by PR #171 (empty `git diff 72d4350 218a6e9`), and its Fuji path is separate and pending. A Fuji claim would need a new signer key, a Fuji API configuration change and a Genesis-holding signer, so the rehearsal does not include it. Composition with the royalty-locked release is proven locally in `test/GenesisHolderClaimRoyaltyRelease.t.sol` (4 tests). Mainnet acceptance stays the quiet-open claim. |
| 7 | What is Fuji-specific, and what is local? | **Fuji-specific:** a real deployment and real transactions under testnet consensus, gas and RPC behaviour; immutables read from deployed code; reverts against deployed bytecode. **Local:** the full adversarial suite (`RoyaltyEnforcement` 8, `MainnetEconomics` 3, Genesis composition 4), mutation checks, and the C-Chain and Fuji fork rehearsals. |
| 8 | What would an exception leave unverified? | Real-network deployment of the exact artifacts; constructor and immutable wiring on a live chain; the journey's receipts and balances under real consensus. These are what the policy asks for. |

## 3. Limits of the rehearsal (stated, not hidden)

- **One signing key.** The deployer acts as artist, seller and buyer, so the resale's ownership
  transfer is to the same wallet. The fee and royalty go to distinct addresses and are exact. The
  seller's 95% is proven from the event and the deployer's net balance (−5% minus gas).
  Cross-wallet ownership transfer is covered by the Foundry suites, and mainnet acceptance covers it
  live.
- No Fuji Genesis claim (see 6).
- **Nonce use.** The rehearsal uses deployer nonces 61 onwards. The pending Fuji Genesis claim
  package that predicted `0x0459…D338` at nonce 61 must be dry-run again; its broadcast already
  requires a reviewed `EXPECTED_DEPLOYER_NONCE`.

## 4. Evidence prepared (pre-broadcast; not the gate itself)

- **Live read-only plan on Fuji:** chain 43113; nonce 61, nothing pending; addresses new and empty;
  artifacts royalty-locked and album-capable; funded.
- **Local Fuji fork, impersonated deployer (not broadcast):** all 14 rehearsal checks PASS. Every
  bypass reverted with its enforcing error. The resale moved 0.00025 to the fee recipient, 0.00025
  to the artist payout and 0.0095 to the seller.
- `scripts/rehearse-royalty-fuji.test.mjs` (6 tests) and the workflow
  `.github/workflows/rehearse-royalty-fuji.yml` (plan by default; key only on an approved broadcast).

## 5. What satisfies the gate

A broadcast run of *Fuji-first rehearsal of the royalty-locked launch candidate* on the reviewed head
must produce `deployments/fuji-royalty-rehearsal-<factory>.json`, with all 14 checks `PASS` and the
transaction hashes. Commit that record. Then this file changes to **FUJI GATE SATISFIED**, citing the
run and the record.

**Owner authorization required:** the workflow inputs below.

- `expected_deployer_address=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`
- `expected_deployer_nonce=<from the plan run, currently 61>`
- `broadcast_rehearsal=true`
- `confirm_fuji_rehearsal=I_CONFIRM_FUJI_ROYALTY_REHEARSAL`

## 6. Existing Fuji state (must be unchanged after the run)

Code hashes at Fuji block 59338353 (`keccak256(getCode)`, first 8 bytes):

| Contract | Address | Hash |
| --- | --- | --- |
| Factory V2 | `0x3e4E…3aC8` | `0xc2a9fbe24c2c1c39` |
| V4 implementation | `0x45c3…E452` | `0x105531b9d195ae92` |
| Marketplace V3 | `0xa464…C898` | `0x5cecebdf6c1da6c9` |
| Historical factory | `0xa5Cb…3505` | `0x9d2a362fb584724d` |
| Historical marketplace | `0x42B7…a744` | `0xedced116da380cf8` |
| Shared V2 release | `0x7Bba…95B6` | `0x67770fc82259050f` |

`config/fuji-release*.json` is unchanged by this work.
