# The Void — Create Release Selector Forensics

**Date:** 2026-10-04  
**Scope:** Read-only investigation of why the Create Release screen surfaces an existing Forgive & Forget card. No code, database, Pinata, contracts, checkpoints, Render configuration, or deployment was changed.

## STATUS

**PARTIAL.** The selector's source and behavior are proven from the repository. The exact live authenticated payload from the user's browser session was not replayed, so the specific row currently displayed in that session cannot be distinguished with certainty between the older archived `forgive-forget-18` record and a newer `forgive-forget-23` row.

## SOURCE OF CREATE-RELEASE CARDS

The Create Release cards do **not** come from public `/api/releases`.

### Browser path

`ArtistStudioPage.jsx` loads the Studio-specific catalog when the wallet is connected and authenticated:

```text
GET /api/studio/catalog
  → studioFetch("/studio/catalog")
  → StudioService.listCatalog()
  → mapPublishedCatalog(payload)
  → studioCatalogForConnectedWallet(...)
  → studioReleaseChoices(...)
  → Create Release card
```

Relevant frontend behavior:

- `GET /api/studio/catalog` is called at `ArtistStudioPage.jsx:177-189`.
- The result is mapped and wallet-scoped at lines 183-185.
- Cards are generated from `existingReleases = studioReleaseChoices(ownedStudioCatalog || {})`.
- The Create Release UI renders each `existingReleases` item at lines 635-659.
- The card image is `record.release.artwork`.

### Exact API route

`server/api-http.js:83-86` dispatches:

```text
GET /api/studio/catalog
  → studioService.listCatalog({ request: apiRequest })
```

This is an authenticated Studio endpoint, not the public catalog endpoint.

### Exact database queries

`server/studio-service.js:191-200` performs four wallet-scoped queries. The release-card query is:

```sql
SELECT
  r.id,
  r.artist_id,
  r.slug,
  r.title,
  r.description,
  r.status,
  r.release_metadata
FROM releases r
JOIN artist_owners ao ON ao.artist_id = r.artist_id
WHERE lower(ao.owner_wallet) = lower($1)
ORDER BY r.created_at DESC
LIMIT 500
```

The edition query separately joins the same artist ownership scope and returns:

- edition ID;
- release ID;
- title/description/supply/status/application metadata;
- contract address and chain ID;
- token ID only when `e.status = 'PUBLISHED'`;
- whether a matching purchase projection exists.

The experience query similarly returns all experiences belonging to artist records owned by the authenticated wallet.

### Does the query include withdrawn releases?

**Yes.** The SQL has no `status` predicate. It includes `DRAFT`, `PUBLISHED`, `ARCHIVED`, and any other lifecycle status for releases owned by the authenticated wallet.

The server does not apply the public `WITHDRAWN_PUBLIC_LISTING_IDS` policy to `/api/studio/catalog`.

The returned catalog is later filtered in the frontend by `studioReleaseChoices`, which excludes `ARCHIVED` rows, but it intentionally keeps a `PUBLISHED` row. Therefore a published/archived historical catalog representation can remain available to Studio even when it is absent from public `/api/releases`.

### Does it include published catalog releases regardless of Pinata availability?

**Yes.** The query reads persisted database fields and does not contact Pinata, validate a metadata URI, fetch artwork, or verify that any CID still exists. A release can be returned because its database row is owned by the wallet and has a title/status, even if its original Pinata assets were deleted.

### Does it include releases belonging to the current Voidcaller artist?

**Yes, for the platform Voidcaller wallet.** The `artist_owners` join scopes records by wallet ownership. A separate frontend filter only removes Voidcaller profiles when the connected wallet is the Fuji admin/deployer wallet:

- `studio-wallet-catalog.js:36-58` removes Voidcaller profiles only for `STUDIO_ADMIN_DEPLOYER_WALLET`.
- The existing Voidcaller/platform artist wallet is not removed.

Repository migration `032_studio_voidcaller5_artist_wallet.sql` explicitly exists so the Voidcaller-owned Forgive & Forget profile appears in `GET /studio/catalog` for the platform artist wallet.

## FORGIVE & FORGET SOURCE AND IDENTIFIERS

### Proven archived catalog identity

The repository and prior forensic evidence identify the older Forgive & Forget catalog record as:

| Field | Value |
|---|---|
| Release slug | `forgive-forget-18` |
| Release ID | `release-b96d6a64-3379-4da0-b834-ae2e00bf9571` |
| Edition ID | `edition-e2e5abb4-bf03-42d1-9aea-c0b8492c3267` |
| Token ID | `25004510451461692631068377573407424988089298285712621798954341372639713583607` |
| Chain | Avalanche Fuji, `43113` |
| Historical contract | `0x82b26Da27136935454Bdf1e40801190B521b82e5` |
| Experience | `experience-0fe2d5b8-1d1a-4889-8854-54c4b9ff4a53` |
| Lifecycle | Archived by `030_archive_forgive_forget_18.sql` |

That migration changes the release, edition, and experience to `ARCHIVED` but deliberately preserves tokens, sale, ownership, and purchase history.

### Current `forgive-forget-23` identity

The codebase and prior chain audit also contain a distinct newer `forgive-forget-23` identity on the current V2 Fuji deployment. Its current chain token was previously verified as a different token (`5539478…2836` in the prior audit), not the archived `forgive-forget-18` token above.

The exact database UUID, edition UUID, and full token ID for the row currently shown in the user's authenticated Studio session were **not proven in this pass**, because the browser's authenticated `/api/studio/catalog` response was not captured. The source code proves that whichever owned row the card represents is loaded directly from the Studio database query.

## WHY IT APPEARS

The behavior is explained by the separation between **public catalog visibility** and **artist Studio ownership visibility**:

1. The public catalog uses public API lifecycle/filtering and the withdrawn-listing policy.
2. The Create Release screen uses `/api/studio/catalog`, whose purpose is to let an artist manage its own existing releases.
3. The Studio SQL scopes by `artist_owners.owner_wallet`, but does not exclude withdrawn IDs or require a valid Pinata object.
4. The frontend's `studioReleaseChoices` intentionally retains a published release of a title. It only removes archived rows and duplicate/hidden records under its documented rules.
5. Consequently, an owned persisted published catalog record can appear as an existing release card even though it is withdrawn from the public catalog and its Pinata assets no longer exist.

This is **not** evidence that Pinata still contains the artwork, and it is not caused by `/api/releases` restoring the old release.

## CLICK BEHAVIOR: NEW VS EDIT/RECOVERY/PUBLISHED PATH

Clicking the Forgive & Forget card is not a fresh-release action.

`ArtistStudioPage.jsx:519-529` does this:

```text
if record.release.status === "published":
    openPublishedSale(ownedStudioCatalog, record.release.id)
else:
    selectReleaseTemplate(record)
```

For a published record, `openPublishedSale` calls `resumeOwnedRelease`:

- finds the exact existing release by ID;
- finds its existing edition;
- preserves the release ID;
- preserves the edition ID;
- preserves the existing token ID;
- restores limited saved form values;
- sets `workflow = "catalog"`;
- sets `step = "sale"`;
- displays: “is loaded from the published catalog. Check the on-chain primary sale state below.”

Therefore the click enters a **published-sale recovery/configuration path**, not a new-release path. It does not create a new release and does not clear the existing release/edition/token identity.

For a non-published existing record, `selectReleaseTemplate` clears `releaseId`, `editionId`, and `selectedReleaseId`, retaining only title/description/artwork as a template. The subsequent Create release action then calls `POST /api/studio/artists/:artistId/releases` and creates a new release record.

## PINATA / ARTWORK PROVENANCE

The card artwork is not loaded from Pinata at card-selection time.

The proven data path is:

1. Studio SQL returns `releases.release_metadata`.
2. `mapPublishedCatalog()` reads `release_metadata` or `metadata`.
3. It maps `meta.artwork` through `ipfsToHttp()`.
4. If no artwork is present, it falls back to `/assets/voidcaller_art_4.png`.
5. The card renders that resulting URL directly in `<img src={record.release.artwork}>`.

For editions, the mapper similarly prefers persisted application metadata artwork, then public token metadata image, then a local fallback. None of these paths proves the current Pinata object exists.

For the older archived Forgive & Forget family, repository history contains persisted artwork/metadata references and prior on-chain metadata references. Those references can remain in the database, metadata document, browser cache, or CDN/IPFS gateway cache after the original Pinata account objects were cleared. This investigation did not make a network request to the user's authenticated Studio payload or prove which exact URI is in the displayed card.

### Proven vs unverified artwork source

**Proven:** the card consumes the persisted mapped `release.artwork` value, normally from `release_metadata.artwork`, with a local fallback if absent.

**Not proven for the screenshot:** whether the exact displayed image came from:

- a still-resolvable persisted IPFS/HTTP URI;
- a CDN or browser cache;
- a local fallback asset;
- an edition/token metadata image rather than release metadata.

Pinata being empty does not contradict the UI image rendering, because the UI does not perform a fresh Pinata existence check before rendering the card.

## HOW TO CREATE A FRESH VERSION WITH THE SAME VOIDCALLER ARTIST

The existing artist identity can be reused without reusing the old release:

1. Stay connected and authenticated as the existing Voidcaller/platform artist wallet.
2. On Create Release, do **not** click the existing Forgive & Forget card.
3. Enter a new release title that creates a new release identity. To make it a fresh version while preserving the recognizable title, use a distinct title/slug such as `Forgive & Forget — Fuji E2E Fresh` or an equivalent unique version label.
4. Upload new public artwork and public preview assets to the now-empty Pinata public path.
5. Upload/register new private full-track or experience audio to the empty private path.
6. Click **Create release**. The client calls `POST /api/studio/artists/:artistId/releases` with the existing artist ID and no existing release ID, creating a new draft release.
7. Create the new edition, protected experience, metadata, Fuji edition, publication confirmation, and primary sale using the new release/edition slugs.

The key distinction is: **reuse the artist ID, not the old release ID, edition ID, token ID, metadata URI, or Pinata asset references.**

## ROOT CAUSE

**Proven root cause of the observed card:** the Studio selector intentionally queries all persisted releases owned by the current artist wallet through `/api/studio/catalog`, without applying the public withdrawn-listing policy or checking Pinata availability. The frontend then treats a published owned row as a resumable published release and sends it directly to the sale step.

**Not proven:** whether the user's card is specifically the archived `forgive-forget-18` row or the newer `forgive-forget-23` row. The exact authenticated response is required to distinguish them.

## UNVERIFIED

- The exact live `/api/studio/catalog` JSON from the user's browser session.
- The exact release UUID and edition UUID loaded by that screenshot if it is the newer `forgive-forget-23` row.
- The exact artwork URI displayed in the screenshot.
- Whether the displayed image is currently served from Pinata, an IPFS gateway cache, browser/CDN cache, or a local fallback.
- Whether any client local-storage overlay contributes to the screenshot; the current Studio page path shown in source uses the authenticated Studio endpoint, not the public catalog fetch.

## DO NOT REDO

- Do not redo Pinata deletion.
- Do not redo the withdrawn-listing investigation.
- Do not restore old Pinata files.
- Do not republish old releases.
- Do not change Fuji contracts.
- Do not change indexer configuration or checkpoints.
- Do not change Render configuration.
- Do not remove the old release from `WITHDRAWN_PUBLIC_LISTING_IDS`.

## NEXT ACTION

**Exactly one smallest action:** capture one authenticated `GET /api/studio/catalog` response for the existing Voidcaller wallet and record the Forgive & Forget card's exact `release.id`, `edition.id`, `token_id`, `status`, and `release_metadata.artwork` before any code or data change.
