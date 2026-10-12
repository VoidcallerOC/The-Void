# Mainnet deployment authority and workflow security

**Status: code controls in place; GitHub settings NOT VERIFIED.** This file says which controls the
repository enforces in code, and which ones the owner must configure in GitHub. A workflow that
references an environment does not create that environment's protection rules. Until the settings in
section 3 are configured and checked in GitHub, **a single person with write access can still reach
`DEPLOYER_PRIVATE_KEY`** (section 4, R1).

Baseline: the Deployer-Key Custody & Deployment Authority Review of `main` at `90f46d2`.

## 1. Before and after

| | Before (`90f46d2`) | After (this change) |
|---|---|---|
| Legacy `deploy-release-v2-mainnet.yml` | Active. Injected the key into every step of its job on every dispatch. One dispatch with a typed confirmation could broadcast. | Removed, together with `scripts/deploy-release-v2-mainnet.mjs` and the `deploy:release-v2-mainnet` command. |
| Mainnet per-contract and Genesis workflows | One job. When broadcast was requested, the key reached `npm ci`, `forge build`, `forge test` and `npm test`. No environment. | Two jobs. **`plan`**: no key, no environment, main only. It builds, tests, dry-runs and binds the reviewed plan to the commit. **`broadcast`**: requires `environment: mainnet-deployment`, main, the boolean and the exact confirmation. It re-plans without the key and refuses unless the result matches the approved plan. Only then does the key reach the single signing step. |
| Fuji per-contract and Factory V3 | The key reached every step, including dry runs. The scripts required it even for a dry run. | Dry runs plan from `expected_deployer_address`, now a required input. The key reaches only the signing step, which runs only from main with the exact confirmation. |
| Fuji Genesis claim | The key reached every step, including dry runs. | Same as Fuji per-contract and Factory V3. |
| Fuji royalty rehearsal | When broadcast was requested, the key was job-wide, including build and test. | Same as Fuji per-contract and Factory V3. |
| Legacy Fuji V1 (`deploy-release-fuji.yml`) | Key job-wide. Passed on the command line (`cast wallet address --private-key`). Every dispatch signs. | The key reaches only the deploy and smoke-test steps. No command-line use. The job runs only from main. |
| Legacy Fuji V2 (`deploy-release-v2-fuji.yml`) | Key job-wide in both jobs, including the read-only preflight. Passed on the command line. | The preflight plans from `RELEASE_ADMIN_ADDRESS`, which the key must control. The key reaches only the deploy step. No command-line use. The deploy job runs only from main. |
| Checkout token in deployment jobs | Persisted in `.git/config`. | `persist-credentials: false` everywhere. |

The scripts still check that the key controls the reviewed address before they sign: the deployer,
the nonce, the predicted addresses, the fee recipient, the 250 bps economics, the chain ID (43114 or
43113), the artifacts, and the role separation.

## 2. Controls enforced in code (tested in `test/mainnet-deployment-safety.test.mjs`)

1. **No workflow- or job-level key.** No workflow sets `DEPLOYER_PRIVATE_KEY` at workflow or job level. Each reference is in the `env:` of one signing step.
2. **The signing steps do nothing else.** No step that receives the key runs `npm ci`, a build, a test, lint, a dry run or a checkout.
3. **No key on a command line.** No workflow passes the key as an argument (`--private-key`, `cast wallet address`).
4. **Manual dispatch, read-only token.** Every workflow that references the key triggers only on `workflow_dispatch`, with `permissions: contents: read`. No workflow uses `pull_request_target`. So pull-request code never runs in a job that holds the key.
5. **Mainnet broadcast is off by default.** It needs `broadcast_deployment=true` and the exact confirmation string, and the run must be on `refs/heads/main`. The broadcast job declares `environment: mainnet-deployment`.
6. **The plan is reviewable before signing.** The plan job uploads `plan.json`, `plan-binding.json` and the dry-run log as `<workflow>-plan-<run id>`. The broadcast job checks out the same `github.sha`. It re-plans without the key and runs `scripts/deployment-plan-binding.mjs verify`. This fails if the commit, the deployer, the nonce, the predicted addresses, the constructor arguments or the artifact hashes changed (and, for Genesis, the target, schedule or roles). The signing step comes after this check.
7. **Fuji signing steps are gated.** They run only on `refs/heads/main` with the exact confirmation. Otherwise a refusal step fails the job before any key is exposed.
8. **The mainnet manifest is unchanged:** `deployed: false`, `deploymentAuthorized: false`, no addresses, and the passive fee recipient `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`.

## 3. Owner configuration required in GitHub (not enforced by this change)

Every item below was **UNVERIFIED** at the time of writing. Check each one in GitHub before step 6
of `deploy/mainnet/README.md`.

1. **Create the `mainnet-deployment` environment** (Settings → Environments):
   - **Required reviewers:** the people allowed to release a mainnet broadcast.
   - **Prevent self-review:** on.
   - **Deployment branches and tags:** "Selected branches", with `main` only.
   - **Allow administrators to bypass configured protection rules:** off.
   - If the environment does not exist, GitHub creates it on the first run **without** any
     protection. Create it first.
2. **Move `DEPLOYER_PRIVATE_KEY` into the `mainnet-deployment` environment secrets**, and delete it
   from the repository secrets.
   - While it is a repository secret, any workflow run by a user with write access can read it.
     That includes a workflow file changed on a non-main branch, which ignores the `if:` gates in
     this repository.
   - An environment secret is released only to jobs that pass that environment's rules.
3. **Give Fuji its own key.** Today the mainnet deployer `0xaBd3…c174` is also the Fuji CI deployer
   (`deploy/mainnet/README.md`, and `DEPLOYER-AUTHORITY-ROTATION-PLAN.md`). Once the key leaves the
   repository secrets, the Fuji workflows can no longer sign. Choose one of these:
   - (a) A separate Fuji key, stored as a Fuji-only secret. This is recommended: testnet automation
     then never holds mainnet authority.
   - (b) A protected Fuji environment that holds the same key. This is not recommended, because it
     keeps mainnet authority in Fuji automation.

   A new mainnet deployer changes the predicted mainnet addresses (currently derived from
   `0xaBd3…c174` at nonce 0). That needs a new dry run and the owner's decision. This change does
   not make it.
4. **Branch protection on `main`:**
   - require a pull request with an approving review;
   - block force-pushes and deletion;
   - restrict who can push.

   The main-only gates are only as strong as this protection.
5. **Who can dispatch.** Anyone with write access can run `workflow_dispatch`. Review the
   collaborators and teams with write, maintain or admin access, and keep the list minimal.
6. **Who can approve.** Only the required reviewers listed on `mainnet-deployment`.
7. **Automation identities.** Review the installed GitHub Apps, fine-grained tokens and other
   automation that hold Actions write (they can dispatch and re-run workflows) or deployment-review
   rights. This includes the Claude and Vercel apps and any personal access tokens. In this
   repository's history, workflows have been dispatched through an automation session acting as the
   owner's account. No automation identity should be, or act as, a required reviewer.

**Approval independence.** GitHub can enforce a second person only if a second person is a required
reviewer and "Prevent self-review" is on. With one owner account, the gate is the owner approving
their own dispatch. It adds a deliberate pause and a review of the plan, but it is **not** an
independent second approval. This change makes no claim of two-person control.

## 4. Residual risks

| # | Risk | Status |
|---|---|---|
| R1 | `DEPLOYER_PRIVATE_KEY` is a repository secret, so any workflow run by a writer can read it, regardless of these gates. | **OPEN until section 3.2 is done.** Secret scope is UNVERIFIED. |
| R2 | The same key is the Fuji CI deployer and the planned mainnet deployer. | **OPEN.** Owner decision (section 3.3). |
| R3 | One owner means no independent second approver. | **OPEN.** Documented limitation. |
| R4 | The `mainnet-deployment` reviewers, branch rule and admin bypass are not configured, or not verified. | **UNVERIFIED.** |
| R5 | `main` branch protection, the collaborator list and app permissions. | **UNVERIFIED.** |
| R6 | Actions are pinned by tag (`actions/checkout@v4`, `foundry-rs/foundry-toolchain@v1`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`), not by commit SHA. The npm dependencies (ethers) run inside the signing step. | **OPEN.** Pinning by SHA is recommended. |
| R7 | Run locally, the commands `deploy:marketplace` (legacy `MusicMarketplace`) and `deploy:release-factory-v3` accept `DEPLOY_NETWORK=mainnet` with a typed confirmation. They need the key in a local environment. No workflow uses them for mainnet. | **OPEN.** Key custody is the control. |
| R8 | `deploy-genesis-claim-fuji.yml` declares 13 `workflow_dispatch` inputs. actionlint 1.7.7 flags this against its 10-input rule. It was the same on `main` before this change. | Pre-existing. UNVERIFIED whether GitHub accepts the dispatch. |
