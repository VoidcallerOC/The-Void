# Owner signing in Rabby (C-Chain mainnet)

Every mainnet contract deployment is signed by the owner in **Rabby**, with the defined deployer
`0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, on the owner's own machine. The private key never
leaves Rabby. No script, workflow, CI job, cloud service, file or environment variable holds it, and
the scripts refuse to run if any `*PRIVATE_KEY` variable is set.

## Wallets and what each one does

| Wallet | Address | In this launch |
| --- | --- | --- |
| Rabby: platform deployer | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` | Signs the contract deployments only: factory, marketplace, Genesis claim. Never creates releases or editions. Holds no role afterwards. |
| Artist wallet | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | Creates the Forgive & Forget release and edition, configures the sale, and grants the claim `ISSUER_ROLE`. Each is its own operation in its own wallet session. |
| Ledger Nano S Plus: platform fees | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` | Passive recipient of the 2.5% primary and 2.5% secondary fees. Signs nothing in this launch. The owner only reads its address on the device screen. |
| Ledger X (personal) | — | No role. |

Cold wallets give no launch signatures or approvals. A later withdrawal of accrued primary fees
is a separate treasury operation, outside the launch.

## How it works

1. **Plan, without any key.** The GitHub workflow (or the same command run locally) builds a dry-run
   plan from public chain state. For each contract the plan contains the exact unsigned transaction:
   - chain 43114;
   - `from` the defined deployer;
   - the nonce;
   - no `to` (a contract creation);
   - value 0;
   - the full creation code with its encoded constructor arguments, and its keccak256 hash;
   - the predicted contract address.

   `scripts/deployment-plan-binding.mjs bind` binds the plan to the commit. The binding covers the
   artifact hashes, constructor arguments, nonces, predicted addresses and the hash of every unsigned
   transaction.
2. **Re-plan and match.** `npm run sign:mainnet` refuses to start unless:
   - the working tree is the bound commit, with no tracked modification;
   - the reviewed `plan.json` produces the approved `plan-binding.json`;
   - a fresh key-less plan from the live chain produces the same binding.
3. **Sign in Rabby.** The tool serves one page on `127.0.0.1` (a random port and a random session
   path; same-origin requests only). The page:
   - finds Rabby by its EIP-6963 announcement (`io.rabby`) and uses no other wallet;
   - requires Rabby's current account to be the deployer, and Rabby's chain to be 43114;
   - offers one step at a time, and only after the review box for that step is ticked.

   Immediately before handing a step to Rabby, the tool re-reads the chain:
   - chain ID;
   - the deployer's nonce is the planned nonce, with nothing pending;
   - the target addresses are still empty.

   The page re-hashes the transaction data and checks it against the reviewed hash. Then Rabby shows
   the transaction; **the owner approves or rejects it in Rabby**. Rabby signs and submits it.
4. **Verify from chain.** The tool waits for the receipt on its own RPC, not the wallet's, and checks
   the transaction:
   - chain, sender and nonce;
   - no recipient and zero value;
   - the exact creation-data hash;
   - success, and the contract at the predicted address.

   It then checks the deployed runtime code against the compiled artifact, with only the compiler's
   immutable slots masked, and every immutable setting.

   The next step is offered only after this passes. Any mismatch stops the session. After the last
   step it writes the record under `deployments/` for a record PR.
5. **Re-verify any time.** `npm run verify:mainnet` re-checks mined transactions against the reviewed
   plan from the RPC alone.

## Procedure: release infrastructure (factory, then marketplace)

Prerequisites:
- a clean checkout of the reviewed commit on `main`;
- `npm ci`;
- Foundry v1.3.1 and `forge build`;
- Rabby in your browser, with the deployer account;
- the deployer funded on C-Chain (the plan reports the amount).

1. Read the fee recipient on the Nano S Plus screen (view only; the device signs nothing). It must be
   `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`.
2. Plan:
   - **In GitHub:** Actions → *Plan release-per-contract infrastructure for C-Chain mainnet*, with:
     - `expected_deployer_address` left at the default;
     - `expected_deployer_nonce=0`;
     - `platform_recipient=0xb65C…1ce4`.

     Download the run's `plan.json` and `plan-binding.json`.
   - **Or locally:**
     ```
     DEPLOY_NETWORK=mainnet EXPECTED_DEPLOYER_ADDRESS=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174 \
     EXPECTED_DEPLOYER_NONCE=0 RELEASE_PLATFORM_RECIPIENT=0xb65C575CaE01574296Fab6E620B9A15cC0121ce4 \
     PLAN_OUTPUT_PATH=plan.json npm run deploy:release-per-contract:mainnet -- --dry-run
     node scripts/deployment-plan-binding.mjs bind --kind release-per-contract-mainnet \
       --plan plan.json --commit "$(git rev-parse HEAD)" --out plan-binding.json
     ```
3. Review the plan:
   - every check is PASS, except the two recipient checks, which stay UNVERIFIED until step 4;
   - the predicted factory is `0x262B…757b`, the implementation `0x8064…9006` and the marketplace
     `0x0e77…F8f5` at nonces 0 and 1.
4. Start the signing page:
   ```
   npm run sign:mainnet -- --kind release-per-contract-mainnet --plan plan.json \
     --binding plan-binding.json --recipient-verified-on-device <address you read on the Nano>
   ```
   Open the printed `http://127.0.0.1:…` link in the browser where Rabby is installed.
5. **Connect Rabby.** Rabby must be on the deployer account and Avalanche C-Chain.
6. **Step 1: factory.** Tick the review box. Send to Rabby. In Rabby, check:
   - it is a **contract deployment**;
   - from `0xaBd3…c174`;
   - on Avalanche C-Chain;
   - nonce 0;
   - value 0.

   Then approve. Wait for **verified**.
7. **Step 2: marketplace.** The same, at nonce 1.
8. Commit the written `deployments/release-per-contract-mainnet-<factory>.json` and fill
   `config/mainnet-release-per-contract.json` in a record PR (README step 7).

If you reject in Rabby, nothing is signed and the step can be offered again. If the page loses track
after Rabby submitted, paste the hash from Rabby's history into the step. If verification fails, stop
and review: nothing further is offered.

## Before the first real signature: Rabby check (sends nothing)

The page has been rehearsed only with a stand-in wallet. Do this check once with the real Rabby
before approving anything. It needs a ready plan, so the deployer must already be funded (step 5 of
the runbook).

1. Start the session (procedure step 4), open the link and click **Connect Rabby**.
   - **Pass:** Rabby asks to connect this site, and the page shows
     `Connected: Rabby, deployer 0xaBd3…c174, Avalanche C-Chain`.
   - **Fail:** *Rabby was not detected* (Rabby does not inject into `127.0.0.1`), or the wrong account
     or chain is shown. Stop. Change nothing in the plan; report it.
2. Tick step 1's review box and click **Send step 1 to Rabby for approval**. In Rabby's confirmation,
   read without approving:
   - a **contract deployment** (no recipient);
   - from `0xaBd3…c174`;
   - Avalanche C-Chain;
   - value 0 AVAX;
   - **nonce 0** (under Rabby's advanced or nonce setting).
3. **Reject** in Rabby. The page must say *You rejected step 1 in Rabby. Nothing was signed.* and
   offer step 1 again. The deployer's nonce is still 0, which you can confirm on Snowtrace.
4. If any field differs (above all the nonce), do not approve. Rabby may have a queued transaction:
   clear it in Rabby. Then start again.

Only after this check passes, run step 1 for real.

## Recovery

- **You rejected the request in Rabby.** Nothing was signed. The step is offered again.
- **Rabby returned an error other than a rejection.** Do not sign again. Open Rabby's activity:
  - If the transaction was sent, paste its hash into the step. It is verified against the reviewed
    request like any other.
  - The tool refuses to hand the step to Rabby again while the deployer's nonce has moved or a
    transaction is pending.
- **The transaction is slow to mine.** After 10 minutes the step shows *not mined yet* and keeps its
  hash. Check again once Rabby shows it confirmed. A slow transaction never fails the session.
- **The session ended between steps** (a closed terminal or browser). Restart it with the reviewed
  plan, the binding and each already-signed step's hash, in order:
  ```
  npm run sign:mainnet -- --kind release-per-contract-mainnet --plan plan.json \
    --binding plan-binding.json --recipient-verified-on-device <Nano address> --resume <factory tx hash>
  ```
  A fresh plan cannot match any more, because the nonce has moved. So resume works from the reviewed
  plan itself:
  - the plan must produce the binding on the checked-out commit;
  - every request's data must hash to its bound value;
  - each given hash is verified from chain as its step.

  Only then are the remaining steps offered, each behind the same live checks.
- **A step fails verification.** Stop. Nothing more is offered. Review the reason. The contracts are
  ownerless, so a wrong deployment is never recorded (runbook, *Failure handling*).

## Procedure: Genesis claim (separate, later)

1. The artist creates the release and edition and configures the sale with the artist wallet
   (README steps 9–10). The deployer does none of this.
2. Plan:
   - **In GitHub:** Actions → *Plan the Genesis holder claim for C-Chain mainnet*, with the release,
     sale, token, `claim_start`, `claim_admin`, `claim_signer_address` and `expected_deployer_nonce`.
   - **Or locally:** the same inputs as `GENESIS_*` variables, with `npm run deploy:genesis-claim -- --dry-run`.

   The plan refuses a release the artist wallet does not own and administer, and a release where the
   deployer or the fee recipient holds admin.
3. Start the signing page and sign the single step in Rabby:
   ```
   npm run sign:mainnet -- --kind genesis-claim-mainnet --plan plan.json --binding plan-binding.json
   ```
4. **Separate artist operation.** The plan's `followUps.issuerGrant` is the `grantRole(ISSUER_ROLE,
   <claim>)` call, prepared for the account that holds the authority: the release's `DEFAULT_ADMIN_ROLE`
   holder, verified on chain to be the artist wallet. The artist signs it in the artist wallet's own
   session before `claimStart`. Then run:
   ```
   npm run verify:mainnet -- --kind genesis-claim-mainnet --plan plan.json --binding plan-binding.json --tx <claim tx>
   ```
   It must report `issuerGrant: GRANTED`.

Launch activation stays a separate, separately approved step (README step 13).

## What has been tested, and what has not

- **Unit tests:**
  - `scripts/mainnet-signing-requests.test.mjs`, `scripts/mainnet-owner-signing.test.mjs`,
    `scripts/deployment-plan-binding.test.mjs`, `scripts/deploy-release-per-contract-mainnet.test.mjs`,
    `scripts/deploy-genesis-claim.test.mjs`;
  - `test/mainnet-deployment-safety.test.mjs` (workflows hold no key and sign nothing).
  - They show that each of these is refused: a wrong chain, a wrong deployer, changed constructor
    arguments or artifacts, an incorrect nonce, an altered predicted address, a cross-origin request
    and a private key in the environment.
- **C-Chain fork rehearsal (local, no real transaction):** an anvil fork of C-Chain at block
  97,377,115. Chromium loaded the real signing page, with a stand-in wallet that announces itself as
  `io.rabby` and forwards to the fork.
  - The page refused the artist account, and refused to send without the review tick.
  - It handed the wallet exactly the planned transactions, and verified:
    - the factory `0x262B…757b`, with implementation `0x8064…9006`;
    - the marketplace `0x0e77…F8f5`;
    - after the artist's release setup, the Genesis claim.
  - `verify:mainnet` independently re-verified all three, and showed the artist's separate grant as
    `GRANTED`.
  - Stale plans, a tampered binding, a key in the environment and a wrong device confirmation were
    each refused.
- **Not tested: the real Rabby extension.** Also unverified: whether Rabby injects its provider into
  a page served from `http://127.0.0.1`. The page sends no content-security policy that would block
  an injected script; it only refuses framing. The page uses only standard EIP-1193 calls:
  - `eth_requestAccounts`, `eth_accounts` and `eth_chainId`;
  - `eth_sendTransaction` with no `to`, plus `data`, `value`, `gas`, `nonce` and `chainId`.

  Whether Rabby honours the `nonce` field rather than choosing its own is UNVERIFIED. The tool
  does not depend on it:
  - before signing, it checks that the live nonce is the planned nonce with nothing pending;
  - after mining, it refuses any transaction whose nonce or created address differs.

  At step 6, check that Rabby shows nonce 0 before approving.
