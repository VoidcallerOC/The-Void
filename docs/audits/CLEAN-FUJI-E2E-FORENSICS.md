# The Void — Clean Fuji E2E Forensics

**Scope:** First-pass, read-only determination of the clean end-to-end path from an empty Pinata account to a collector-owned, gated-content release.

**Date:** 2026-10-04

## STATUS

**PARTIAL — forensics complete; execution intentionally not started.**

The implementation path is sufficiently identified to begin a fresh E2E run, but this pass did not execute the flow. No application code, contracts, checkpoints, Render configuration, database lifecycle state, deployment, withdrawn release, or historical Pinata asset was changed.

## CURRENT STATE

- **Pinata public storage:** intentionally empty.
- **Pinata private storage:** intentionally empty.
- **Withdrawn releases:** intentionally remain withdrawn and are not valid fixtures. In particular, `forgive-forget-23` must remain excluded by `WITHDRAWN_PUBLIC_LISTING_IDS`.
- **Historical Pinata assets:** not restored.
- **Fuji contracts:** current certified ERC-1155 deployment and current primary-sale deployment are treated as valid according to the prior audit; this clean test must use the current configured addresses, not old deployments.
- **Database:** published release records exist, but they are not assumed to be valid clean-room fixtures. Existing records must not be reused as the new test's identity unless the test explicitly creates a new release and edition.
- **Indexer/API:** existing state may contain stale or unrelated catalog data. The fresh fixture must be identified by its newly generated release/edition IDs and verified through the live API after indexing.

## CLEAN E2E ENTRY POINT

The exact first Studio action is:

1. Open **Artist Studio**.
2. Connect the artist wallet through the existing wallet flow.
3. Authenticate that wallet with the API.
4. Create/select an artist profile owned by that wallet.
5. Start a **new release/track workflow**, rather than selecting or editing an existing withdrawn, archived, or seeded release.

The clean fixture must receive a new release title/slug and a new edition title/slug. Do not use `forgive-forget-23`, any old release ID, any old edition ID, or a prior token ID.

## REQUIRED ASSETS

A fresh publish requires all of the following:

### 1. Public artwork

Upload release/track artwork through the Studio artwork path. It is stored as a public site/metadata asset and its resulting URI is placed into the generated token metadata. The public artwork must be available to the metadata storage path before publication.

### 2. Public preview audio

Upload a short, vetted public preview through the Studio audio-preview path. The resulting URI is included in immutable token metadata as the public preview (`animation_url`/preview audio path, depending on generated metadata). The UI refuses publication without this preview.

### 3. Private full track or protected experience audio

Upload the full track or experience audio through the protected-media flow. With direct upload enabled, the flow is:

1. Request a short-lived private upload URL.
2. Upload to private Pinata storage.
3. Register the returned file ID or CID with the server.
4. Server verifies the server-issued upload ID, private network, media type, size, CID, and SHA-256 bytes.
5. Server persists a `media_assets` row.

The exact file used as the holder unlock must not also be the public preview. The server rejects a protected upload whose SHA-256 matches a public preview.

### 4. Release/edition metadata inputs

Before metadata publication, provide:

- release title and description;
- track/edition title and description;
- artwork URI;
- public preview URI;
- includes/credits as applicable;
- supply or open-edition settings;
- sale price and supply settings for the later primary sale;
- experience title/description and protected media reference.

## PINATA AND CID PERSISTENCE

The clean run must create new CIDs/URIs; no old CID is required.

- Public artwork/preview URI is incorporated into generated immutable token metadata and written through the configured metadata storage.
- The generated metadata URI is persisted on the token row as `metadata_uri`.
- Private media is uploaded to private storage and registered as a `media_assets` row with `storage_key` equal to the verified private object reference, media type, content SHA-256, and byte size.
- The experience `media_config.protectedMedia` references the persisted media asset by `assetId` (and media type/content type), not a legacy file.
- The public API sanitizes protected media configuration, storage keys, and CIDs; those must not appear in public catalog responses.

## REQUIRED DATABASE PERSISTENCE

The fresh run must establish these relationships:

1. **Artist ownership** — `artists` joined to an `artist_owners` row for the authenticated artist wallet.
2. **Release** — a new `releases` row owned by that artist, initially draft, then `PUBLISHED` only after publication confirmation.
3. **Edition** — a new `editions` row linked to the release, with the intended supply, title, metadata/application metadata, and published status after confirmation.
4. **Token** — a `tokens` row linked to the edition and the current certified Fuji contract, with the newly derived token ID and metadata URI.
5. **Media asset** — a `media_assets` row linked to the artist, with the verified private storage key, media type, SHA-256, and byte size.
6. **Experience** — an `experiences` row linked to the edition, marked protected and referencing the private media asset.
7. **Publication proof/audit** — metadata publication and on-chain publication confirmation audit/provenance records, where configured.
8. **Primary-sale configuration** — on-chain sale state for the new token; database/API sale projection must resolve to that token and current sale contract.
9. **Purchase/ownership projections** — after collector purchase, purchase transaction and ownership/indexer records must identify the new chain, current contract, new token ID, and collector wallet.
10. **Media grants/authorization** — after entitlement succeeds, a grant row and authorization/audit records must be created for the holder; denial records must be created for a non-holder.

## REQUIRED ON-CHAIN STATE

The artist wallet must be able to publish on the current certified Fuji contract:

- wallet is connected to the configured Fuji chain;
- wallet has the required `ARTIST_ROLE`;
- the new release/edition IDs are valid for the certified contract's bytes32 rules;
- the metadata URI is reachable and is the URI submitted to `createEdition`;
- `EditionCreated` is emitted by the current certified release contract for the expected release ID, edition ID, token ID, artist, supply, and metadata URI;
- the edition exists on-chain with the expected metadata URI and creator;
- publication confirmation succeeds and updates the release/edition to published;
- `VoidPrimarySale` is configured for the **new token ID**, with intended price, supply, wallet limit, start/end times, and paused state;
- a collector purchase/claim transaction succeeds through the current primary-sale contract;
- the resulting transfer/purchase events are indexed for the new token and collector wallet.

The UI deliberately simulates the exact edition and sale calls before broadcasting, then confirms receipts against the current contract. A successful wallet transaction alone is insufficient; the API publication confirmation must also pass.

## REQUIRED INDEXER STATE

The indexer must observe and persist the new fixture's current-contract events, including:

1. certified release-contract `EditionCreated`;
2. ERC-1155 mint/transfer for the new token;
3. primary-sale configuration for the new token;
4. collector purchase/payment and resulting transfer events;
5. ownership balance/state for the collector;
6. any purchase/transaction projection required by the API;
7. current contract identity and chain ID in all projections.

The clean run must not require checkpoint edits or checkpoint resets. The new fixture should be discovered by the existing current-contract indexer configuration and its normal progression. If the indexer does not discover the new events, stop and record the failure rather than modifying checkpoints during this phase.

## REQUIRED API STATE

### Artist/Studio endpoints

The browser path uses these API operations:

- `POST /api/auth/nonce`
- `POST /api/auth/verify`
- `POST /api/studio/artists`
- `POST /api/studio/artists/:artistId/releases`
- `POST /api/studio/artists/:artistId/artwork`
- `POST /api/studio/artists/:artistId/audio-preview`
- `POST /api/studio/artists/:artistId/media/upload-url`
- direct private Pinata upload
- `POST /api/studio/artists/:artistId/media/register`
- `POST /api/studio/releases/:releaseId/editions`
- `POST /api/studio/editions/:editionId/experiences`
- `POST /api/studio/releases/:releaseId/metadata`
- wallet transaction to the current certified Fuji release contract
- `POST /api/studio/releases/:releaseId/publication/confirm`
- wallet transaction to the current primary-sale contract

### Public catalog verification

After indexer completion, verify:

- `GET /api/releases/:newReleaseSlug` returns the fresh published release, not 404;
- `GET /api/releases` includes the fresh release when public listing filters are applied;
- `GET /api/editions/:editionId` returns the fresh published edition, current contract address, chain ID, token ID, and public metadata fields;
- public responses do **not** expose `storage_key`, protected media configuration, private CIDs, or private asset identifiers;
- the release is not filtered by withdrawn/archived/demo predicates.

### Purchase and ownership verification

Use the public listing/edition state to begin the collector flow, then verify the purchase endpoints:

- `POST /api/purchases/intents`
- collector submits the intended Fuji purchase transaction;
- `POST /api/purchases/submitted`
- `POST /api/purchases/verify`
- collector ownership/collector endpoints reflect confirmed ownership after indexing, including `GET /api/collectors/:wallet` where applicable.

### Gated-content verification

For the published experience:

- non-holder: `POST /api/media/grants` must fail with `EXPERIENCE_ENTITLEMENT_REQUIRED`;
- holder: `POST /api/media/grants` must return `state: CONFIRMED`, a grant ID, expiry, and `/api/media/:grantId` access URL;
- holder: `GET /api/media/:grantId` must return the private stream/signed object response;
- revoked grant: `GET /api/media/:grantId` must fail with `MEDIA_GRANT_REVOKED`;
- expired grant: must fail with `MEDIA_GRANT_EXPIRED` when naturally expired or test-configured accordingly;
- `POST /api/media/grants/revoke` must revoke the grant and produce authorization/audit records.

## EXACT CLEAN E2E SEQUENCE

1. **Prepare identities.** Use a fresh artist wallet/profile and a separate fresh collector wallet. Confirm both use the configured Fuji chain.
2. **Open Studio.** Connect and authenticate the artist wallet. Do not select a withdrawn, archived, seeded, or prior release.
3. **Create a new release.** Enter a new title/slug, description, artwork, and release settings. Save the draft so a new release row exists.
4. **Upload public artwork.** Confirm the upload succeeds and the returned public URI is populated in Studio.
5. **Upload public preview audio.** Confirm the preview URI is populated and is a different file from the full track.
6. **Upload private full track/experience audio.** Request the private URL, upload to empty private Pinata, register it, and confirm server-side hash/private-storage validation succeeds.
7. **Create the edition.** Save the track/edition draft with intended supply, price metadata, and artwork/preview metadata.
8. **Create the protected experience.** Associate the verified private `media_assets` asset with a protected experience. Confirm Studio reports that holders will unlock this asset.
9. **Publish metadata.** Invoke the Studio metadata action. Confirm a new metadata URI, digest/provenance values, and token ID are returned; verify the token row is persisted.
10. **Publish on Fuji.** Confirm the artist wallet has `ARTIST_ROLE`; simulate and submit `createEdition` to the current certified release contract; verify the `EditionCreated` event and on-chain edition; confirm publication through the API.
11. **Reload Studio.** Reload/navigate away and back. Confirm the new release remains selected/resumable, shows published state, token ID, metadata URI, and no stale old release identity.
12. **Configure primary sale.** Set price, sale supply, wallet limit, start/end, and pause state. Simulate then submit to the current primary-sale contract for the new token. Read back sale state and reload Studio to confirm it persists.
13. **Wait for indexer discovery.** Do not touch checkpoints. Poll the normal health/readiness/API path until the new release, edition, token, sale, and ownership projections are visible.
14. **Collector discovers.** In a separate collector session, load the public catalog/API and confirm the fresh release is listed with public artwork/preview and no private data.
15. **Collector purchases/claims.** Create the purchase intent, submit the Fuji transaction, record submission, and verify it. Confirm the purchase is finalized/confirmed by the normal flow.
16. **Wait for ownership indexing.** Confirm the collector balance/ownership projection for the new contract and token.
17. **Test denied gated access.** Before ownership or with a non-holder wallet, request a media grant and confirm denial.
18. **Test holder gated access.** As the collector, request a grant, open the grant URL, and verify the private full track is delivered from private storage rather than exposed by the public catalog.
19. **Test revoke/expiry behavior.** Revoke the grant, reload, and confirm access is denied. Test natural expiry if the environment makes that practical.
20. **Reload/navigation matrix.** Reload at minimum after draft save, after private registration, after metadata publication, after on-chain publication, after sale configuration, after catalog discovery, after purchase submission, and before/after gated playback. At each point verify the workflow resumes from persisted server/on-chain state.

## KNOWN CONFLICTS AND HIDDEN DEPENDENCIES

- **Withdrawn listing predicate:** old releases are intentionally hidden. A fresh fixture must not use an excluded slug or ID.
- **Empty Pinata:** every public and private asset must be newly uploaded in this run. Any UI state containing an old URI is invalid evidence.
- **Metadata immutability:** once the edition is published, metadata cannot be changed. Public preview, artwork, and holder-unlock media must be correct before the Fuji transaction.
- **Private/public separation:** the exact public preview cannot also be the protected full track.
- **Artist role:** the artist wallet needs `ARTIST_ROLE` on the current Fuji release contract.
- **Wallet/chain:** publication and sale require the configured Fuji chain and usable wallet provider.
- **Current contract scope:** API/indexer projections filter/select current certified contracts. Old contract addresses or old token IDs are not valid fixtures.
- **Existing DB rows:** existing published rows may be stale, withdrawn, archived, or tied to deleted Pinata assets. They must not be used as proof of a clean run.
- **Indexer timing:** public API visibility is asynchronous. A successful chain transaction does not imply immediate catalog visibility.
- **Protected asset ownership:** the asset must belong to the same artist as the experience; the gateway fails closed otherwise.
- **Experience publication:** gated content requires a published experience and an active ownership entitlement, not merely a token row.
- **Provenance services:** if metadata/provenance storage or fetch verification is unavailable, publication may stop before the chain step or remain not fully published.

## BLOCKERS

No code-level blocker was established by this forensics pass. The following operational prerequisites can still block execution:

1. A fresh artist wallet with the required Fuji publishing role.
2. A separate collector wallet with enough Fuji AVAX for the configured primary purchase and gas.
3. Working public metadata storage and public upload configuration.
4. Working private Pinata upload, lookup, and byte-hash verification configuration.
5. Running Studio/API, indexer worker, and database services.
6. The current Fuji primary-sale contract must accept the new token's configuration and purchase.
7. The indexer must be healthy and already configured for the current contracts.

If any prerequisite fails, stop at that step and capture the exact API error, transaction hash (if any), release/edition/token identity, and whether the failure occurred before or after persistence.

## DO NOT REDO

- Do **not** restore old withdrawn releases.
- Do **not** restore deleted Pinata public or private files.
- Do **not** republish `forgive-forget-23` or any old release.
- Do **not** remove `forgive-forget-23` from `WITHDRAWN_PUBLIC_LISTING_IDS`.
- Do **not** modify contracts, checkpoints, Render configuration, deployment infrastructure, or database lifecycle state.
- Do **not** treat an existing published database row as the clean fixture.

## NEXT ACTION

**Exactly one next action:** open Artist Studio with a fresh artist wallet and begin a new release workflow, stopping after the first draft save; record the generated release ID and confirm that the new draft has no old Pinata URI, old release slug, or old token ID before proceeding to uploads.
