# Mainnet deployment authority and workflow security

**Status: code controls in place; the GitHub settings they rely on are MISSING or UNVERIFIED
(section 3).** This file says which controls the repository enforces in code, and which ones the owner
must configure in GitHub. A workflow that references an environment does not create that environment's
protection rules. Mainnet stays blocked until the owner completes section 4: mainnet signs only with
`MAINNET_DEPLOYER_PRIVATE_KEY`, which does not exist yet, so every mainnet broadcast fails closed.

Baseline: the Deployer-Key Custody & Deployment Authority Review of `main` at `90f46d2`.

## 1. Before and after

| | Before (`90f46d2`) | After (this change) |
|---|---|---|
| Legacy `deploy-release-v2-mainnet.yml` | Active. Injected the key into every step of its job on every dispatch. One dispatch with a typed confirmation could broadcast. | Removed, together with `scripts/deploy-release-v2-mainnet.mjs` and the `deploy:release-v2-mainnet` command. |
| Mainnet per-contract and Genesis workflows | One job. When broadcast was requested, the key reached `npm ci`, `forge build`, `forge test` and `npm test`. No environment. The key was the repository secret `DEPLOYER_PRIVATE_KEY`, shared with Fuji. | Two jobs. **`plan`**: no key, no environment, main only. Its first step **fails if `MAINNET_DEPLOYER_PRIVATE_KEY` is visible without the environment**. It then builds, tests, dry-runs and binds the reviewed plan to the commit. **`broadcast`**: requires `environment: mainnet-deployment`, main, the boolean and the exact confirmation. It re-plans without the key and refuses unless the result matches the approved plan. Only then does the signing step receive `MAINNET_DEPLOYER_PRIVATE_KEY`, a name no Fuji workflow uses. If that environment secret is missing, the key is empty and the script refuses; it never falls back to the repository secret. |
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

1. **No workflow- or job-level key.** No workflow sets the deployer key at workflow or job level. Each reference is in the `env:` of one signing step.
2. **The signing steps do nothing else.** No step that receives the key runs `npm ci`, a build, a test, lint, a dry run or a checkout.
3. **No key on a command line.** No workflow passes the key as an argument (`--private-key`, `cast wallet address`).
4. **Manual dispatch, read-only token.** Every workflow that references the key triggers only on `workflow_dispatch`, with `permissions: contents: read`. No workflow uses `pull_request_target`. So pull-request code never runs in a job that holds the key.
5. **Mainnet broadcast is off by default.** It needs `broadcast_deployment=true` and the exact confirmation string, and the run must be on `refs/heads/main`. The broadcast job declares `environment: mainnet-deployment`.
6. **Separate mainnet secret.** Mainnet signs only with `secrets.MAINNET_DEPLOYER_PRIVATE_KEY`. No Fuji workflow references that name, and no mainnet workflow references `secrets.DEPLOYER_PRIVATE_KEY`.
7. **Secret-scope tripwire.** The first step of each mainnet `plan` job runs without an environment, so it can see only repository- and organization-level secrets. It evaluates `secrets.MAINNET_DEPLOYER_PRIVATE_KEY != ''`, which is a true/false value and never the secret itself. It fails the run if the result is true, so a mainnet key stored at repository or organization scope blocks every mainnet run, dry runs included.
8. **The plan is reviewable before signing.** The plan job uploads `plan.json`, `plan-binding.json` and the dry-run log as `<workflow>-plan-<run id>`. The broadcast job checks out the same `github.sha`. It re-plans without the key and runs `scripts/deployment-plan-binding.mjs verify`. This fails if the commit, the deployer, the nonce, the predicted addresses, the constructor arguments or the artifact hashes changed (and, for Genesis, the target, schedule or roles). The signing step comes after this check.
9. **Fuji signing steps are gated.** They run only on `refs/heads/main` with the exact confirmation. Otherwise a refusal step fails the job before any key is exposed.
10. **The mainnet manifest is unchanged:** `deployed: false`, `deploymentAuthorized: false`, no addresses, and the passive fee recipient `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`.

## 3. GitHub settings: verified state (2026-10-12)

These are read-only checks made from this repository's automation session. The session cannot read
settings endpoints: `environments`, `branches/main/protection`, `actions/secrets` and
`actions/permissions` are refused (HTTP 403, "not permitted through this proxy"). Anything that needs
those endpoints is **UNVERIFIED**, not assumed.

| # | Setting | Status | Evidence | Owner action |
|---|---|---|---|---|
| 1 | `mainnet-deployment` environment exists | **UNVERIFIED (likely MISSING)** | The environments API is refused. The public deployments API lists only `Preview` (67) and `Production` (33), which are Vercel. An environment that no job has run leaves no record, so absence there is not proof. | Create it (section 4, step 1). |
| 2 | Required reviewers | **UNVERIFIED** | Environments API refused. | Add yourself as the required reviewer. |
| 3 | Prevent self-review | **UNVERIFIED** | Environments API refused. | See section 5: with one account, turning it on makes broadcasts impossible. |
| 4 | Deployment branches limited to `main` | **UNVERIFIED** | Environments API refused. | "Selected branches and tags": `main`. |
| 5 | Administrator bypass disabled | **UNVERIFIED** | Environments API refused. | Turn off "Allow administrators to bypass configured protection rules". |
| 6 | Mainnet deployer key scoped only to the environment | **MISSING** | The workflows now require `MAINNET_DEPLOYER_PRIVATE_KEY`, which has never been used and cannot exist in the environment until the environment exists. The key the workflows used until now, `DEPLOYER_PRIVATE_KEY`, **is reachable without any environment**: Fuji run 38252855896 (2026-10-12) signed with it from a job that declares no environment, so it is a repository- or organization-level secret. Its value was not read. | Section 4. |
| 7 | `main` branch protection | **MISSING (partial)** | Public `GET /repos/.../branches/main`: `protected: true`, required status checks `enforcement_level: off`. Public `GET /repos/.../rules/branches/main`: one active repository ruleset (24685434, "main") with only a `deletion` rule and no bypass actors. No pull-request, review, status-check, force-push or push-restriction rule is visible. Classic branch-protection details: UNVERIFIED (endpoint refused). | Add to ruleset 24685434: require a pull request, block force pushes, require the `build-and-test` status check. |
| 8 | Who can dispatch workflows | **VERIFIED: one account** | `list_repository_collaborators`: only `VoidcallerOC` (admin). Anyone with write access can dispatch. Repository and organization Actions policies: UNVERIFIED (endpoint refused). | Keep collaborators minimal. Under Settings → Actions → General, keep the default `GITHUB_TOKEN` permissions read-only. |
| 9 | Apps, tokens and automation with write or dispatch rights | **PARTIAL** | Observed: (a) this automation session acts as `VoidcallerOC` through the Claude GitHub App and **can dispatch workflows**; it dispatched both Fuji rehearsal runs, 38252526518 and 38252855896, on the owner's instruction. (b) `vercel[bot]` posts deployment comments and statuses, so the Vercel app is installed. The full list of app installations and personal access tokens: UNVERIFIED (needs owner settings access). | Settings → GitHub Apps / Integrations, and your account's token settings: review every app and token with Actions or Contents write. |
| 10 | No automation identity is a required reviewer | **UNVERIFIED** | Environments API refused. Note that this session authenticates *as* `VoidcallerOC`. If that account is the reviewer, an automation session holding its token could approve through the API. | Section 5. |

Other evidence:
- No mainnet workflow has ever run. `deploy-release-v2-mainnet.yml`, `deploy-release-per-contract-mainnet.yml` and `deploy-genesis-claim-mainnet.yml` each show 0 runs.
- The last `workflow_dispatch` run in the repository is the Fuji rehearsal at 2026-10-12 13:01Z.
- The repository is **public**, so its workflow files, run logs and artifacts are visible to anyone.

## 4. Owner steps, in order (no secret passes through any assistant, PR, log or command output)

1. **Create the environment.** Settings → Environments → **New environment** → name `mainnet-deployment`.
   - **Required reviewers:** add your own account. See section 5 for what this does and does not give you.
   - **Prevent self-review:** leave it **off** while you are the only possible reviewer (section 5).
   - **Deployment branches and tags:** "Selected branches and tags", add rule `main`.
   - **Allow administrators to bypass configured protection rules:** off.
   - **Wait timer:** optional, for example 10 minutes. It gives you a pause after dispatching to cancel.
   - **To verify:** the environment page lists one required reviewer, the `main` branch rule, and no bypass.
2. **Choose the mainnet key** (section 6).
3. **Add the key only to the environment.** On the `mainnet-deployment` page → Environment secrets → **Add secret**. Name: `MAINNET_DEPLOYER_PRIVATE_KEY`. Enter the value directly into GitHub, from your offline or hardware-backed source. Never paste it into chat, a PR, an issue, a commit or a terminal that is logged.
4. **Do not create `MAINNET_DEPLOYER_PRIVATE_KEY` at repository or organization level.** If it exists there, the mainnet `plan` job fails by design.
   - **To verify without exposing anything:** dispatch the mainnet workflow as a **dry run**, with `broadcast_deployment` false. Its first step must print "MAINNET_DEPLOYER_PRIVATE_KEY is not reachable from this unprotected job."
   - **To check scope directly:** Settings → Secrets and variables → Actions → **Repository secrets** must not list `MAINNET_DEPLOYER_PRIVATE_KEY`.
5. **Decide about the repository secret `DEPLOYER_PRIVATE_KEY`.**
   - Once PR #174 is merged, only the Fuji workflows use it.
   - If it holds the same key as the mainnet deployer, the mainnet key is still readable by any workflow a writer can run, from any branch. Moving the mainnet copy into the environment then closes nothing (section 6).
6. **Tighten `main`.** Settings → Rules → Rulesets → `main` (24685434). Add:
   - "Require a pull request before merging";
   - "Block force pushes";
   - "Require status checks to pass", with `build-and-test`.

   **To verify:** `https://api.github.com/repos/VoidcallerOC/The-Void/rules/branches/main` lists those rules.
7. **Review apps and tokens:**
   - Settings → GitHub Apps (installed apps, including Claude and Vercel);
   - your account → Settings → Developer settings → Personal access tokens;
   - remove any app or token you do not need that has Actions or Contents write.

## 5. Single-approver limitation (stated plainly)

`VoidcallerOC` is the only collaborator, so GitHub has no second person to require.

- **With "Prevent self-review" on:** the account that dispatches a run cannot approve it. With one
  account, no mainnet broadcast could ever be approved.
- **With it off:** the owner dispatches and then approves their own run. The environment gate adds:
  - a deliberate second action;
  - a review point after the key-less plan and its binding are visible;
  - a `main`-only branch rule.

  It is **not** independent two-person authorization. This repository does not describe it as such.
- **Automation risk.** This automation session authenticates as `VoidcallerOC` and can call the
  Actions API, including dispatch, as it did for the Fuji rehearsal.
  - If GitHub allows that token to approve pending deployments, then an automation session could both
    dispatch and approve a mainnet broadcast as the owner. This is UNVERIFIED.
  - Mitigations, each an owner decision:
    - add a second human reviewer (another account, controlled by a different person) and turn on
      "Prevent self-review";
    - or restrict the Claude GitHub App's permissions on this repository so it cannot write to Actions
      or deployments;
    - and in any case, never let an automation session hold a dispatch-plus-approve capability during
      the launch window.

  An automation account is **not** added as a reviewer to make the settings look compliant.

## 6. Fuji/mainnet key reuse (an owner decision; no key was created or changed)

**What is reused:**
- The documented mainnet deployer is `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` (`deploy/mainnet/README.md`). The key-less mainnet dry run on 2026-10-12 predicted the factory `0x262B…757b` and marketplace `0x0e77…F8f5` from it, at C-Chain nonce 0.
- The same address is the Fuji CI deployer. It signed the Fuji rehearsal (run 38252855896, nonces 61–70) and the earlier Fuji deployments, from the repository secret `DEPLOYER_PRIVATE_KEY`.
- Until this PR, that secret was exposed job-wide in Fuji runs, including the `npm ci` install, Foundry and the test steps.

**Is it material?** Yes, before and during the launch. After deployment it matters less.
- The mainnet factory and marketplace are ownerless, with immutable fees. The Genesis claim's admin and signer are separate keys. So once mined, the deployer controls nothing.
- Before and during the launch, anyone who obtains this key can:
  - **drain the gas funding** the moment the address is funded on C-Chain;
  - **use nonce 0/1 first.** The scripts' nonce, empty-address and plan-binding checks then fail closed, but the launch is blocked until it is re-planned.
- The key's exposure history (repository secret, job-wide in many Fuji runs) makes "only the owner has it" UNVERIFIED.

**Minimum safe migration (owner-controlled):**
1. Generate a new mainnet deployer key offline, or on a hardware-backed signer that can export to the environment secret. Record only its public address.
2. Store it as `MAINNET_DEPLOYER_PRIVATE_KEY` in `mainnet-deployment` (section 4).
3. Keep `DEPLOYER_PRIVATE_KEY` (`0xaBd3…c174`) as the Fuji-only repository secret. Fuji contracts, Fuji roles and the completed rehearsal are unaffected: no Fuji workflow changes.
4. Run the mainnet dry run with `expected_deployer_address` = the new address. It recomputes the predicted factory, implementation and marketplace from the new address at nonce 0. The `0x262B…`, `0x8064…` and `0x0e77…` predictions in the docs become stale.
5. Update `deploy/mainnet/README.md` (deployer row, steps 4 and 11) and the funding step to the new address. Fund the **new** address, never `0xaBd3…c174`, on C-Chain.

The mainnet manifest records no deployer address, so it needs no change. No contract change is needed.

## 7. Residual risks

| # | Risk | Status |
|---|---|---|
| R1 | The mainnet key's scope. The code now requires an environment-only `MAINNET_DEPLOYER_PRIVATE_KEY` and trips if it is repository-scoped. If the owner puts the same key value there that the repository secret `DEPLOYER_PRIVATE_KEY` holds, it stays readable from any branch through the Fuji secret. | **OPEN** until section 4 is done **and** section 6 is decided. |
| R2 | The same key served Fuji CI and is the planned mainnet deployer, with a broad exposure history. | **OPEN.** Owner decision (section 6). |
| R3 | One owner means no independent second approver, and the automation session acts as the owner's account. | **OPEN.** Documented limitation (section 5). |
| R4 | `mainnet-deployment` reviewers, branch rule and admin bypass. | **UNVERIFIED.** The environment is likely missing. |
| R5 | `main` allows direct and force pushes and has no required status checks (ruleset has only `deletion`). | **MISSING.** Section 4, step 6. |
| R6 | Actions are pinned by tag (`actions/checkout@v4`, `foundry-rs/foundry-toolchain@v1`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`), not by commit SHA. The npm dependencies (ethers) run inside the signing step. | **OPEN.** Pinning by SHA is recommended. |
| R7 | Run locally, `deploy:marketplace` (legacy `MusicMarketplace`) and `deploy:release-factory-v3` accept `DEPLOY_NETWORK=mainnet` with a typed confirmation, given a key in the local environment. No workflow uses them for mainnet. | **OPEN.** Key custody is the control. |
| R8 | `deploy-genesis-claim-fuji.yml` declares 13 `workflow_dispatch` inputs. actionlint 1.7.7 flags this against its 10-input rule. It was the same on `main` before this change. | Pre-existing. UNVERIFIED whether GitHub accepts the dispatch. |
| R9 | Until PR #174 merges, the legacy `deploy-release-v2-mainnet.yml` is still an **active** workflow on `main` (0 runs ever). It injects the repository secret job-wide. | **OPEN until merge.** Interim option: Actions → that workflow → "Disable workflow". |
