# Fuji-first gate: PR #171 royalty-locked launch candidate

**Outcome: FUJI GATE SATISFIED.** The approved broadcast ran on 2026-10-12. It used workflow run
[38252855896](https://github.com/VoidcallerOC/The-Void/actions/runs/38252855896) on `main` `60b71f0`.
All 14 rehearsal checks PASS, and each was re-verified independently from receipts and live reads
(section 7). The record is `deployments/fuji-royalty-rehearsal-0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338.json`.
This closes the Fuji-first gate only. It does not make mainnet ready; see section 8.

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
transaction hashes. The record must be committed. **Met: see sections 7 and 8.**

The broadcast used these inputs:

- `expected_deployer_address=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`
- `expected_deployer_nonce=61`
- `broadcast_rehearsal=true`
- `confirm_fuji_rehearsal=I_CONFIRM_FUJI_ROYALTY_REHEARSAL`

## 6. Existing Fuji state (must be unchanged after the run)

Baseline code hashes at Fuji block 59338353 (`keccak256(getCode)`, first 8 bytes). Section 7.5 has the
post-run comparison for all 12 recorded contracts.

| Contract | Address | Hash |
| --- | --- | --- |
| Factory V2 | `0x3e4E…3aC8` | `0xc2a9fbe24c2c1c39` |
| V4 implementation | `0x45c3…E452` | `0x105531b9d195ae92` |
| Marketplace V3 | `0xa464…C898` | `0x5cecebdf6c1da6c9` |
| Historical factory | `0xa5Cb…3505` | `0x9d2a362fb584724d` |
| Historical marketplace | `0x42B7…a744` | `0xedced116da380cf8` |
| Shared V2 release | `0x7Bba…95B6` | `0x67770fc82259050f` |

`config/fuji-release*.json` is unchanged by this work.

## 7. Live Fuji evidence (2026-10-12)

### 7.1 Preflight, immediately before the broadcast

- Plan-only run [38252526518](https://github.com/VoidcallerOC/The-Void/actions/runs/38252526518)
  on `60b71f0`: `ready: true`, all 7 plan checks PASS.
- Independent read at block 59339190 (public Fuji RPC):
  - chain `43113`; deployer `0xaBd3…c174`;
  - nonce 61 latest and 61 pending; balance 0.487517025 AVAX;
  - predicted addresses unchanged and empty: factory `0x0459…D338`, implementation `0x5f37…59A5`,
    marketplace `0x717c…3158`;
  - fee recipient `0xb65C…1ce4`; royalty payout `0x284C…180a`.
- The Factory V3 and Genesis Fuji packages were not run. Their nonce-61 predictions are now consumed,
  and both must re-plan from nonce 71 before any future use.

### 7.2 Transactions

Every transaction is from the deployer on chain 43113 and has receipt status 1.

| Step | Nonce | Block | Gas used | Transaction | Result |
| --- | --- | --- | --- | --- | --- |
| Factory deploy | 61 | 59339210 | 5,522,355 | `0x95da5bf691a0e448d4fb6763212206b175a99e3fd53cbda2c3a50e35e6d0826a` | `0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338` (implementation `0x5f37D51D3Df38aDd259DD2d6b9952c2CecA259A5`, created in the same transaction) |
| Marketplace deploy | 62 | 59339214 | 1,488,936 | `0x621909e562a362fe053a252371ff811088bc4c519ab620f1407909e899b20f03` | `0x717cf06380e36176728e351f4dabC48cF5ef3158` |
| createRelease | 63 | 59339217 | 1,941,287 | `0x2a0e4756f0fdee66cef2a12d3f7b56a99d993f4f2d1d1837a02eb9e6406222e2` | release `0x907e69C9A071af8c5dacD91a274754543A4c72c4`, sale `0xC543c0cFB75C691d1323b79678780cdc8CDee818` |
| grant ARTIST_ROLE to payout | 64 | 59339221 | 51,769 | `0x52cf2e8e2ba2426f20371a433b7f32f15d7fbae2ec921d9f5bb32900aa75cfad` | |
| createEdition (250 bps) | 65 | 59339222 | 271,651 | `0xe46b00c31d3d5c10cf642c7f6e846d7de53cfe69047ed10b7d182cc372cb02e7` | |
| configureSale | 66 | 59339225 | 135,368 | `0x46b566cfdfefccec54baba3cf22f1259b2c9da065461d0fee565af75d45886ba` | |
| Primary purchase (0.01) | 67 | 59339228 | 199,553 | `0xdf595241edded1e1ef5f738466ab37ea29d584965e0b70415147895808ac7140` | |
| setApprovalForAll | 68 | 59339230 | 48,862 | `0x103a25bca49c9c845ea3ef8e6281dcf8c2978f106302aac6c06c8307385af6cf` | |
| createListing | 69 | 59339232 | 213,803 | `0xc96fa861eda2c0504f3c4c494162fbece4ef5f0a7c284b75af4f29bd71a910bb` | listing 1 |
| Resale buy (0.01) | 70 | 59339235 | 133,640 | `0x1e43d0d8b7d49586b921113bf9bb2f856b7967798db3c2af21502ececd5c071c` | |

After the run, the deployer nonce is 71 (latest and pending) and the balance is 0.477017023 AVAX.

### 7.3 Deployed code

- Runtime code is present: factory 10,079 bytes, implementation 14,952 bytes, marketplace 6,530 bytes.
- The release is a 45-byte EIP-1167 clone of `0x5f37…59A5`.
- A local `forge build` (v1.3.1) of `60b71f0` reproduces the plan run's artifact hashes:
  - factory init code `0xbecbf255…`;
  - marketplace init code `0x7c63f9e7…`;
  - implementation runtime `0x52dc13a5…`.
- Live runtime code equals that build byte for byte, excluding only the immutable slots (5 for the
  factory, 4 for the implementation, 16 for the marketplace).

### 7.4 Acceptance, read live and independent of the script

| Requirement | Live result |
| --- | --- |
| Factory → implementation | `implementation()` = `0x5f37…59A5`, which is the factory's CREATE address at nonce 1. `RELEASE_VERSION` 2. |
| Royalty lock | Factory, implementation and release report `REQUIRED_ROYALTY_BPS` = 250, and `platformFeeRecipient` = `0xb65C…1ce4`. |
| Marketplace config | `registry()` = the factory; `feeRecipient()` = `0xb65C…1ce4`; `platformFeeBps` 250; `REQUIRED_ROYALTY_BPS` 250. |
| Edition royalty | `royaltyInfo(token, 1 AVAX)` = (`0x284C…180a`, 0.025). |
| Primary fee 2.5% | Sale credits are 0.00025 to the fee recipient and 0.00975 to the payout, on a 0.01 price. |
| Secondary 2.5 / 2.5 / 95 | `ListingSold`: price 0.01, fee 0.00025, royalty 0.00025, seller 0.0095. Balance deltas at block 59339235: fee recipient +0.00025, payout +0.00025. Listing status 1 (settled). |
| Bypass | `staticCall` against the live clone, run as the release artist: 249, 251, 500, 0 and 1000 bps each revert `RoyaltyPolicyViolation`. A fee-recipient payout and a stranger payout each revert `UnauthorizedRoyaltyRecipient`. Listing an existing Fuji V2 release reverts `UnsupportedRelease`. Control: 250 bps to the authorized payout does not revert. |
| Record accuracy | Every address, hash and block in the committed record matches the receipts above. |

### 7.5 Preservation

- All 12 recorded Fuji contracts have the same full `keccak256(getCode)` before (block 59339121)
  and after the run. This includes the 6 baseline hashes in section 6.
- `config/` is unchanged, so the Fuji app and indexer do not see the new contracts.
- No Render, Vercel or database change was made.
- Mainnet: deployer nonce 0, and the predicted mainnet factory `0x262B…757b` has no code on 43114.

## 8. Remaining limits

- **One signing key.** The resale is a self-trade by the deployer. Fee and royalty went to distinct
  addresses. Cross-wallet transfer is proven only in the Foundry suites, and mainnet acceptance must
  show it live.
- **No Fuji Genesis claim** (see answer 6). The Genesis claim on the royalty-locked release is proven
  locally only.
- **Nonces consumed.** The Fuji Factory V3 and Genesis claim plans' nonce-61 predictions are stale.
  Re-plan from nonce 71 if either is ever authorized.
- **Not verified on an explorer.** Source is not verified on Snowtrace for the rehearsal contracts.
  The bytecode match in 7.3 is the evidence.
- **Passing this gate does not make mainnet ready.** The other steps in `deploy/mainnet/README.md`
  remain open:
  - owner approval of the royalty-contract review decision (Cursor CONDITIONAL PASS, scoped exception);
  - the deployer-authority open item O1 (copies of the deployer key outside Rabby; `DEPLOYMENT-AUTHORITY.md`);
  - the Nano S Plus address confirmed on the device screen;
  - deployer funding (0 AVAX at the last C-Chain dry run);
  - the owner's broadcast authorization.
