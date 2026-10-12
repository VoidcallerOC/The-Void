# Mainnet (Avalanche C-Chain, 43114) launch runbook — core marketplace

Release-per-contract architecture validated on Fuji: `VoidReleaseFactoryV2` (creates the
album-capable `VoidRelease1155V4` clone implementation) and `ReleaseMarketplaceV3` bound to it.
Fresh mainnet deployments; no Fuji state or address is reused. Genesis claims are a separate,
later phase and stay disabled here.

Both contracts are **ownerless**. The fee recipient and fee rate are **immutable** once mined.

| Item | Value |
| --- | --- |
| Primary fee | 250 bps, sealed in the factory bytecode (credited per release sale contract; the recipient calls `withdraw()` on each sale contract to collect) |
| Secondary fee | 250 bps, marketplace constructor (paid to the recipient on every sale) |
| Fee recipient | The owner's Nano S Plus address, **physically verified on the device**. One address for both fees. The Fuji treasury `0xb65C…1ce4` is refused by the script. |
| Deployer | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` (existing `DEPLOYER_PRIVATE_KEY` secret). Holds no role or ownership after deployment. |
| Predicted addresses (deployer nonce 0/1) | Factory `0x262B774cf9a1949170B58E2d57F6189980FE757b`, implementation `0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006`, marketplace `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` |
| Funding | ≥ 0.15 AVAX on the deployer (estimate 0.069 AVAX at 10 gwei; fork rehearsal used 0.029 AVAX) |

The factory address equals the Fuji legacy V1 release address because it is the same deployer's
nonce-0 address on another chain. The code scopes the Fuji V1 address to chain 43113 only.

## Order (each **[APPROVAL]** step is a separate owner approval)

1. **Merge the network-selection PR** (Fuji unchanged; mainnet selectable and inert).
2. **Owner: verify the Nano S Plus receive address on the device screen** (Avalanche C-Chain / EVM account).
3. **Dry run** (no key, no transaction): Actions → *Deploy release-per-contract infrastructure to
   C-Chain mainnet* → `expected_deployer_address=0xaBd3…c174`, `platform_recipient=<verified>`,
   broadcast off. Every check must be PASS except the deployer-funding check before the deployer is
   funded, and the recipient checks, which stay UNVERIFIED until the device confirmation at broadcast.
4. **[APPROVAL] Fund the deployer** with 0.15 AVAX, sent from an owner wallet.
5. Re-run the dry run with `expected_deployer_nonce=0`; `readyToBroadcast` must be `true`.
6. **[APPROVAL] Broadcast:** the same inputs, plus `recipient_verified_on_device=<re-typed>`,
   `broadcast_deployment=true` and `confirm_mainnet_deploy=I_CONFIRM_CCHAIN_RELEASE_PER_CONTRACT_DEPLOY`.
   The script verifies the predicted addresses, `platformRecipient`, the 250 bps fee,
   `RELEASE_VERSION`, the album selectors, the marketplace `registry`/`feeRecipient`/`platformFeeBps`
   and `deploymentChainId=43114`. The record is uploaded as a workflow artifact.
7. **Record PR:** fill `config/mainnet-release-per-contract.json` from the record:
   addresses, blocks, recipients, `source: VoidReleaseFactoryV2`, `releaseVersion: 2`,
   `albumCapable: true`, `deployed: true`, `provisioningEnabled: true`, `deploymentAuthorized: true`.
   Commit `deployments/release-per-contract-mainnet-<factory>.json`.
8. **[APPROVAL] Create the mainnet Supabase project** (below). The API applies migrations 001–039 at start.
9. **[APPROVAL] Create the Render Blueprint** from `deploy/mainnet/render.mainnet.yaml` and enter its
   `sync: false` values. Deploy the API, then the indexer.
10. **[APPROVAL] Create the Vercel mainnet project** (below) and verify its preview end to end.
11. **[APPROVAL] Point the production domain** at the mainnet project, only after proof of the core journey (below).

## Resources to create (isolated from Fuji)

**Supabase**: a new project `The-Void-Mainnet` in the existing organization (Pro plan; adds one
compute instance). Do not reuse `qobyzszcydznuutqqhmf` (Fuji). Use the session-pooler connection
string as `DATABASE_URL` on both mainnet Render services.

**Render** (Blueprint path `deploy/mainnet/render.mainnet.yaml`):

- `the-void-api-mainnet`: a web service with auto-deploy off.
- `the-void-indexer-mainnet`: a worker with auto-deploy off.

If Render assigns the API a different hostname than `the-void-api-mainnet.onrender.com`, update
`deploy/vercel-mainnet/vercel.json`. Dashboard values:

| Key | Service | Value |
| --- | --- | --- |
| `DATABASE_URL` | both | mainnet Supabase connection string |
| `PUBLIC_APP_URL`, `AUTH_DOMAIN`, `AUTH_URI`, `API_ALLOWED_ORIGINS` | API | the mainnet web origin; `AUTH_URI` = `<origin>/reliquary` |
| `PINATA_JWT`, `X_*` | API | same accounts as Fuji |
| `MEDIA_AUDIT_HASH_SECRET` | API | a **new** random secret (≥ 24 characters) |
| `MARKETPLACE_ADDRESS` | both | mined marketplace |
| `INDEXER_CONTRACTS_JSON` | indexer | `[{"address":"<factory>","contractType":"RELEASE_FACTORY","startBlock":<factory block>},{"address":"<marketplace>","contractType":"MARKETPLACE","startBlock":<marketplace block>,"platformFeeBps":250}]` |

**Vercel**: a new project from this repository, with Root Directory `deploy/vercel-mainnet`. It uses
the build, install and routing settings in its `vercel.json`, which is the Fuji routing with only
the API host changed. Environment variables:

- `VITE_MARKETPLACE_CHAIN_ID=43114`
- `VITE_MARKETPLACE_ADDRESS=<mined marketplace>`
- `VITE_MARKETPLACE_FEE_BPS=250`

`VITE_RELEASE_NETWORK=mainnet` is set by the build command. The live Fuji project and
`vercel.json` stay unchanged.

## Proof required before calling the core product live

All of the following on C-Chain, with real transactions and the explorer links recorded:

- An artist creates a release through the mainnet factory, then creates an edition.
- The artist configures a sale; a buyer purchases.
- The indexer shows the purchase and ownership.
- The buyer lists the edition; a second buyer purchases it on the mainnet marketplace.
- The fee recipient receives 2.5% of the secondary sale and withdraws 2.5% of the primary sale.

A dry run, green CI or a fork rehearsal is not a live deployment.
