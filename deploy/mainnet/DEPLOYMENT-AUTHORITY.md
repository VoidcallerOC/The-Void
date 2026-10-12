# Mainnet deployment authority

**Policy (owner decision): the mainnet deployer's private key is never placed in GitHub, CI, any
cloud service, a file, a script environment or an agent's possession.** The owner signs every mainnet
deployment in Rabby, with the defined deployer `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, on their
own machine. The deployer address does not change. Procedure: [`OWNER-SIGNING.md`](./OWNER-SIGNING.md).

This replaces the previous design, in which a GitHub `broadcast` job signed with a
`mainnet-deployment` environment secret `MAINNET_DEPLOYER_PRIVATE_KEY`. That job, the secret, the
environment and the recommendation to generate a replacement mainnet deployer are all withdrawn.

## 1. Roles (fixed)

| Wallet | Address | Authority in the launch |
| --- | --- | --- |
| Rabby: platform deployer | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` | Signs contract deployments only. Never creates releases or editions. The deployed factory and marketplace are ownerless, so it holds no role afterwards. |
| Artist wallet | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | Creates the release and edition, configures the sale, and grants the claim `ISSUER_ROLE`. These are the artist's own operations, separate from deployment. |
| Ledger Nano S Plus | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` | Passive fee recipient. Signs nothing in the launch. |
| Ledger X | — | Personal; no role. |

`config/mainnet-release-per-contract.json` records the deployer, the artist wallet and the fee
recipient. The scripts refuse:
- a plan for any other deployer;
- a fee recipient that is the artist or the deployer;
- a Genesis release that the artist wallet does not own and administer, or that the deployer or the
  fee recipient administers.

## 2. Controls enforced in code

Each is tested in `test/mainnet-deployment-safety.test.mjs`, `scripts/mainnet-signing-requests.test.mjs`,
`scripts/mainnet-owner-signing.test.mjs`, `scripts/deployment-plan-binding.test.mjs` and the script tests.

1. **No mainnet key anywhere in automation.**
   - The mainnet workflows have one key-less `plan` job: no environment, no signing step, no
     broadcast input.
   - Their first step fails the run if a `MAINNET_DEPLOYER_PRIVATE_KEY` secret exists at all. It
     evaluates only `secrets.MAINNET_DEPLOYER_PRIVATE_KEY != ''`, a true/false value.
   - No workflow references a `mainnet-deployment` environment or runs the signing tool.
2. **No key in any mainnet script.**
   - `deploy-release-per-contract-mainnet.mjs`, `deploy-genesis-claim.mjs` (mainnet), the signing
     tool and the legacy `deploy-marketplace.mjs` / `deploy-release-factory-v3.mjs` (mainnet) refuse
     to run while any `*PRIVATE_KEY` variable is set.
   - They refuse `BROADCAST_DEPLOYMENT=yes` for mainnet.
   - No mainnet code path constructs a signer.
3. **The plan is the transaction.** Each plan carries the exact unsigned creation transaction per
   contract: chain 43114, the deployer, the nonce, no `to`, value 0, the full creation data and its
   hash, and the predicted address. The plan binding covers those hashes, together with the artifact
   hashes, constructor arguments, nonces and predicted addresses. A request that disagrees with its
   own plan cannot be bound.
4. **Re-plan and match before signing.** The signing tool starts only when three things agree on the
   checked-out, unmodified commit: the reviewed plan, the approved binding, and a fresh key-less plan
   from the live chain. It re-matches before the first signature.
5. **Live checks before each signature:**
   - the chain ID;
   - the nonce is the planned nonce, with nothing pending;
   - the deployer is an EOA;
   - the target addresses are empty.
6. **Rabby only, one step at a time.** The page:
   - selects Rabby by EIP-6963 `io.rabby`;
   - requires the deployer account on chain 43114;
   - requires a per-step review tick;
   - re-hashes the data before handing it over;
   - offers a step only after every earlier step is verified on chain.

   It is served on `127.0.0.1` behind a random session path. It refuses cross-origin writes and any
   other `Host`.
7. **Independent verification after mining.** From the tool's own RPC, never the wallet:
   - chain, sender, nonce, no recipient and zero value;
   - the exact creation-data hash, success, and the created address;
   - runtime code equal to the compiled artifact, with only the compiler-listed immutable slots
     masked;
   - every immutable setting: fee recipient, 250 bps fees, the royalty lock, the factory↔marketplace
     binding, and the claim schedule and roles.

   `npm run verify:mainnet` repeats this at any time.
8. **The mainnet manifest is unchanged in substance:** `deployed: false`,
   `deploymentAuthorized: false`, no contract addresses.

## 3. Tested, and not tested

- **Tested:**
  - the unit suites above;
  - a full rehearsal on a local anvil fork of C-Chain (block 97,377,115). Chromium ran the real
    signing page against a stand-in for Rabby: the factory, implementation and marketplace at the
    documented predicted addresses, then the Genesis claim, each verified, then re-verified by
    `verify:mainnet`. Details: [`OWNER-SIGNING.md`](./OWNER-SIGNING.md).
- **Not tested: the real Rabby extension.** The page uses standard EIP-1193 calls only. Whether Rabby
  honours the supplied `nonce` is UNVERIFIED. The tool does not rely on it: it checks the live nonce
  before signing, and refuses any mined transaction whose nonce or address differs.

## 4. Open items that need the owner

| # | Item | Status |
| --- | --- | --- |
| O1 | **The GitHub copy of the deployer key: delete it (owner decision made: the key must not remain in GitHub).** The repository secret `DEPLOYER_PRIVATE_KEY` is used by six Fuji workflows. Fuji run 38252855896 (2026-10-12) signed as `0xaBd3…c174` from a job with no environment, so it is a repository-level secret. Deleting it through automation was attempted and refused (HTTP 403: this session's proxy blocks the Actions secrets API). No secret value was read. Manual steps: section 5. Deleting it does not prove that no other copy exists. | **OPEN: owner action** |
| O1a | **The Render cron copy.** `DEPLOYER-AUTHORITY-ROTATION-PLAN.md` recorded this address as the key of the suspended Render cron `crn-dat953e0tbcc73acrepg`. The owner deleted that cron on 2026-10-11 (`FUJI-V3-OWNER-DECISIONS.md`, D5). On 2026-10-12 the Render API returns 404 for it, and the workspace lists only `the-void-api-fuji` and `the-void-indexer-fuji`. Neither the server code nor either Render blueprint reads `DEPLOYER_PRIVATE_KEY`. | **Closed** (deleted; verified 404) |
| O2 | While the GitHub copy (O1) or any other copy exists outside Rabby, whoever holds it could use nonce 0 or 1 first, or spend the deployer's funding. The tool fails closed in that case: nonce, empty-address and binding checks. The launch would then need a new plan. | Consequence of O1 |
| O3 | First use of the real Rabby extension (section 3). This includes whether Rabby injects its provider into a page served from `http://127.0.0.1`, and whether it honours the supplied `nonce`. | **UNVERIFIED** until the no-transaction check in `OWNER-SIGNING.md` |
| O4 | `main` ruleset 24685434 has only a `deletion` rule (no required PR, status checks or force-push block). | **OPEN** (repository setting) |
| O5 | Actions are pinned by tag, not commit SHA. With no key in any mainnet job, the exposure is limited to the plan's integrity. The signing tool re-derives the plan locally and matches it. | Lower risk; open |

## 5. Deleting `DEPLOYER_PRIVATE_KEY` from GitHub (owner, manual)

1. GitHub → `VoidcallerOC/The-Void` → **Settings** → **Secrets and variables** → **Actions** →
   **Repository secrets**.
2. On the `DEPLOYER_PRIVATE_KEY` row, choose **Delete** (the bin icon), then confirm. GitHub never
   shows the value. Do not copy it anywhere first.
3. On **Environments**: no environment should hold any deployer key. Open each environment, if any,
   and check its secrets.
4. **To verify:**
   - the Repository secrets list no longer shows `DEPLOYER_PRIVATE_KEY`;
   - no `MAINNET_DEPLOYER_PRIVATE_KEY` exists either (the mainnet plan workflows fail if it does).

**What stops working.** Every Fuji path that signs with the deployer refuses to run without the key.
Each one fails closed, before any transaction:

| Workflow | Stops | Still works (key-less) |
| --- | --- | --- |
| `deploy-release-fuji.yml` (legacy V1) | The whole workflow: every run deploys and smoke-tests with the key | — |
| `deploy-release-v2-fuji.yml` (legacy V2) | The `deploy-and-verify` job | The preflight job (`preflight_only`), which plans from `RELEASE_ADMIN_ADDRESS` |
| `deploy-release-per-contract-fuji.yml` | The broadcast step | The dry run |
| `deploy-release-factory-v3-fuji.yml` | The broadcast step | The dry run |
| `deploy-genesis-claim-fuji.yml` | The broadcast step | The dry run |
| `rehearse-royalty-fuji.yml` | The rehearsal broadcast (the Fuji-first gate is already satisfied and recorded) | The plan |

Unaffected:
- the mainnet plan workflows;
- `ci.yml`;
- `fuji-readonly-probe.yml`;
- the deployed Fuji contracts;
- the Fuji API and indexer on Render, which read no deployer key.

**Optional follow-up PR.** These Fuji workflows can then be made explicit, rather than failing at
signing time: remove the signing step from each and leave its key-less dry run or plan. That is a
separate change, made only with the owner's authorization.

