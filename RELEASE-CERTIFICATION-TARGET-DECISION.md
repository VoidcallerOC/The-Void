# Release Certification Target — V3/V5 Preflight and Decision Record — 2026-10-11

**Mode:** read-only. No transaction was signed or sent. No workflow was dispatched. No configuration, environment variable or code was changed.
**Network:** Avalanche Fuji 43113 only. C-Chain remains **NO-GO** ([`LAUNCH-GATE.md`](./LAUNCH-GATE.md)).
**Ledger:** [`SYSTEM-CHAIN-CERTIFICATION.md`](./SYSTEM-CHAIN-CERTIFICATION.md). This file feeds §5 items 5 and 6 of that ledger. It moves no certification row.

---

## 1. Established history (not re-done)

The album-capable V2/V4 pair was broadcast on 2026-10-10 in run [38054831224](https://github.com/VoidcallerOC/The-Void/actions/runs/38054831224). The record is `deployments/release-per-contract-fuji-0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8.json`.

| Contract | Address |
|---|---|
| `VoidReleaseFactoryV2` | `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8` |
| Implementation (`VoidRelease1155V4`) | `0x45c3FFBb3C0Db3a8C87453d4612c9B3b6392E452` |
| `ReleaseMarketplaceV3` | `0xa464edb22C4959943334DB07001e3ba63989C898` |

## 2. Fresh runtime reads (2026-10-11)

| Check | Result | Tier |
|---|---|---|
| `scripts/fuji-release-capability-probe.mjs`, 02:14Z, tip 59288557 | `releaseCount = 2`; `albumCreated() = false` on both clones; `implementationMatchesConfig = true`; `v3ParityOnChain = true` | 2 |
| `/api/indexer/health`, about 02:23Z | 2 `RELEASE_FACTORY` (`0x3e4E…`, `0xa5Cb…`), 2 `MARKETPLACE` (`0xa464…`, `0x42b7…`), 4 clones, 5 sales. Lag 14. `last_error: null`. `database_failures: 137`, unchanged since 02:00Z. | 5 |
| Vercel production deployment | `dpl_2AbJ1UuH…` at `b854797` (`main` HEAD, includes `1e95f5b`) | 5 |
| Render API and indexer deploy SHA | **UNVERIFIED.** The Render tool requires a workspace choice by the owner. | — |
| CI `build-and-test` on `7e66f7b` (contracts identical to `main`) | success. This includes `forge test` over every suite, `VoidRelease1155V5.t.sol` among them. | source/test only |

The live indexer already runs **two factories and two marketplaces side by side**. So multi-factory operation is proven in production, but only for factories that are both `releaseVersion 2`.

## 3. V3/V5 preflight (source-level; nothing live)

| # | Question | Finding | Severity |
|---|---|---|---|
| 1 | Is V3/V5 the intended implementation on `main`? | Yes. `1e95f5b` is the latest contract commit, and no newer contract exists. `docs/PROVENANCE-AT-PUBLICATION.md` says "code prepared, NOT deployed". Activation is an open owner decision. | ok |
| 2 | Is the workflow ready, and does it default to a dry run? | `deploy-release-factory-v3-fuji.yml`: `broadcast_deployment` defaults to `false`. A broadcast also needs the typed confirmation `I_CONFIRM_FUJI_RELEASE_FACTORY_V3_DEPLOY`, `expected_deployer_address` equal to the key's address, and no pending nonce. Fuji is hard-coded and the chain ID is checked. The script deploys Factory V3, asserts the V5 selectors, `RELEASE_VERSION == 3` and fee 250, then deploys a **new `ReleaseMarketplaceV3` bound to Factory V3** and asserts `registry() == factory`. Even a dry run needs the secrets `AVALANCHE_FUJI_RPC_URL` and `DEPLOYER_PRIVATE_KEY`. | ok |
| 2b | Is the deployment record kept? | It is written on the runner and uploaded as a workflow **artifact only**. It is not committed, and `ACTIVATION_NOT_PERFORMED` is logged. Copy the record into `deployments/` before the artifact expires. | risk |
| 2c | Is there an approval gate? | The workflow has no `environment:` protection. The other deploy workflows do not have one either. | risk (minor) |
| 3 | What must change after deployment? | Edit **one file**, `config/fuji-release-per-contract-v2.json`. V3 becomes the top-level entry with `releaseVersion: 3`, and `0x3e4E…` moves to `historicalDeployments` unchanged. `config/release-network.js` and the indexer start blocks (`server/config.js`) derive from that file. Then redeploy Vercel, the Render API and the Render indexer from that commit. Update the pinned tests `src/lib/secondary-listing.test.js` and `src/lib/release-deployments.test.js`. `VITE_MARKETPLACE_ADDRESS` (currently `0x42b7…`) and Render `MARKETPLACE_ADDRESS` are not used for routing, so no change is required. | ok |
| 4 | Do the frontend, API and indexer support v2 and v3 together? | `ReleaseCreated` has the same signature in both factories, and the indexer splits them by `version`. The server branches on the binding's version. Studio passes the root only when the server says `provenanceAtCreation`. | ok (source) |
| 5 | Do historical V2 releases stay usable? | Yes in source: they are indexed from the manifest, resale is routed to each factory's own marketplace, earnings scan every factory, and the V2 two-step anchor is unchanged. Live: **UNVERIFIED** until after activation. | ok (source) |
| 6 | Do the provenance paths agree from root to indexer? | The root is computed only on the server (canonical, SHA-256) and reaches the client as `provenanceRootBytes32`. Selectors: `createEdition(...,bytes32)` is `0xdf719fb5` with the root at arg 6; `createAlbumTrack(...,bytes32)` is `0x88e80676` with the root at arg 8. Both match V5. Server receipt checks require the emitter to equal the clone, plus matching root, IDs, `tokenId`, `isAnchored` and `provenanceRootOf`. The indexer's `ProvenanceAnchored` topic is byte-identical to Solidity. Double anchoring is refused for v3 on both the server and the client. 61/61 vitest tests pass locally across the 7 V3/provenance suites. | ok (source) |
| 7a | **Studio release creation always targets the active factory** | In `src/lib/fuji-release.js`, `submitArtistReleaseCreation` and `verifyArtistReleaseCreation` read the active config's factory and version. The server (`provisioningFactoryFor`, `server/studio-service.js`) keeps a release with an existing provisioning request on its recorded factory. After activation, any PENDING or SUBMITTED V2 request would fail. It fails closed (the simulation reverts, or verification throws), so no funds are lost, but the release cannot be finished from Studio. | **risk: must fix or drain before activation** |
| 7b | What if the root drifts after the v3 tx? | If metadata is re-published with different inputs after the edition tx is mined, confirmation fails with `PROVENANCE_ROOT_MISMATCH`. The edition is immutable and v3 refuses a separate anchor, so there is no recovery. V4 has the same failure mode for URI drift. | risk (pre-existing class) |
| 7c | Are V2 anchor-contract events indexed? | No. The indexer decodes `ProvenanceAnchored` only from release clones, so v2 anchoring is proven by the route-level receipt check alone. This does not get worse with V3; V3 removes it for new releases. | risk (pre-existing) |
| 7d | Is there a mainnet fee mismatch? | `config/mainnet-release.json` says 500 bps, but Factory V3 seals 250. Not in Fuji scope. | open (owner, mainnet) |
| 7e | Copy | Studio errors still say "Factory V2". | cosmetic |

None of these makes a **deployment** of Factory V3 + its marketplace unsafe. A deployment changes no runtime path until the separate activation commit. Item 7a blocks **activation**.

## 4. Single vs album semantics (D1)

There are **three** meanings of "single" in the code, not two:

| ID | Meaning | Chain | API / DB | Public UI |
|---|---|---|---|---|
| S1 | Standalone SINGLE release | Plain `createEdition` on its own clone. The chain does not know the label. | `release_metadata.releaseType = "SINGLE"` (user input, locked after first publish, limited to one edition) | Not shown. The catalog maps `releaseType`, but no component renders it. |
| S2 | Album track flagged single | `createAlbumTrack(..., single = true, mintEnd)`; `isAlbumSingle`; cap of 4 (`DEFAULT_ALBUM_MAX_SINGLES`); `AlbumTrackCreated(uint256 indexed, bool indexed, uint64)` | Indexed into `release_album_tracks.is_single`; `/api/editions` returns `isAlbumSingle` | Not shown |
| S3 | Linked single | None (off-chain only) | `release_album_singles` (migration 038); `/api/releases/:id` `albumSingles` / `appearsOnAlbums`; no cap | Not shown |

**Intentional:** yes. `src/lib/release-types.js` and migration 038 say so.
**Consistent:** no. These are the gaps:

1. `releaseType` is never checked against the chain. A SINGLE clone can still have `createAlbum` called on it from the artist wallet.
2. `createAlbum` does not refuse a clone that already has standalone editions (D3), so those editions do not count toward the caps.
3. `isAlbumSingle` (S2) and `albumSingles` (S3) have nearly the same names but mean different things.
4. No type, flag, link or `mintEnd` is shown in the public UI. Path C1 ("discoverable as a single") fails at the **UI** layer.
5. Token metadata for S2 says "ALBUM" with no single trait.
6. The UI does not know about `mintEnd`, so a track whose window has closed can still look buyable until the purchase simulation reverts.

**Outdated records corrected:** in [`ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md`](./ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md), D1 says there is no standalone SINGLE type, but `be130b2` added one. C1 says the indexer does not decode `AlbumTrackCreated`, but `7be7a4c` added that decoding. Both rows now point here.

**Options (owner decision):**

- **A (recommended): keep all three, with distinct labels.** "Single" for S1, "Album single" for S2, "Also on *[album]*" for S3. Nothing existing changes: the `forgive-forget-28` fixture, the stored rows and the deployed V4 behaviour stay as they are. Work is UI and labelling only: map the album fields in `catalog-source.js`, render the labels, and add a single trait to S2 metadata.
- B: SINGLE means S2 only. This redefines the certified fixture and the existing rows, and needs a migration. Not advised.
- C: SINGLE means S1 only, and S2 is shown as a "featured track". The on-chain cap is still named "singles", so the labels conflict.
- D: merge S2 and S3 in the UI. This needs a combined cap policy and an ordering source for S2.

D2 (the artist alone can lift the caps through `approveExpandedRelease`) is still an open owner decision.

## 4a. D3: a standalone release contract never becomes an album

**Status:** the owner authorized Option A for implementation on 2026-10-11. The change is in a PR pending review. It is not merged and not deployed.

**Invariant.** A release contract is standalone (editions created with `createEdition`) or an album (tracks created with `createAlbumTrack`) for its whole life. Album-first was already enforced: `createEdition` reverts `AlbumTrackPathRequired` once the album exists. D3 closes the other direction.

Three things must never be confused:

| Case | Allowed? | How |
|---|---|---|
| 1. Converting an existing single or EP release contract into an album | **No** | V5 `createAlbum` reverts `StandaloneEditionsExist`. The earlier editions stay standalone and mintable, unchanged. |
| 2. Creating a new album that includes previously released music | **Yes** | A new release contract (`createRelease`, then `createAlbum`). An already published single can also be linked to the album off-chain (`release_album_singles`). |
| 3. Reusing the same recording across independent releases | **Yes** | Each release contract stores its own provenance roots, and the roots commit to `releaseId` and `editionId`. Each release mints its own collectible editions. |

**Enforcement by version:**

| Version | Enforcement | Strength |
|---|---|---|
| V5 (Factory V3, not deployed) | `bool public hasStandaloneEditions` is set by both standalone entry points. `createAlbum` reverts `StandaloneEditionsExist` when it is true. A refused call changes no state. The deploy script refuses a compiled artifact without the `hasStandaloneEditions()` selector or the `StandaloneEditionsExist` error, and a mined implementation without the selector. Those checks prove only that the **interface is present**, not that `createAlbum` behaves correctly. The optimizer does not keep that error's selector as a literal in runtime bytecode, so the error is checked in the artifact ABI only. The behavioural proof is acceptance row **B4b** on-chain. | On-chain, for every caller |
| V4 and older (deployed, immutable) | The server refuses a type change to ALBUM when the bound contract has an edition on-chain, even while the database says DRAFT. It locks a release whose album is active on-chain. Studio re-reads the chain before `createAlbum`. Both look up editions by the **token IDs stored when each edition was prepared**, never by IDs re-derived from an editable title. Both take the getters a contract must have from trusted deployment metadata. For every version, V5 included, the binding's factory must be a recorded release deployment whose version matches the binding's factory-event version. A version number alone never vouches for a contract, so a Factory V3 release is recognised only once activation records that factory in the manifest. A release contract from the pre-album factory can never switch to ALBUM: the server refuses with `ALBUM_NOT_SUPPORTED` before reading the chain, and Studio refuses activation. A failed, rate-limited or empty read is therefore never taken as a missing getter. Both refuse (the server with a 503) when the chain cannot be read or the deployment is not recognised. | **Application-level only.** The artist holds `DEFAULT_ADMIN_ROLE` and can still call `createAlbum` directly from a wallet. |

**Before broadcast:** V5 changed after the V3/V5 source audit, so a focused delta review of `VoidRelease1155V5.sol` is required. Acceptance row B4b below covers the on-chain check.

## 5. Recommendation: **B. Deploy V3/V5 first, then certify on it.**

**Why:**

1. **Album acceptance has not started on V2/V4.** No album exists on the deployed factory. Certifying V2/V4 now means running every Path B and C row and then running them again on V3/V5, because every edition-creating selector changes (`createEdition` and `createAlbumTrack` gain a `bytes32` root). The V2/V4 album work would certify a path that no new release uses once V3 is active.
2. **The incremental risk of V3/V5 is narrow.** Album logic, events, caps and the sale and marketplace contracts are unchanged. The difference is provenance at creation. The source agrees end to end, CI passes the full Foundry and Node suites, and multi-factory operation is already proven live with two factories.
3. **Deployment and activation are separable.** The broadcast adds a factory and a marketplace and changes nothing live. Activation is one config commit plus redeploys, and it is gated on 7a.
4. **The work done for V2 Path A still counts.** Its L2–L4 receipts stay valid as evidence that historical V2 releases keep working (§3 row 5). L5, a third-party resale and the L1 UI record were never done on any version, so they cost the same either way.

**Why not A:** A only wins if V3/V5 has a material unresolved risk. The one material finding (7a) is a small, closed-failing frontend fix, or an operational drain of pending V2 provisioning requests, and it applies at activation, not deployment.

**Sequence (each step needs the owner's explicit authorization where marked):**

| Step | Action | Authorization |
|---|---|---|
| 1 | Decide D1: Option A | Owner |
| 2 | Fix 7a: Studio uses the provisioning payload's factory and version. Add a test. | Owner approves the code PR |
| 3 | Dispatch `deploy-release-factory-v3-fuji.yml` as a **dry run** and review the plan | Owner (it uses deploy secrets) |
| 4 | Broadcast | **Owner, explicit** |
| 5 | Commit the deployment record; activation PR (one config file + pinned tests); confirm no PENDING/SUBMITTED V2 provisioning requests | Owner approves the PR |
| 6 | Redeploy Vercel, Render API and Render indexer from the activation commit; record the SHAs | Owner |
| 7 | One certification run per §6 of the ledger, on V3/V5, with the acceptance matrix below | Operator + Claude (evidence) |

## 6. Acceptance matrix (separate from deployment)

A deployed contract or a green test run moves **none** of these rows.

| Row | Requirement | Evidence required | Status |
|---|---|---|---|
| B1 | Album created | `AlbumCreated` receipt from the clone; `albumCreated() = true` | NOT STARTED |
| B2 | Tracks created | `AlbumTrackCreated` receipt per track (`tokenId`, `single`, `mintEnd`) | NOT STARTED |
| B3 | Track cap (13) and single cap (4) | 14th track / 5th single reverts (`eth_call`) | NOT STARTED |
| B4 | Standalone path blocked on an album | `createEdition` reverts `AlbumTrackPathRequired` | NOT STARTED |
| B4b | A standalone release never becomes an album (D3) | On a V5 release with a standalone edition, `createAlbum` reverts `StandaloneEditionsExist` (`eth_call`). `hasStandaloneEditions() = true`. The edition still sells afterwards. | NOT STARTED |
| B5 | Mint deadline | Purchase after `mintEnd` reverts `MintingEnded`; purchase before succeeds | NOT STARTED |
| B6 | Album closing | `AlbumClosed` receipt; further `createAlbumTrack` reverts | NOT STARTED |
| B7 | Purchase and collector ownership | `Purchased` + `TransferSingle` to collector A (≠ artist); API ownership read | NOT STARTED |
| B8 | Third-party resale and settlement | `ListingSold` on the factory's own V3 marketplace, A → B (B ≠ artist, ≠ A); royalty and fee amounts | NOT STARTED |
| B9 | Provenance for the selected version | v3: `ProvenanceAnchored` from the clone in the **same** tx as each edition/track; `isAnchored` and `provenanceRootOf` equal the stored root | NOT STARTED |
| B10 | Indexer/API consistency | `/api/editions` `isAlbumSingle`, `mintEnd`, `albumClosed` equal chain state, with a timestamp | NOT STARTED |
| B11 | Production Studio behaviour | Each tx linked to a UI session record (ledger A9 rule) | NOT STARTED |
| C1 | Single discoverable as a single | Depends on D1. With Option A: the public UI shows the S1/S2/S3 labels from API data | NOT STARTED (UI not implemented) |
| C2 | Single mint window and purchase | B5 + B7 on an S2 track | NOT STARTED |
| L5 | Protected media | Owner grant; non-owner and anonymous get 403; access moves on resale | NOT STARTED |
| P0 | Public masters in `refs/pull/*` | GitHub Support purge, or a private repo | OPEN |

## 7. Not verified here

- The Render API and indexer deploy SHAs, and whether they include `1e95f5b`.
- That historical V2 sale, listing and withdraw still work on-chain after activation. They can't be tested until activation.
- Whether any undeclared V3 deployment exists on-chain.
- Whether any PENDING or SUBMITTED V2 provisioning requests exist; this needs a database read.
- The cause of `database_failures: 137`.
