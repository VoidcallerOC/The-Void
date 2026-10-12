# Owner signing in Rabby (C-Chain mainnet)

Every mainnet contract deployment is signed by the owner in **Rabby**, with the defined deployer
`0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, on the owner's own machine. The private key never
leaves Rabby. No script, workflow, CI job, cloud service, file or environment variable holds it, and
the scripts refuse to run if any `*PRIVATE_KEY` variable is set.

> **Open owner action (2026-10-12):** this is the rule, but it is not yet true. The repository secret
> `DEPLOYER_PRIVATE_KEY`, used by six legacy Fuji workflows, signs as this same address. Until the owner
> deletes it and decides whether to keep this deployer, the launch is blocked
> (`deploy/mainnet/PREFLIGHT-2026-10-12.md`).
>
> **Test first on Fuji:** `/fuji-rabby-test` is the same page with a Fuji-only plan
> (`deploy/fuji/RABBY-TEST.md`). It proves Rabby, the account, one exact transaction and the
> verification before any mainnet signature. It needs its own authorization.

## In the browser (the owner's path; no terminal)

**Entry point:** <https://the-void-alpha.vercel.app/owner-deploy> (also `/owner-deploy.html`).

Open it in the browser profile where Rabby holds the deployer.

**How a plan gets there.** Claude prepares the plan without any key, from live C-Chain, and opens a
GitHub PR that adds it under `deploy/mainnet/approved-plans/`. CI recomputes every transaction from
the contracts compiled on that commit. **Merging that PR is your approval of those exact
transactions.** Vercel then publishes the page with the plan.

**What you click:**
1. Open the page. The **Next** banner always shows the one thing to do. Section 1 shows the
   approved plan: deployer, fee recipient, contracts, constructor arguments, predicted addresses,
   binding. The page re-checks the binding in your browser.
2. Press **Connect Rabby**. Approve the site connection in Rabby. The page accepts only the deployer
   `0xaBd3…c174` on Avalanche C-Chain.
3. Section 3 shows live readiness from C-Chain: nonce, no pending transaction, empty target
   addresses, enough AVAX for gas. Every row must say PASS. If one fails, the banner says what to
   do; then press **Re-check**.
4. Once, before the first real signature, do the [Rabby check](#before-the-first-real-signature-rabby-check-sends-nothing):
   request step 1, read it in Rabby, and **reject** it.
5. **Step 1: factory.** Tick the review box and press **Request approval in Rabby**. In Rabby, check:
   - a contract deployment;
   - from `0xaBd3…c174`;
   - Avalanche C-Chain;
   - nonce 0;
   - value 0.

   Then **approve** in Rabby. The step moves from *Prepared* to *Wallet approval requested* to
   *Submitted* to **Confirmed and verified on chain**. The page verifies the transaction and the
   factory's settings itself, from Avalanche's public RPC.
6. **Step 2: marketplace.** The same, at nonce 1. It is offered only after step 1 is confirmed.
7. **Final check in GitHub.** The page then lists the transaction hashes.
   1. Open *Actions* → **Verify mainnet deployment** → **Run workflow**.
   2. Choose `release-per-contract-mainnet` and paste the hashes.

   It re-checks everything, including the deployed code against the compiled source, without any
   key. Send the hashes to Claude for the record PR.

If you reload, the page remembers submitted hashes in this browser and re-checks them. If Rabby
shows an error after sending, paste the hash from Rabby's activity into the step instead of signing
again. Nothing on the page can sign or send without your approval in Rabby.

The terminal procedures below remain for reference and recovery. Neither is needed for the browser
path.

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

### Quick start from a clean checkout (the entry point)

On your own machine, in the browser profile where Rabby holds the deployer:

1. **Get the code and build it.**
   ```
   git clone https://github.com/VoidcallerOC/The-Void.git && cd The-Void
   git checkout main && git pull
   npm ci
   foundryup --install v1.3.1      # Foundry v1.3.1, the version CI pins
   forge build
   ```
2. **Start the tool.**
   ```
   npm run owner:deploy
   ```
   It plans from the live chain without any key, for the defined deployer at its current nonce, with
   the recorded fee recipient. It prints the next action and a link such as
   `http://127.0.0.1:53817/s/<random>/`. Open that link. The HTML file cannot be opened directly;
   without the tool it only shows how to start.
3. **Follow the page.** The banner at the top always shows the stage and the single next action.
   - **Stage: planning.** The page lists every plan check with PASS, FAIL or UNVERIFIED and its
     reason. Nothing can be signed in this stage.
     - If the deployer is unfunded, the next action names the exact minimum in AVAX. Fund the
       deployer `0xaBd3…c174` on Avalanche C-Chain, then press **Re-check from the chain**.
     - When every check passes, read the fee recipient on the Nano S Plus screen (view only; the
       device signs nothing). Type it into the page, review the planned contracts and the two steps,
       and press **Approve plan**. That binds this exact plan to the commit and saves `plan.json` and
       `plan-binding.json` under `.owner-signing/`.
   - **Stage: signing.**
     1. Press **Connect Rabby**.
     2. Before the first real signature, do the [Rabby check](#before-the-first-real-signature-rabby-check-sends-nothing) once.
     3. **Step 1: factory.** Tick the review box and send it to Rabby. In Rabby, check:
        - it is a **contract deployment**;
        - from `0xaBd3…c174`;
        - on Avalanche C-Chain;
        - nonce 0;
        - value 0.

        Then approve. Wait for **verified**.
     4. **Step 2: marketplace.** The same, at nonce 1.
4. **Record.** Commit the written `deployments/release-per-contract-mainnet-<factory>.json` and fill
   `config/mainnet-release-per-contract.json` in a record PR (README step 7).

Expected plan: factory `0x262B…757b`, implementation `0x8064…9006` and marketplace `0x0e77…F8f5`, at
nonces 0 and 1.

### Alternative: a plan made in GitHub

Actions → *Plan release-per-contract infrastructure for C-Chain mainnet*, with:
- `expected_deployer_address` left at the default;
- `expected_deployer_nonce=0`;
- `platform_recipient=0xb65C…1ce4`.

The run uploads `plan.json` and `plan-binding.json` once the plan is ready (funded). Then, on the same
commit, after `forge build`:
```
npm run sign:mainnet -- --kind release-per-contract-mainnet --plan plan.json \
  --binding plan-binding.json --recipient-verified-on-device <address you read on the Nano>
```
The page then starts directly in the signing stage.

If you reject in Rabby, nothing is signed and the step can be offered again. If the page loses track
after Rabby submitted, paste the hash from Rabby's history into the step. If verification fails, stop
and review: nothing further is offered.

## Before the first real signature: Rabby check (sends nothing)

The page has been rehearsed only with a stand-in wallet. Do this check once with the real Rabby
before approving anything in Rabby.

- **Part 1 (connection) works before funding.** Run it in the planning stage.
- **Part 2 (the transaction preview)** needs the approved plan, so the deployer must be funded.

1. Run `npm run owner:deploy`, open the link and click **Connect Rabby**.
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
3. Start the tool with the claim's inputs, approve the plan on the page, and sign the single step in Rabby:
   ```
   npm run owner:deploy -- --kind genesis-claim-mainnet \
     --input GENESIS_CLAIM_RELEASE_CONTRACT=<release> --input GENESIS_CLAIM_PRIMARY_SALE=<sale> \
     --input GENESIS_CLAIM_TOKEN_ID=<token> --input GENESIS_CLAIM_START=<T> \
     --input GENESIS_PUBLIC_PRICE_WEI=250000000000000000 \
     --input GENESIS_CLAIM_ADMIN=<admin> --input GENESIS_CLAIM_SIGNER_ADDRESS=<signer public address>
   ```
   Or, with a plan made in GitHub:
   `npm run sign:mainnet -- --kind genesis-claim-mainnet --plan plan.json --binding plan-binding.json`.
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
- **Browser page** (`/owner-deploy`): its logic is unit-tested (`src/owner-deploy/flow.test.js`). The
  built page was rehearsed in Chromium on a local C-Chain fork with a stand-in wallet. It was also
  loaded against live C-Chain (read-only, nothing signed).
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
