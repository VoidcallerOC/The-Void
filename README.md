# The Void

The Void is a music-native ERC-1155 release platform for publishing releases, defining track-level experiences, and allowing collectors to verify ownership before protected media is unlocked. The repository contains a React/Vite frontend, a separately deployed Node API, PostgreSQL persistence, a persistent Fuji indexer, and the supporting release and marketplace infrastructure.

The platform is implemented across several operational stages, but it is **not currently certified end-to-end**. This README distinguishes what exists in the repository, what is deployed or tested, and what still requires live certification evidence.

## Product Model

The user-facing model is:

> **Artist → Release → Tracks → Experiences → Collect → Ownership → Protected experiences and media**

A **Release** functions as the collection. A Release may contain multiple **Tracks**. Each Track can expose one or more **Experiences**, such as a full record, unreleased track, demo, live recording, alternate version, instrumental, stems, music video, or digital download where the selected category is supported by the current Studio implementation.

The backend also supports ownership requirements based on selected ERC-1155 token balances. Access is granted only after wallet authentication, current ownership verification, entitlement verification, and the protected-media authorization path succeeds.

The user-facing product terminology is **Release, Track, Experience, Collect, and Collection**. The word **Edition** remains in internal API, database, ABI, and contract-compatibility terminology because the existing ERC-1155 contract exposes `createEdition`, edition identifiers, and deterministic token identifiers. Artist Studio presents that compatibility layer through the Release/Track model rather than asking artists to create an Edition.

## Release Model

The supported release types are:

| Release type | Meaning |
| --- | --- |
| Single | One-track release |
| EP | Short-form multi-track release |
| Album | Full-length multi-track release |

A Release can contain multiple Tracks. A Track corresponds to an ERC-1155 token type within the Release collection contract. The track’s position in the release is not its token ID; token IDs are derived by the contract-compatible release and track identifiers and must not be inferred from track numbering.

## Artist Studio

The current Studio workflow is:

1. **Your Release** — select an existing Release or create the artist and Release record.
2. **Tracks** — provide Track details and collector benefits.
3. **Experiences** — choose what the Track or Release unlocks and configure the experience description.
4. **Supply** — set the finite collector supply and price data.
5. **Preview** — review the Release, Track/experience summary, artwork, benefits, and supply.
6. **Publish** — save the draft, publish metadata, submit the Fuji transaction, verify the receipt, and confirm publication in the API.

The workflow is therefore **Create Release → configure Release → add Tracks → configure Experiences → configure Supply → Preview → Publish**. The live Studio deployment has been verified to render the Release-native flow and no longer displays the stale `Enter an edition name` validation. The authenticated blockchain publication journey has not yet been fully certified end-to-end.

Published metadata and ordering are subject to the immutability rules enforced by the current backend publication path. The API rejects publication unless the required Release, Track-compatible record, metadata, wallet role, receipt, and on-chain event checks succeed.

## Architecture

| Layer | Current implementation |
| --- | --- |
| Frontend | React 19, Vite 8, React Router 7, inline-style components, and shared domain/lib modules under `src/` |
| Frontend deployment | Vercel static frontend with SPA rewrites; `/api/*` is proxied to the Render API service |
| API/backend | Node.js API under `server/`, deployed separately from the frontend on Render |
| Production API service | `the-void-api-fuji` |
| Database | PostgreSQL for persistence, wallet authentication, catalog and Release state, experiences, marketplace state, migration history, and indexer state |
| Indexer | Persistent Fuji indexer/worker that reads configured contracts and maintains durable chain state |
| Blockchain | Avalanche Fuji ERC-1155 release contract and the contract-compatible publication flow |
| Metadata | Pinata JSON/IPFS metadata storage when `METADATA_STORAGE_DRIVER=pinata` is configured |
| Protected media | Pinata-based private media download links in production, with server-side wallet, ownership, and entitlement checks |

Vercel does **not** contain the production API or persistent indexer runtime. The `vercel.json` configuration rewrites API traffic to `https://the-void-api-fuji.onrender.com` and schedules the indexer tick endpoint. The Render service and PostgreSQL database must be configured independently.

## Blockchain

The configured release environment is:

| Property | Value |
| --- | --- |
| Network | Avalanche Fuji |
| Chain ID | `43113` |
| Contract | `VoidRelease1155` |
| Contract type | ERC-1155 |
| Contract address | `0x262B774cf9a1949170B58E2d57F6189980FE757b` |
| Deployment block | `58428586` |
| Explorer | [Snowtrace Fuji](https://testnet.snowtrace.io) |

The current Fuji contract internally supports release IDs, edition IDs, token IDs, finite supply, metadata URIs, artist and issuer roles, minting, transfers, pause controls, and ownership reads. Artist Studio maps the user-facing Release/Track model to that compatibility surface. The configured contract is used by the current Fuji publication workflow; this does **not** mean that the entire platform has completed certification or that production launch readiness has been proven.

Fans cannot pay that certified contract. Its `mint` function is issuer-only and not payable, and it has no ERC-2981 royalty, so `MusicMarketplace` resale royalties against it are zero. `VoidRelease1155V2` and `VoidPrimarySale` are in this repository and keep the collectible as ERC-1155. Fans pay native AVAX to the sale contract, which mints the edition. They are not deployed by the source change, and this repository does not deploy `MusicMarketplace` or change mainnet. The table above stays on the certified V1 address until `npm run deploy:release-v2` is run on Fuji and the resulting config is committed. See [docs/RELEASE-ERC1155.md](docs/RELEASE-ERC1155.md).

The repository contains deployment and verification helpers, but a configured contract address, a deployed contract, a tested contract, a live application integration, certification, and production launch are separate claims. They must not be conflated.

## Wallet & Authentication

The wallet layer supports the repository’s EIP-6963 and legacy-provider detection path, wallet challenge authentication, signed sessions, chain restrictions, and ownership reads. Studio writes require an authenticated wallet session, and artist-management routes verify that the wallet owns or is authorized for the relevant artist record.

Ownership checks use indexed ERC-1155 balances and fail closed when the required ownership evidence is absent or the index is outside the configured freshness/lag bounds. The repository has tests for the authentication and ownership paths, but not every wallet provider or live wallet journey has been independently certified.

## Protected Media

Public preview audio is served from `public/assets/audio-preview/`. Full-duration masters are kept outside the public frontend asset path and are accessed only through the protected-media system.

The production architecture uses Pinata for private media retrieval and Pinata for JSON/IPFS metadata when the corresponding production configuration is present. The protected-media flow is:

> **Wallet authentication → ownership verification → experience entitlement verification → short-lived media grant → Pinata protected-media retrieval**

The player does not receive a public master filename. The server validates the requested media against the configured experience, verifies current ownership, records the authorization event, and requests a short-lived Pinata private download link. Unauthorized users, stale ownership, invalid grants, and provider failures fail closed; protected media is not returned in those cases.

Production requires a valid `PINATA_JWT`, an HTTPS `PINATA_GATEWAY_URL`, the protected-media audit secret, and the related server configuration. The current reported production Pinata credential is invalid or expired, so Pinata production media is **not certified**. Credentials, tokens, private keys, and signed URLs must never be placed in this repository or exposed through frontend variables.

## API / Backend

The API is implemented under `server/` and is started by the container with `npm run start:api`. Its responsibilities include:

- Wallet challenge and session authentication.
- Artist, Release, Track-compatible record, and Experience persistence.
- Metadata canonicalization and Pinata publication.
- Fuji publication transaction verification and receipt confirmation.
- Ownership and catalog reads backed by PostgreSQL and the indexer.
- Protected-media grants, audit records, and revocation.
- Marketplace listing and purchase infrastructure.
- Health and readiness endpoints.

The backend is not bundled into the Vercel frontend deployment. `Dockerfile` builds the Node 22 API image and exposes port `8787`; Render supplies the runtime environment and database connection.

## Database

The repository uses transactional numbered migrations under `server/migrations/`. The current migration inventory is `001_initial_persistence.sql` through `012_artist_studio.sql`.

| Command | Purpose |
| --- | --- |
| `npm run db:validate` | Connects to PostgreSQL, verifies migration records and checksums, checks required schema objects, and compares the live schema against a shadow replay of the migrations. |
| `npm run db:migrate` | Applies pending migrations transactionally while holding the PostgreSQL advisory lock. |
| `npm run db:baseline` | Fail-closed recovery command for a database that already contains migration 001’s schema but lacks its migration record. It verifies the pinned checksum and exact shadow-schema compatibility before recording only migration 001. |
| `npm run db:baseline:check` | Read-only baseline compatibility check; it never records migration history. |
| `npm run db:validate:migrations` | Validates the repository migration inventory and transaction structure without requiring a live database. |

For the specific recovery case where the initial schema exists but `schema_migrations` is missing migration 001, use the operator-approved sequence documented in [`LAUNCH-GATE.md`](./LAUNCH-GATE.md):

```bash
npm run db:baseline
npm run db:migrate
npm run db:validate
```

Do not run migration or baseline commands against Render or Supabase from an unreviewed shell. Do not manually insert migration rows or use pasted production SQL as a substitute for the recovery command.

## Local Development

```bash
npm install
npm run dev
npm run build
npm run preview
npm run start:api
npm run start:indexer
```

The API and indexer require the environment variables described in [`.env.example`](./.env.example), including a PostgreSQL connection. The development media driver may use filesystem storage outside the web root. Production configuration is intentionally stricter and requires the Pinata driver for protected media.

## Testing

The repository’s standard validation commands are:

```bash
npm test
npm run lint
npm run build
npm run db:validate:migrations
```

Database integration tests in `server/baseline.test.js` and related files run when `TEST_DATABASE_URL` is configured. They cover empty-database migration, compatible-schema baselining, partial-schema failure, constraint/index/column drift, checksum mismatch, existing migration records, and dry-run behavior. Without `TEST_DATABASE_URL`, those database integration cases are skipped rather than falsely reported as passing against production.

## Deployment

The current deployment split is:

- **Vercel:** React/Vite frontend, SPA routing, API proxy rewrites, and the scheduled indexer tick request.
- **Render:** `the-void-api-fuji` Node API service and the persistent Fuji indexer/worker runtime.
- **PostgreSQL:** durable application, authentication, catalog, experience, marketplace, and indexer persistence.
- **Avalanche Fuji:** the configured Release ERC-1155 contract and current staging publication workflow.
- **Pinata:** intended production provider for private protected-media links and JSON/IPFS metadata.

The repository does not by itself provision Render, PostgreSQL, Pinata credentials, private media, contracts, monitoring, backups, or a production certification environment. Deployment documentation must be read together with [`LAUNCH-GATE.md`](./LAUNCH-GATE.md), which records the remaining launch prerequisites and operational recovery instructions.

## Current Certification Status

**The Void is not currently certified end-to-end.**

Known remaining prerequisites include:

1. A valid production Pinata credential and verified private-media configuration.
2. A legitimate Fuji ERC-1155 entitlement for the certification wallet.
3. Successful live protected-media certification after those prerequisites are satisfied.
4. Completion of the authenticated Studio publication journey and the broader launch-flow evidence.
5. Independent evidence for any live marketplace or production-readiness claim.

The certification workflow correctly fails closed when the required entitlement is missing. The repository must not claim complete certification, successful protected media, complete six-track Fuji certification, or production marketplace readiness without current verified evidence.

## Marketplace Status

Marketplace persistence, listing, purchase, reconciliation, and indexer infrastructure exist in the backend and database schema. The frontend distinguishes implemented marketplace infrastructure from a live secondary market. A functioning, configured, and certified secondary marketplace must not be claimed unless a reviewed marketplace contract, deployment configuration, indexed listings, and successful live transaction evidence are available.

## Security and Fail-Closed Guarantees

The current implementation is designed around several boundaries:

- Server-only secrets are not exposed as `VITE_*` variables.
- Wallet sessions and artist writes require authentication.
- Ownership and experience requirements are checked before protected-media access.
- Invalid or stale ownership does not produce a media grant.
- Pinata/provider failures do not produce a successful on-chain publication state.
- Publication confirmation requires a successful receipt and the expected event and on-chain metadata.
- Migration baselining refuses to record history when schema compatibility is not proven.
- The repository does not claim certification without evidence.

## Repository Architecture

Important source locations include:

| Path | Responsibility |
| --- | --- |
| `src/App.jsx` | Frontend route composition |
| `src/components/` | Studio, marketplace, wallet, collection, and page components |
| `src/lib/` | Wallet, web3, marketplace, media, catalog, and client-domain helpers |
| `server/api-http.js` | HTTP API routing |
| `server/config.js` | Server, indexer, media, and metadata configuration validation |
| `server/studio-service.js` | Artist Studio persistence and publication workflow |
| `server/metadata-storage.js` | Canonical metadata and Pinata JSON/IPFS storage |
| `server/media-storage.js` | Filesystem development and Pinata/object storage adapters |
| `server/baseline.js` | Fail-closed migration-001 schema baselining |
| `server/migrate.js` | Transactional migration runner |
| `server/validate-db.js` | Database migration, checksum, and schema validation |
| `server/migrations/` | Numbered PostgreSQL migrations |
| `config/fuji-release.json` | Fuji chain and VoidRelease1155 configuration |
| `contracts/` | Contract sources and deployment artifacts |
| `scripts/` | Fuji probes, release verification, and operational helpers |
| `render.yaml` | Render service definitions and deployment configuration |
| `vercel.json` | Vercel frontend rewrites, headers, and cron configuration |
| `LAUNCH-GATE.md` | Verified scope, launch prerequisites, and recovery runbooks |

## Documentation Boundaries

This README is synchronized to the repository implementation, but live deployment state can change independently. A deployed contract is not automatically certified; a rendered Studio flow is not the same as an authenticated successful publication; configured Pinata code is not proof of a valid production credential; and marketplace tables are not proof of a live secondary market. Current operational evidence and the launch gate must be reviewed before making those claims.

## License and Project Status

The Void remains an active staging and certification project. Treat Fuji as the configured staging environment unless the deployment and certification evidence explicitly states otherwise.
