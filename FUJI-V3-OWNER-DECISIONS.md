# Fuji Factory V3: owner decisions D2 and D5, and dry-run evidence

**Status:**
- D2 is **DECIDED: Option A (keep as is)**, by the owner on 2026-10-11. No Solidity change.
- D5 is **DONE**: the owner deleted the suspended Render cron `crn-dat953e0tbcc73acrepg` on 2026-10-11; verified through the Render API (§3).
- The dry run is **COMPLETE**.
- The broadcast is **NOT AUTHORIZED**.

Nothing in this document makes a decision for the owner, and nothing here was signed, broadcast or changed in production.

## 1. Dry-run evidence (kept; do not rerun unless code, secrets or deployer state change)

**Run:** [38149347518](https://github.com/VoidcallerOC/The-Void/actions/runs/38149347518).
- Job 114499324825; workflow `deploy-release-factory-v3-fuji.yml`.
- `main` at `48037a786ac14ede59c1b534dba72a82097fceae`.
- Triggered by VoidcallerOC; 2026-10-11 14:58:31–14:59:08 UTC; result success.

| Item | Value |
|---|---|
| Mode | `BROADCAST_DEPLOYMENT: no`, `"mode": "DRY_RUN"`, `broadcasted=false`, "No transaction was broadcast." |
| `rpc_chain_id` | 43113 |
| Deployer | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` (matched the `expected_deployer_address` input) |
| Balance | 487517025061423390 wei (0.4875 AVAX) |
| Nonce / pending | 61 / 61 |
| Predicted Factory V3 | `0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338` (nonce 61) |
| Predicted ReleaseMarketplaceV3 | `0x717cf06380e36176728e351f4dabC48cF5ef3158` (nonce 62) |
| Contracts | fresh `forge build`; V5 suite 26 passed, 0 failed |
| Deploy-script tests | 15 passed |
| Artifact | `release-factory-v3-fuji-38149347518` (ID 11706470876, 859 bytes, `deployment-output.log` only) |
| Read-only gas estimate (separate) | ≈5.26M (factory) + ≈1.36M (marketplace); ≤ 0.166 AVAX at 25 gwei |

**Independent check after the run** (Fuji block 59307983):
- Both predicted addresses re-derived from the deployer and nonce, and they match.
- No code at either address.
- The deployer's nonce is still 61 with nothing pending.

**The predicted addresses hold only while the deployer's next transaction is the factory deployment.** Any earlier transaction from that key shifts them. A broadcast run prints and verifies the addresses it actually mined.

## 2. D2: who may lift the album caps

**Today (V4, deployed; V5, unchanged from V4 here):**
- `approveExpandedRelease(releaseId, maxTracks, maxSingles)` requires `DEFAULT_ADMIN_ROLE` on the release clone. The artist receives that role at initialization; the platform has none.
- The defaults are 13 tracks and 4 singles. New limits may not be lower than the defaults or the current counts.
- There is **no upper bound**, and the function can be called again until `closeAlbum`.

So in practice the caps are a **default the artist may lift at any time**, not a platform rule. Existing V2/V4 clones keep this behaviour whatever is chosen; D2 only affects V5 releases.

| Option | Who can lift the caps | On-chain trust model | Solidity change? | Consequences |
|---|---|---|---|---|
| **A. Keep as is** | The artist (release admin), any number of times, no ceiling | Unchanged: no platform signer on artist contracts | **No** | V5 ships as written and reviewed. The caps stay advisory; the UI may still show 13/4 as the norm. Same as every live V4 release. |
| **B. Platform-held approval role** | A platform address or Safe, set once in Factory V3 and granted on each clone | Introduces platform authority over every V5 artist contract, which reverses the "no owner, operator or platform signer" design | **Yes**: V5 (new role and gating) and Factory V3 (constructor parameter and grant) | Needs a platform key or Safe with custody and rotation. The deployer-key rotation (D5) is still BLOCKED on a Safe, so this adds the same dependency. Needs new tests, a re-review of the change and a new dry run. |
| **C. Remove lifting: hard caps** | Nobody: 13 tracks / 4 singles forever per V5 album | Simpler; less surface | **Yes**: small (remove or disable `approveExpandedRelease`) | Albums over 13 tracks must be split across releases. Irreversible for every V5 release. Needs tests, a re-review and a new dry run. |
| **D. Bounded artist lifting** | The artist, up to a fixed ceiling (e.g. 26/8), possibly only once | Unchanged: no platform signer | **Yes**: small (add a ceiling and a one-time flag) | Keeps artist autonomy with a hard platform limit. Needs tests, a re-review and a new dry run. |

**What any Solidity change (B, C or D) means:**
- The current review packet scope changes. The reviewer must also review that change, and the dry run must be repeated.
- The predicted addresses depend only on the deployer and nonce, not on the bytecode. They stay the same if the deployer sends nothing else first.

Option A needs none of this. A two-party (artist and platform) approval is possible but is the most complex choice and is not proposed.

**Owner decision (2026-10-11): Option A, keep as is.**
- Artists keep the ability to lift the album caps, with no upper limit, through `approveExpandedRelease` on their own release clone. This keeps the existing artist-controlled authorization model: the platform holds no role.
- **13 tracks and 4 singles are defaults, not hard maximums.** Studio, docs and metadata must describe them that way.
- No Solidity change is made for D2. V5 and Factory V3 stay as written in the review packet. Dry run 38149347518 stays valid for D2.

## 3. D5: deployer key before broadcast

**Facts:**
- The dry run confirms the deploy key is `0xaBd3…c174`. The same key is the "old authority" in [`DEPLOYER-AUTHORITY-ROTATION-PLAN.md`](./DEPLOYER-AUTHORITY-ROTATION-PLAN.md) (admin roles on legacy contracts). Its rotation is **BLOCKED** on a replacement Safe.
- Copies of the key exist in:
  - the GitHub secret `DEPLOYER_PRIVATE_KEY`, used by this workflow;
  - the env of the Render cron `crn-dat953e0tbcc73acrepg`. The rotation plan §12 says it is present "by inference"; the value was not read.
- On 2026-10-11 Render reports that cron as:
  - **suspended** (`suspenders: ["user"]`);
  - auto-deploy off;
  - command `npm run deploy:marketplace`;
  - schedule `0 0 1 1 *`.
- **Deploying V3 gives this key no new authority:**
  - Factory V3 has no owner or admin;
  - the V5 implementation can be initialized only by the factory;
  - the marketplace parameters are immutable.

  This is to be confirmed by the reviewer, packet question A3. The key's risk lies in its **existing** legacy roles, and in that a holder could send a transaction first and shift the predicted addresses. The broadcast checks pending nonces and verifies what was mined.

**Smallest safe step (recommended for the owner to do; Claude did not change it):**
1. In the Render dashboard, open the suspended cron `crn-dat953e0tbcc73acrepg` and **delete the environment variable that holds the private key**. Alternatively, delete the suspended cron service entirely; the rotation plan calls this M1.
   - An env change does not start a suspended cron (rotation plan §13).
   - The GitHub secret and the dry-run results are unaffected, so **no new dry run is needed**.
2. Leave the GitHub secret in place for the V3 broadcast, and keep the full legacy-role rotation (P0) as its own separate, still-blocked track.

**Larger alternatives (not required for V3):**
- **A fresh V3-only deployer key:** create a new EOA, fund it, replace the secret, and run a new dry run (the predicted addresses change). This gives a cleaner separation, but V3 holds no deployer authority anyway.
- **Complete the P0 rotation first:** blocked on a Safe and a backup admin. That would hold V3 back for reasons unrelated to it.

**Owner action taken (2026-10-11): the suspended cron was deleted** (the rotation plan's M1).

Verified by Claude, read-only:
- Render returns `404 not found` for `crn-dat953e0tbcc73acrepg`, and the workspace lists only `the-void-api-fuji` and `the-void-indexer-fuji`.
- The API's live deploy is still `dep-db5pmlflk1mc73aqq48g` (`2038366`), and the indexer's is still `dep-db5pqpmk1f9s73ek0d9g` (`48037a7`).
- The deployer's nonce is still 61 with nothing pending (Fuji block 59308527), so the key sent nothing.
- Before deletion, the Render API showed the cron **suspended** (`suspenders: ["user"]`; last updated 2026-10-10 20:21:54 UTC). Its last recorded deploy was `dep-db59rn142hec73873m00` (2026-10-10 20:19 UTC, trigger `service_resumed`).
- **Limit:** since deletion, Render returns 404 for the cron's logs and deploys, so its final logs cannot be read. The evidence that it sent nothing is its suspended state before deletion plus the unchanged deployer nonce, not its logs.

The GitHub secret `DEPLOYER_PRIVATE_KEY` is unchanged, so dry run 38149347518 stays valid. The legacy-role rotation (P0) remains a separate, blocked track.

## 4. Still outstanding, separate from these decisions

- **Owner-authorized lifecycle-endpoint check:** an owner-authorized call to `GET /api/studio/releases/:id/lifecycle-editions` that returns `complete: true`. It needs the owner's wallet session. Non-owner refusal is already verified live.
- **L5 protected-media certification on per-release (factory) contracts:**
  - grants and an entitlement refusal exist only on legacy shared contracts (2026-10-03/04);
  - none exist on a Factory V2 or V3 release yet.
- **Independent V5 delta review:** [`V5-DELTA-REVIEW-PACKET.md`](./V5-DELTA-REVIEW-PACKET.md), NOT STARTED.
