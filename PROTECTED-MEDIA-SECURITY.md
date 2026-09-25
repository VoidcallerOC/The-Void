# The-Void Protected Media Security Report

**Repository:** `VoidcallerOC/The-Void`  
**Status:** Implemented in code; deployment requires private storage configuration

## Storage architecture

Protected masters are intended to live under the server-only `private-media/` storage root and to stay out of the public Vite asset tree. `server/media-storage.js` provides a path-safe storage abstraction with content-type detection, byte-range parsing, and server-side streaming. `PRIVATE_MEDIA_ROOT` selects a mounted private directory; the abstraction can be replaced by a provider-backed adapter without changing the authorization or player contracts.

They were **not** removed from Git history. A history rewrite was never done, so the full-duration masters are still reachable by checking out commit [`d311a612`](https://github.com/VoidcallerOC/The-Void/commit/d311a6128d4104e430539f5adaeb689435f6f658) (`d311a6128d4104e430539f5adaeb689435f6f658`). That tree still contains the masters under both `public/assets/audio/` and `public/assets/audio-preview/`. Deleting the files from later commits does not purge those blobs. Ignoring `private-media/` only stops new commits of that directory.

Render configuration now documents `PRIVATE_MEDIA_ROOT` and `MEDIA_STORAGE_MODE`. Deployment must populate the private storage mount or configure the corresponding provider adapter. Public clips under `public/assets/audio-preview/` are short `*-preview.mp3` files only. Full tracks must be reached through the token-gated protected media flow.

## Protected asset types

The authorization contract supports `AUDIO`, `VIDEO`, `STEMS`, `DOWNLOAD`, `DEMO`, and `LIVE_RECORDING`. The current catalog protects the four released Chapter I full-resolution audio masters. Existing forthcoming tracks remain preview-only. The old full-resolution files were removed from the current `public/assets/audio/` tree, and the non-`*-preview` full-length MP3s that were still checked in under `public/assets/audio-preview/` are removed from the current tree as well. That does not delete them from history — they remain reachable at commit `d311a612`.

## Authorization flow

A protected stream request reaches `/api/media/stream/:mediaKey`. The server authenticates the wallet session, validates the opaque media key against the server catalog, binds it to the expected experience, media type, and chain, resolves current ownership from server-side `ownership_snapshots`, issues a five-minute persisted grant, records grant and access audit events, and streams the private file. The response never contains a storage URL or filesystem path. Range requests are supported for normal browser audio playback.

`POST /api/media/grants` exposes the same grant issuance flow for clients that need an explicit grant. `POST /api/media/grants/revoke` revokes a grant for its owning wallet. Grants are wallet-bound, experience-bound, media-bound, chain-bound, expiring, and revocable. Direct filesystem traversal and invalid byte ranges are rejected.

Ownership decisions are server-side. Client-side ownership continues to control UX gating only; it cannot authorize a protected request by itself.

## Frontend changes

Released track metadata now points to `/api/media/stream/audio/...` rather than `/assets/audio/...`. Preview URLs remain public. Existing Reliquary/Experience queue and player behavior is preserved: non-owners receive previews, while owners request the authenticated protected route through the existing audio element. No private storage URL is embedded in source, HTML, or API JSON.

## API and database changes

The API router now supports protected media grant, revoke, and streaming routes, including HTTP range responses. New migration `006_private_media.sql` adds `media_assets` metadata and access indexes. Existing `experience_grants` and `media_authorizations` tables are used for persisted grants and audit events. Repository support now includes grant revocation.

## Environment variables

Required deployment configuration:

- `PRIVATE_MEDIA_ROOT`: server-only mounted private media directory.
- `MEDIA_STORAGE_MODE=filesystem` for the current adapter; a provider-backed implementation may use the same abstraction.
- Existing `DATABASE_URL`, authentication, and chain configuration.

Protected masters must be provisioned into private storage separately; they must not be copied into `public/` or committed to GitHub.

## Old public URLs

The former `/assets/audio/*.mp3` files were removed from `public/assets/audio/`, and released track metadata no longer references them. Those paths are therefore not present in the current frontend build. The new `/api/media/stream/...` routes require a verified authenticated session and server-side ownership before any bytes are returned.

## Verification

- `npm test`: **PASS** — 12 test files, 82 tests passed.
- `npm run lint`: **PASS**.
- `npm run build`: **PASS**.
- Public asset audit: the current `public/` tree must not ship full-length audio (CI fails if any audio file under `public/` is longer than 35 seconds). This is not a history purge — the masters are still reachable at commit `d311a612`.
- Security tests cover owner access, non-owner rejection, wrong wallet, wrong chain, expiration, revocation, wrong experience, traversal rejection, valid ranges, and protected storage behavior.

## Remaining deployment configuration

The code is complete, but production deployment is not certified until the private media mount/provider is provisioned and populated, migration `006_private_media.sql` is applied, published experience requirements and ownership snapshots are present for the target network, and deployed authenticated playback is tested on both Fuji (`43113`) and Avalanche C-Chain (`43114`). No deployment credentials or contract addresses were available for this repository-only run.
