# VoidRelease1155V5 / Factory V3: independent delta review packet

**Status: NOT STARTED.** No independent review has taken place. This packet only prepares one. A review is recorded in §8 only after it actually happens, using the reviewer's own words and references.

**Gate:** a Factory V3 broadcast on Fuji needs this review, the D5 action (D2 is decided: Option A), and an explicit owner authorization ([`FUJI-V3-OWNER-DECISIONS.md`](./FUJI-V3-OWNER-DECISIONS.md)). A dry run already passed: [run 38149347518](https://github.com/VoidcallerOC/The-Void/actions/runs/38149347518).

## 1. Why the reviewer must be independent

Claude Code sessions wrote everything under review, along with the earlier "V3/V5 source audit":

| Commit | Date (UTC) | Author | Change |
|---|---|---|---|
| `1e95f5b` | 2026-10-10 | Claude session | V5 and Factory V3: provenance root recorded in the edition-creating transaction |
| `de77a64` | 2026-10-11 | Claude session | D3: `hasStandaloneEditions` and `StandaloneEditionsExist` (merged in PR #163) |

The repository's only collaborator is the owner, who merged these changes. So the reviewer must be **someone outside this project who did not write or merge V5**, for example an independent smart-contract auditor or a Solidity engineer the owner trusts.

Neither of these counts as the independent review:
- **A Claude session.** It is the same model family that wrote the code.
- **Automated tools such as Slither or Aderyn.** They can pre-screen, but they don't replace a reviewer.

## 2. Exact scope

- **Review head:** `main` at `48037a786ac14ede59c1b534dba72a82097fceae`.
- **Baseline:** the source of the deployed, live-proven Factory V2 / V4 pair, commit `3861d74835b3ed4c649b199a6fdee31b76ff492f`, from the record at `deployments/release-per-contract-fuji-0x3e4E…3aC8.json`.

| File | Status vs. baseline | Size |
|---|---|---|
| `contracts/VoidRelease1155V5.sol` | **new**; delta against `VoidRelease1155V4.sol` is +93 / −32 | 250 lines |
| `contracts/VoidReleaseFactoryV3.sol` | **new**; delta against `VoidReleaseFactoryV2.sol` is +39 / −38 | 138 lines |
| `contracts/VoidCollection1155.sol` (base) | unchanged since `3861d74` | — |
| `contracts/VoidPrimarySale.sol`, `contracts/ReleaseMarketplaceV3.sol` | unchanged since `3861d74`; a new marketplace instance is deployed, bound to Factory V3 | — |
| `test/VoidRelease1155V5.t.sol` | 26 tests | — |
| `scripts/deploy-release-factory-v3.mjs` (+ test) | deploy-time checks only; out of contract scope | — |

**Commands to reproduce:**
- `git diff --no-index contracts/VoidRelease1155V4.sol contracts/VoidRelease1155V5.sol`
- `git diff --no-index contracts/VoidReleaseFactoryV2.sol contracts/VoidReleaseFactoryV3.sol`
- `forge test --match-contract VoidRelease1155V5Test` (Foundry v1.3.1, as CI pins). The dry run passed 26/26.

Links point at the review head:
- V5: <https://github.com/VoidcallerOC/The-Void/blob/48037a786ac14ede59c1b534dba72a82097fceae/contracts/VoidRelease1155V5.sol>
- Factory V3: <https://github.com/VoidcallerOC/The-Void/blob/48037a786ac14ede59c1b534dba72a82097fceae/contracts/VoidReleaseFactoryV3.sol>

## 3. What changed (author's description, to be verified, not trusted)

**V5 compared with V4:**
1. **Provenance at creation.** Every edition-creating path takes a `bytes32 provenanceRoot` and records it atomically in `_createAnchoredEdition` (L225–241):
   - writes `provenanceRootOf`, `tokenIdForProvenanceRoot` and `_anchored`;
   - emits `ProvenanceAnchored`, with the same signature as `VoidProvenanceAnchor`;
   - rejects a zero root (`InvalidRoot`) and a root already used in this clone (`AlreadyAnchored`).
   - The clone is its own anchor (`isAnchored`, L221).
2. **The root-less V4 overloads always revert** (`ProvenanceRootRequired`, L107, L112).
3. **New external entry points:**
   - `createEdition(...,bytes32)` at L122 and `createEditionWithMintEnd(...,bytes32)` at L138. They call internal `_createEdition` directly, so V5 itself carries `onlyRole(ARTIST_ROLE) whenNotPaused`, the same gating as the base public wrapper.
   - `createAlbumTrack(...,bytes32)` at L183 is now explicitly `onlyRole(DEFAULT_ADMIN_ROLE) onlyRole(ARTIST_ROLE) whenNotPaused`. That matches V4's effective gating through `super.createEdition`.
4. **D3.** `hasStandaloneEditions` (L27) is set by both standalone paths. `createAlbum` (L158) reverts `StandaloneEditionsExist` once it is set. Album-first releases are unaffected.
5. **`IMPLEMENTATION_VERSION = 5`.**

**Unchanged from V4:** `initializeRelease` (L79), disabled `initialize`/`transferOwnership`, `tokenIdFor`, `approveExpandedRelease` (L167), `closeAlbum` (L211), the album caps of 13 tracks and 4 singles, mint-end and royalty rules.

**Factory V3 compared with V2:**
- Deploys a V5 implementation in its constructor.
- No longer deploys a separate `VoidProvenanceAnchor`; `provenanceAnchor = releaseContract`.
- `RELEASE_VERSION = 3`.
- Same release-key derivation (`"the-void:studio-release:v2"`, chainid, factory, appId, artist).
- Same `ReleaseCreated` signature.
- Same sealed 250 bps fee and immutable `platformRecipient`.
- Still no owner or admin.

## 4. Questions the reviewer must answer

**A. Authorization and initialization**
1. Can anyone other than the factory initialize a clone, or the bare implementation? `VoidCollection1155.initialize` requires `msg.sender == factory`, and `factory` is `immutable` from the implementation's constructor. Confirm that clones read the same immutable through delegatecall, and that the implementation can never be initialized by an outsider.
2. Is every edition-creating path gated at least as strictly as V4: ARTIST role, admin role for album tracks, and the pause check? Can any path skip `_assertReleaseKey`?
3. Does anything give the platform, the factory or the deployer a role on a clone after initialization? The design says none.

**B. Album and single rules (D1/D3)**
4. Can a contract with any standalone edition still reach album mode, through any overload, reentrancy or ordering? Is `hasStandaloneEditions` set on every successful standalone path and on no album path?
5. Are the track and single caps (L197–203) enforced on every album-track path? Can `albumTrackCount` or `albumSingleCount` drift from what was actually minted?
6. Mint-end: `_assertValidMintEnd` rejects past deadlines. Is there any path that sets a deadline without that check?

**C. Lifting the caps (D2)**
7. `approveExpandedRelease` (L167–180) is `DEFAULT_ADMIN_ROLE`, which the **artist** holds. It has no upper bound and can be called more than once until `closeAlbum`. The owner decided D2 = Option A (2026-10-11): this is intended, and 13 / 4 are defaults, not hard maximums. Please confirm the behaviour matches that intent, and report any risk beyond "the caps are the artist's choice".

**D. Provenance**
8. Is the root recorded in the same transaction as the edition, with no path that creates an edition without a root?
9. `AlreadyAnchored` is per clone. The same root in another release is allowed by design. Any collision or griefing concern within one clone?
10. Does the `ProvenanceAnchored` signature exactly match `VoidProvenanceAnchor`, so existing off-chain decoders stay correct?

**E. Factory and compatibility**
11. Is the release key still bound to the factory address, chain ID, application ID and artist? Can a key prepared for Factory V2 be replayed on V3?
12. Is `ReleaseCreated` ABI-identical to V2, with `provenanceAnchor == releaseContract` and `version == 3`? The indexer and Studio rely on this.
13. Does deploying V3 change anything about existing Factory V2 contracts, clones, sales or the existing `ReleaseMarketplaceV3` at `0xa464…C898`? The expected answer is no.
14. Does the new `ReleaseMarketplaceV3` instance accept only Factory V3 releases (`registry.isRelease`)? Any cross-factory trading risk?

**F. Irreversible behavior** (nothing can be changed after broadcast)
15. List everything fixed forever at deployment:
    - fee 250 bps;
    - `platformRecipient` `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`;
    - the implementation bytecode;
    - the caps policy;
    - the D3 rule;
    - pause and admin powers held by artists.

    Is anything here a mistake that would force a Factory V4?
16. Any denial-of-service or stuck-state risk? For example:
    - an artist who renounces `DEFAULT_ADMIN_ROLE`;
    - a paused release;
    - `closeAlbum` called before any track.

## 5. Context the reviewer needs (operational, not contract scope)

- **Provisioning (Studio fix 7a, merged in PR #164).** A release prepared on a factory is always created and verified on that factory. Two Factory V2 requests are PENDING. They were never sent and are not on-chain, so they will complete on V2 even after activation.
- **Deployment.** The dry run on 2026-10-11 reported:
  - deployer `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, nonce 61, nothing pending;
  - predicted Factory V3 `0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338`;
  - predicted marketplace `0x717cf06380e36176728e351f4dabC48cF5ef3158`.

  The deployer keeps **no** authority over V3 contracts. The factory is ownerless, the implementation is locked to the factory, and the marketplace parameters are immutable. Please confirm this.
- **The V4 limitation stays.** Deployed V4 clones still allow a direct-wallet `createAlbum` after standalone editions. Only V5 enforces D3 on-chain.

## 6. How to report

For each finding give:
- **severity:** Critical, High, Medium, Low or Informational;
- **file and line(s)** at `48037a7`;
- **a concrete scenario:** who, what call, what goes wrong;
- **a suggested fix**, if any.

Also say explicitly whether you found **no issues** in a category, and what you did **not** review. Send the report to the owner in writing (a GitHub issue, a PR review on a docs PR, or a document). Claude will fix confirmed findings only in a separate PR with tests, and the changed code then needs your re-review.

## 7. Out of scope

- Mainnet (NO-GO).
- Legacy shared contracts and the deployer-key rotation (`DEPLOYER-AUTHORITY-ROTATION-PLAN.md`).
- Studio UI and indexer code, apart from compatibility question 12.
- The separate `createRelease` release-ID reassignment issue in the API.

## 8. Review record

| Field | Value |
|---|---|
| Reviewer | — (not yet assigned) |
| Independence statement | — |
| Commit reviewed | — |
| Date | — |
| Findings | — |
| Outcome | **NOT STARTED** |
