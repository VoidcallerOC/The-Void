# Release Architecture Recovery — 2026-10-09

Evidence rules: [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md). This session could not reach the Fuji RPC
(the sandbox network policy denies `api.avax-test.network`), so every on-chain claim below is either cited from
`CHAIN-AUTHORITY-FUJI-VERIFICATION.md` (probe of 2026-10-08) or labelled **UNVERIFIED**.

## 1. Recovered vision (from repository evidence)

| Source | What it establishes |
|---|---|
| `audit-reports/01-release-per-contract-implementation.md` | Every new release gets its own ERC-1155 clone, dedicated primary sale and provenance anchor. Canonical identity is `(chainId, release contract, tokenId)`. |
| `contracts/VoidRelease1155V4.sol` (PR #136, `f67a643`) | Album semantics on a release clone. `createAlbum` opts the clone in. `createAlbumTrack(..., bool single, uint64 mintEnd)` adds tracks: 13 tracks and 4 singles by default, more only through `approveExpandedRelease`. `closeAlbum` stops new tracks. Open editions use `maxSupply = 0` plus `mintEnd`. |
| `server/studio-service.js:46-49`, `ArtistStudioPage.jsx` | Release types are **EP** (standalone) and **ALBUM**. A **single is a track inside an album, flagged on-chain with `isAlbumSingle`**. It is not a separate release type or contract. |
| `README.md` "Release Model" | Lists Single / EP / Album. This **conflicts** with the code above. The code is newer (PR #136), so it is used here. **Decision needed:** keep "single = album track flag", or add a standalone SINGLE release type. |

## 2. Deployed vs source

| Object | Address | Status | Evidence |
|---|---|---|---|
| VoidReleaseFactoryV2 | `0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505` | Deployed | Receipt `0x734b…5b0d` (chain-authority probe, tier 1) |
| Clone implementation | `0xAe3257a441C5119Ee496330Dd93Deb06ab0eB8b4` | Deployed. It is the **pre-album** V4 build. | Factory deployed 2026-10-05 from `9ec82e2`. The album/open-edition V4 source was merged 2026-10-06 (`f67a643`). EIP-1167 clones cannot be upgraded. Bytecode check is **UNVERIFIED** this session (RPC blocked). |
| ReleaseMarketplaceV3 | `0x42B740aA92A6F48380F6D97AD91e332a7921a744` | Deployed, `registry() == FactoryV2` | Chain-authority probe |
| Factory releases | `0x1AaF…9BfC` (sale `0x1cBc…b996`), `0x12Ff…0Fe6` (sale `0x3671…5aFD`) | Created on-chain | Two `ReleaseCreated` logs (probe) |
| Published editions on any per-release clone | — | **None** | Production `/api/editions` (2026-10-09 08:06Z) lists only editions on the shared V2 `0x7Bba…95B6` and the legacy C-Chain collection |

**Consequence:** no deployed contract can create an album or a single today. The Studio album path would call
`createAlbum` / `createAlbumTrack` on clones that do not have those functions.

## 3. Production state observed (2026-10-09 ~08:05Z)

| Component | Observation | Source |
|---|---|---|
| Vercel production | READY, commit `1b900de` (= `main` HEAD) | Vercel API |
| Render API `the-void-api-fuji` | Live deploy is commit `1805343…`, **which is not in `main`'s history** (history appears rewritten). Code-equivalent to `cf8f77e`. The `server/` runtime files differ from HEAD only in `genesis-claim.js`. Auto-deploy is **off**. | Render API |
| Render worker `the-void-indexer-fuji` | Live on `1b900de`. Cycles about every 17 s over 8 contracts. | Render logs |
| Render cron `The-Void` | Runs `npm run deploy:marketplace` on schedule `0 0 1 1 *` (yearly). If its env holds deployer credentials it would broadcast a legacy MusicMarketplace deploy on Fuji. **Needs an owner decision.** | Render API |
| `/api/health/ready` | 200, `database.ok`, indexer lag 14 blocks, `last_error: null`, cumulative `database_failures: 137` | Fetched through the Vercel proxy |
| Indexer health contract list | 6 entries: `0x1aaf…`, `0x1cbc…`, `0x42b7…`, `0x51cc…`, `0x7bba…`, factory `0xa5cb…`. The second factory release (`0x12ff…` / `0x3671…`) is absent, because health only reports the API's static `INDEXER_CONTRACTS_JSON`. | `/api/indexer/health` |
| Database host | Not visible to this session. The only Supabase project the connector sees (`rnzheflamxlsbenlyozo`) is INACTIVE. RLS state is **UNVERIFIED** live. | Supabase / Render APIs |

## 4. Blocker matrix

| Historical lead | Current evidence | Status | Smallest next action |
|---|---|---|---|
| Frontend vs API/indexer marketplace parity | Listing and indexer both use V3 `0x42B7…`. Buy used the **API-supplied** marketplace address as the payable target. | **Fixed in this PR** (client pins the target) | Confirm `VITE_MARKETPLACE_ADDRESS` in Vercel = `0x42B7…` |
| Registry / multi-contract discovery | Factory discovery works (indexer reports 8 contracts). Health under-reports dynamic contracts. | PARTIAL | Report `factory_releases` contracts in indexer health |
| Album / single architecture | Source and tests exist (`forge test`: 164 passed). The deployed implementation predates albums. | **BLOCKED on deployment** | Redeploy FactoryV2 + ReleaseMarketplaceV3 from current source (wallet handoff) |
| Claim binding factory | `claim-state.js` compared against the unused V1 factory `0x8291…` | **Fixed in this PR** | — |
| Release type in published metadata | Taken from raw request input | **Fixed in this PR** | Deploy the API |
| Indexer V4 album events | `AlbumCreated` / `AlbumTrackCreated` / `AlbumClosed` are not decoded | NOT STARTED | Add the topics after the album-capable deploy |
| DB TLS | `sslmode=require` defaults to `rejectUnauthorized=false` (`server/config.js:152`) | UNVERIFIED risk | Set `DATABASE_SSL_REJECT_UNAUTHORIZED=true` with the provider CA after testing |
| RLS / grants | Migrations 017/036 plus `scripts/check-rls.sql` | UNVERIFIED live | Run `scripts/check-rls.sql` against production (read-only) |
| Pinata credential | README says invalid/expired | UNVERIFIED | Owner rotates `PINATA_JWT` in Render |
| Fuji credentials / fee config | FactoryV2 fee = 250 bps to `0xb65C…1ce4` (immutable). Legacy sale = 500 bps. | Resolved for V2 | — |
| API deploy drift | API is on a commit outside `main` history | **Open** | Owner-approved manual deploy of `main` to `the-void-api-fuji` |

## 5. Contract findings (no code change; need decisions)

1. The artist holds `DEFAULT_ADMIN_ROLE` on their clone, so `approveExpandedRelease` lets the artist lift the 13/4 caps. The caps are advisory unless the platform holds that role.
2. `createAlbum` does not check for existing standalone editions, so they can be minted before album mode and bypass the caps.
3. FactoryV2 is permissionless. `isRelease` proves the code is genuine, not who the artist is; artist identity is checked off-chain only.
4. ReleaseMarketplaceV3 pays out with push payments. A reverting royalty receiver blocks resales of that token. Funds are not at risk.

## 6. Verification plan

- **Source:** `npm test`, `npm run lint`, `npm run build`, `npm run db:validate:migrations`, `forge test`.
- **Album path (after redeploy):** on Fuji, create an ALBUM release → `createAlbum` → three tracks with one single → `closeAlbum`. Each step needs a receipt and indexed rows. Then purchase on the release sale, list and buy on V3, and run the protected-media unlock.
- **EP path:** the same flow on a FactoryV2 clone without `createAlbum`. No edition has been published on any clone yet.
- **Production:** `/api/health/ready`; the indexer contract list includes every `factory_releases` clone; the Vercel `VITE_MARKETPLACE_*` value matches `config/fuji-release-per-contract-v2.json`.
