# Provenance at publication (Factory V3 / VoidRelease1155V5)

Owner decision, 2026-10-10: publishing an edition records its provenance root on-chain in the
same transaction, with one artist signature and no separate anchor step.

Status: **code prepared, NOT deployed.** No contract was deployed, no Safe transaction was made,
and no config was switched. Everything below the "Fuji rehearsal" heading needs explicit owner
authorization before it runs.

## What changes

| | Factory V2 (live on Fuji) | Factory V3 (this change) |
|---|---|---|
| Release clone | `VoidRelease1155V4` | `VoidRelease1155V5` |
| Provenance anchor | separate `VoidProvenanceAnchor` per release | the release clone itself |
| Artist transactions to publish + anchor | 2 (`createEdition…`, then `anchor`) | 1 |
| `ReleaseCreated.version` | 2 | 3 |
| `ReleaseCreated.provenanceAnchor` | anchor contract | equals `releaseContract` |
| Release key | `keccak256("the-void:studio-release:v2", chainId, factory, appReleaseId, artist)` | same |
| Primary fee | 250 bps, sealed in the factory | same |

`VoidRelease1155V5` entry points that create editions all take `bytes32 provenanceRoot`:

- `createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps, provenanceRoot)`
- `createEditionWithMintEnd(…, mintEnd, provenanceRoot)`
- `createAlbumTrack(…, single, mintEnd, provenanceRoot)`

The root-less `createEdition` overloads revert with `ProvenanceRootRequired()`, so a V5 edition
cannot exist without a root. In the same call the clone:

- rejects a zero root (`InvalidRoot()`) and a root already used by another edition of the release
  (`AlreadyAnchored(root)`);
- stores `provenanceRootOf[tokenId]` and `tokenIdForProvenanceRoot[root]`;
- emits `ProvenanceAnchored(root, releaseId, editionId, tokenId, artist, releaseContract)`. This is the
  same signature as `VoidProvenanceAnchor`'s event. `artist` is `msg.sender`, the attester of record;
- answers `isAnchored(releaseId, editionId, root)` the same way as the old anchor.

Every V4 rule is unchanged: artist-only creation, the sale is the only issuer, no ownership
transfer, the album create/close/limit rules, the single flag, mint end, the 10% royalty cap,
open editions (`maxSupply` 0), pause. The platform has no role or signer.
`test/VoidRelease1155V5.t.sol` covers each of these rules.

A root is a timestamped commitment to the provenance manifest. It does not register copyright.

## App behaviour

- `publishMetadata` returns `provenanceAtCreation` and, for V3 bindings, `provenanceRootBytes32`.
- Studio `publishEdition` passes that root into the V5 call and checks the receipt for the
  release contract's `ProvenanceAnchored` event.
- `confirmPublication` (V3 bindings): the receipt must contain `ProvenanceAnchored` from the bound
  release contract for this edition's canonical root, release key, edition id, token id, and the
  artist who created the edition. The contract must also return `isAnchored == true` and
  `provenanceRootOf(tokenId) == root`. If any of these is missing or different, confirmation fails
  with `PROVENANCE_ROOT_NOT_ANCHORED`, `PROVENANCE_ROOT_MISMATCH` or `PROVENANCE_STATE_UNAVAILABLE`,
  and the release stays unpublished.
- V2 bindings are unchanged. They return `separateAnchorAvailable: true`.
- Indexer: `ProvenanceAnchored` from tracked release clones is recorded in `blockchain_events`. A log
  whose `releaseContract` differs from its emitter is recorded as malformed. Registration names V3 clones
  `VoidRelease1155V5`.
- Binding and provisioning accept the factory version recorded in the deployment manifest
  (2 for the historical factories, 3 for V3), not a hard-coded 2.

### One-time anchor for already-published V2 editions

Editions published on V2 factories were verified by the `EditionCreated` metadata CID. Their
root was never written to the release's `VoidProvenanceAnchor`. Example on Fuji:
`forgive-forget` on `0x4b2790791E2Ac123Cb012D33CC8F1ECbdc9b9bB0`, tx `0x0b62e365…c145`, root
`72e39f2f…2e20`, `isAnchored == false` on `0x9db020De…0429`.

The existing `/studio/releases/:id/provenance/anchor/{prepare,submit,confirm}` routes now:

- accept an optional `editionId`;
- treat the anchor contract's `isAnchored` as the source of truth when the proof was verified by
  `EditionCreated`, and offer the `anchor(...)` calldata (`oneTimeAnchor: true`) until it is recorded;
- verify the anchor transaction with the same strict checks (target, signer, calldata, event, block,
  contract state). They never rewrite the publication proof, and they append a
  `STUDIO_PROVENANCE_ANCHORED` audit event;
- refuse V3 releases with `PROVENANCE_ANCHORED_AT_PUBLICATION`.

Studio's sale step shows "Record provenance on-chain" for a published edition until it is anchored.

## Fuji rehearsal (requires owner authorization at each gate)

Gate 0: owner approval of this PR's contracts and the plan below.

1. **Dry run.** Run the `Deploy release Factory V3 (provenance at publication) to Fuji` workflow with
   `broadcast_deployment=false`. Evidence: the workflow log shows `mode: DRY_RUN`, `broadcasted=false`,
   the predicted factory/marketplace addresses, and passing `VoidRelease1155V5Test` and script tests.
2. **Broadcast (gate 1, owner).** Re-run with `broadcast_deployment=true`,
   `confirm_fuji_deploy=I_CONFIRM_FUJI_RELEASE_FACTORY_V3_DEPLOY`, and
   `expected_deployer_address=<reviewed deployer>`. The script deploys `VoidReleaseFactoryV3` and then a
   `ReleaseMarketplaceV3` bound to it. It refuses to deploy the marketplace unless the mined
   implementation has every V5 selector and `RELEASE_VERSION == 3` and `PLATFORM_FEE_BPS == 250`.
   Evidence: the uploaded record `deployments/release-factory-v3-fuji-<factory>.json` and the
   `ACTIVATION_NOT_PERFORMED` log line with the proposed manifest entry.
3. **Read-only verification.** On Snowtrace or by RPC: `factory.implementation()`,
   `RELEASE_VERSION() == 3`, `IMPLEMENTATION_VERSION() == 5` on the implementation, and
   `marketplace.registry() == factory`. Verify the source on Snowtrace.
4. **Activation (gate 2, owner).** This is a separate PR that edits `config/fuji-release-per-contract-v2.json`.
   It makes V3 the top-level active deployment (`factoryAddress`, `implementationAddress`,
   `marketplaceAddress`, both deployment blocks, `source: "VoidReleaseFactoryV3"`, `releaseVersion: 3`,
   `record`). It moves the current active `0x3e4E0d91…3aC8` entry, unchanged, into
   `historicalDeployments` with `releaseVersion: 2, albumCapable: true`, next to `0xa5CbA0F9…3505`.
   No address of either historical factory changes.
5. **Rehearsal, one wallet signature each:**
   - SINGLE: create a release, publish one edition. Evidence: one tx with `EditionCreated` and
     `ProvenanceAnchored` from the clone, `isAnchored == true`, Studio shows "recorded in the publishing
     transaction", and confirmation returns `fullyPublished: true`.
   - EP: two editions on one release. Expected: two txs, two distinct roots.
   - ALBUM: `createAlbum`, then one track and one single via `createAlbumTrack`. Expected: each track tx
     carries its root, and the single flag and mint end are stored.
   - Open edition (`maxSupply` 0) with a sale end time.
   - Negative case: change the root in a hand-built call. Expected: `confirmPublication` refuses and the
     release stays unpublished.
6. **Old factories still work:** on an existing V2 release, publish a new edition (two-step path),
   then use "Record provenance on-chain" for `forgive-forget`. Evidence: `isAnchored == true` on
   `0x9db020De…0429` for root `72e39f2f…2e20`, plus the tx hash.
7. **Indexer:** the V3 factory and marketplace are picked up from the manifest, and
   `ProvenanceAnchored` rows appear in `blockchain_events` for the rehearsal clones.

## Mainnet

`config/mainnet-release.json` is `deployed: false`. `scripts/deploy-release-factory-v3.mjs` supports
`DEPLOY_NETWORK=mainnet`. A mainnet run needs `CONFIRM_MAINNET_DEPLOY=yes`, owner-named
`RELEASE_PLATFORM_RECIPIENT` and `RELEASE_MARKETPLACE_FEE_RECIPIENT` (there is no default), and
`EXPECTED_DEPLOYER_ADDRESS`. No mainnet workflow is added here.

Open owner decisions before mainnet:

- `config/mainnet-release.json` records `platformFeeBps: 500`. Factory V3 seals the primary fee at
  **250** bps in bytecode, like Factory V2. Confirm 250 for mainnet, or the contract needs a change.
- `scripts/deploy-release-v2-mainnet.mjs` and its workflow still deploy the legacy shared
  `VoidRelease1155V2` architecture. If the mainnet launch uses Factory V3, retire them.
