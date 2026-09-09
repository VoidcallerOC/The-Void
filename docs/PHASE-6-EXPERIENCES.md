# Phase 6 — Experiences

## Experience architecture

Phase 6 extends the music-native catalog so ERC-1155 editions can provide utility beyond artwork ownership. `createExperience` now uses a validated generic type from `EXPERIENCE_TYPES`, and `createRequirement` provides an extensible requirement boundary. An edition references experiences through `experienceIds`; no UI component maps an experience directly to a token ID.

The supported conceptual types are **AUDIO, VIDEO, STEMS, DOWNLOAD, ARTWORK, LYRICS, DEMO, LIVE_RECORDING, TICKET, VIP_ACCESS, DISCOUNT, and PHYSICAL_REDEMPTION**. The model also carries edition tier and value-proposition metadata so Standard, Collector, and Archive editions can communicate what they unlock.

Ownership is the initial requirement type. Requirements can specify contract, token IDs, minimum amount, and chain ID. The collector library resolves every edition experience to an access result with `UNLOCKED` or `LOCKED` state and a reason. This gives the collector a clear path: what I own, what it unlocks, and how it is accessed.

## Token-gated audio and content UX

Release and edition pages now list experiences with their type, whether they are ownership-gated, and whether media is protected. Collector cards show all associated experiences, including locked experiences and the reason access is unavailable. Voidcaller’s existing full-record experience is explicitly modeled as protected `AUDIO` with a preview-available flag, while its existing token ownership behavior remains intact.

The same model supports stems, demos, live recordings, alternate mixes, videos, lyrics, artwork, and downloads. Future ticket, VIP, discount, and physical redemption experiences can use the same edition-to-experience relationship without introducing UI-specific token assumptions.

## Authorization architecture

Protected media uses the Phase 5 grant boundary in `src/lib/media-auth.js`. A collector requests a wallet-bound challenge, signs it through a server-integrated flow, and receives an opaque short-lived grant only after the server verifies current ownership. Grants are bound to wallet, experience ID, media type, issue time, and expiry. The protected media endpoint receives the opaque grant rather than a permanent master-file path.

The media type is validated against the protected set: audio, video, stems, downloads, demos, and live recordings. Public previews remain suitable for static delivery; masters, stems, and downloadable files must be served only through an authenticated media gateway.

## Files changed

| Area | Files |
|---|---|
| Generic experience model | `src/domain/models.js`, `src/data.js` |
| Access resolution | `src/lib/collection.js` |
| Collector and catalog UX | `src/components/Reliquary.jsx`, `src/components/PlatformPages.jsx` |
| Protected media contract | `src/lib/media-auth.js` |
| Validation | `src/lib/experiences.test.js`, existing collection and media-auth tests |

## Tests

The Phase 6 suite validates all supported conceptual types, multiple experiences on one edition, multiple edition tiers, authorized and unauthorized ownership requirements, locked-state explanations, protected download/stems grant binding, grant expiry, media-type separation, and existing Voidcaller experience behavior. The complete repository suite should also continue to cover marketplace, Web3, wallet, and audio behavior.

## Security findings

The browser remains an untrusted presentation layer. A collector-side access result must never authorize a protected file by itself. The production media service must verify the signed challenge, query current ownership or a trusted fresh index, bind the grant to the requested experience and media type, enforce expiry, rate-limit access, and avoid leaking origin storage URLs. Physical redemption and ticket/VIP records require additional server-side state and should not be inferred solely from a UI flag.

No legal claim about music rights is made by this model; access is represented as a product permission and still requires the artist’s rights and fulfillment arrangements.

## Remaining limitations

The repository defines the experience and authorization contracts but does not yet include a hosted signing endpoint, production media gateway, artist dashboard, ticketing infrastructure, physical fulfillment workflow, or persistent redemption ledger. Voidcaller remains the only populated catalog, though the data model is generic. Public preview audio continues to be delivered by the existing frontend assets.

## Phase 7 prerequisites

Phase 7 should provide the persistent experience catalog API, artist-controlled experience configuration, production media gateway, signed challenge endpoint, indexer-backed authorization checks, download audit logging, ticket/VIP and redemption state machines, routed experience detail pages, and end-to-end tests against a testnet or fork.
