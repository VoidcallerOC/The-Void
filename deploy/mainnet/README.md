# The Void — coordinated Avalanche C-Chain (43114) launch runbook

One launch with three mandatory parts: **primary sales**, **secondary sales** and the **Forgive &
Forget Genesis claim**. Nothing is announced or activated until all three have real C-Chain evidence.
A partial public launch is not a fallback. Fuji stays operational and unchanged. The old C-Chain
Voidcaller collection is out of scope.

Every **[APPROVAL]** step needs the owner's explicit approval of that action and its exact parameters.

## Economics (final)

| Flow | Rate | Recipient | Enforced by |
| --- | --- | --- | --- |
| Primary sale platform fee | 2.5% | Nano S Plus | `VoidReleaseFactoryV2.PLATFORM_FEE_BPS` (bytecode) → each release's `VoidPrimarySale`. Credited on every purchase to the sale contract; collecting it later is a separate treasury operation, outside the launch |
| Primary sale remainder | 97.5% | The edition's artist payout (`payoutOf`) | `VoidPrimarySale` (pull balance) |
| Secondary marketplace fee | 2.5% | Nano S Plus | `ReleaseMarketplaceV4` (constructor refuses any fee but 250 bps; immutable), paid directly on every resale; no signature needed |
| Secondary artist royalty | 2.5% | The edition's own artist payout | **On chain:** `VoidRelease1155V4Royalty._createEdition`, reached by every creation path, refuses any royalty but 250 bps and any payout that is the fee recipient or lacks `ARTIST_ROLE` on that release. `ReleaseMarketplaceV4` independently refuses listings and settlements unless `royaltyBpsOf` is 250, `payoutOf` is non-zero and not the fee recipient, and ERC-2981 `royaltyInfo` agrees; it pays the royalty it computes itself. **Off chain (extra layers):** Studio, the encoders and API publication enforce the same rule |
| Seller proceeds | 95% | Seller | `ReleaseMarketplaceV4.buy` |

A 1 AVAX resale pays 0.025 to the artist payout, 0.025 to the Nano S Plus and 0.95 to the seller
(`test/MainnetEconomics.t.sol`, `test/RoyaltyEnforcement.t.sol`, `server/mainnet-economics.test.js`).

## Roles (always separate)

| Role | Address | Never used as |
| --- | --- | --- |
| Platform fee recipient (passive) | Nano S Plus `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`, recorded in `config/mainnet-release-per-contract.json`. Signs nothing in the launch. | deployer, signer, contract admin, artist |
| Deployer: Rabby (gas only; deploys contracts only; holds no role afterwards) | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, fixed. The owner signs every mainnet deployment in Rabby on their own machine; the key is never in GitHub, CI, a cloud service or a script ([`OWNER-SIGNING.md`](./OWNER-SIGNING.md)). | fee recipient, signer, release creator |
| Artist (release admin, edition payout) | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | fee recipient, signer |
| Genesis voucher signer | A new dedicated key, generated offline by the owner; only its public address leaves the device | anything else |
| Genesis claim admin (pause, signer rotation) | Proposed: the artist wallet (owner approves at step 11) | fee recipient, signer |

The deploy scripts refuse any overlap: the fee recipient as the artist, deployer or anything other
than the recorded Nano, and the signer as the fee recipient, admin, artist or deployer. Neither Ledger
signs anything in the launch, and the Ledger X has no role.

## Contracts and predicted addresses

Mainnet deploys the release-per-contract architecture validated on Fuji, with the artist royalty
enforced on chain:

- `VoidReleaseFactoryV2Royalty` is `VoidReleaseFactoryV2` with one difference: its clone
  implementation is `VoidRelease1155V4Royalty`. That is `VoidRelease1155V4` plus the royalty rule.
- `ReleaseMarketplaceV4` is `ReleaseMarketplaceV3` plus independent royalty and fee checks.

The Fuji contracts (`VoidReleaseFactoryV2`, `VoidRelease1155V4`, `ReleaseMarketplaceV3`) keep
identical runtime bytecode, and the deployed Fuji contracts are untouched. No mainnet contract
exists yet, so nothing deployed needs replacing; these sources take effect at the first mainnet
deployment. These are fresh deployments; no Fuji state or address is reused. The deployer's nonces
fix the addresses, so **the V2 deployment must be the deployer's first two transactions**:

| Nonce | Contract | Predicted address |
| --- | --- | --- |
| 0 | VoidReleaseFactoryV2Royalty | `0x262B774cf9a1949170B58E2d57F6189980FE757b` |
| (inside the factory) | VoidRelease1155V4Royalty implementation | `0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006` |
| 1 | ReleaseMarketplaceV4 | `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` |
| 2 | GenesisHolderClaim | predicted by its own dry run at step 11 |

The factory address equals the Fuji legacy V1 release address, because it is the same deployer's
nonce-0 address on another chain. The code scopes that Fuji address to chain 43113.

## Steps

1. **Owner: read the Nano S Plus address on the device screen** (view only; the device signs
   nothing). Open the Avalanche C-Chain/EVM account. The address shown must be exactly
   `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`. If it differs, stop: the manifest and this runbook
   must be corrected first.
2. **[APPROVAL] Review and merge the code PR(s).** The Fuji site redeploys with no behaviour change.
3. **Owner: resolve the existing gates.**
   - The deployer-authority note in `DEPLOYER-AUTHORITY-ROTATION-PLAN.md` asks for a re-review before
     mainnet use of `DEPLOYER_PRIVATE_KEY`. Both V2 contracts are ownerless, so the deployer keeps no
     authority after deploying.
   - The review decision record for the royalty contracts (Cursor CONDITIONAL PASS, scoped exception
     to the outside-reviewer standard), pending owner approval.
   - **Fuji-first gate** (`deploy/mainnet/FUJI-FIRST-GATE.md`): the written policy requires the
     marketplace and ERC-1155 contracts on Fuji before mainnet. **SATISFIED 2026-10-12:** run
     38252855896, all 14 checks PASS and independently re-verified. Record:
     `deployments/fuji-royalty-rehearsal-0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338.json`.
   - `LAUNCH-GATE.md` (NO-GO) and `docs/C-CHAIN-PRODUCTION-RUNBOOK.md` cover the old shared-contract
     path, which this launch does not use. Its workflow and script are removed.
   - **Deployment authority** (`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`). Mainnet is signed in Rabby
     by the owner; no key goes into GitHub. Resolve its open item O1 (existing copies of the deployer
     key outside Rabby) before funding the deployer.
4. **Dry runs (no key, no transaction).**
   - Actions → *Plan release-per-contract infrastructure for C-Chain mainnet*, with
     `expected_deployer_address=0xaBd3…c174` (the default), `expected_deployer_nonce=0` and
     `platform_recipient=0xb65C…1ce4`. Or run the same plan locally ([`OWNER-SIGNING.md`](./OWNER-SIGNING.md)).
   - Every check must be PASS, except the funding check (until step 5) and the two recipient checks,
     which stay UNVERIFIED until the device confirmation is typed into the signing tool.
5. **[APPROVAL] Fund the deployer** with 0.15 AVAX (V2 estimate 0.071 AVAX at 10 gwei; the fork run
   used 0.030) plus 0.05 AVAX for the claim deployment. Also fund the artist wallet (0 AVAX on
   C-Chain today) for creating the release, the edition, the sale and the `ISSUER_ROLE` grant.
6. **[APPROVAL] Owner signs V2 in Rabby** ([`OWNER-SIGNING.md`](./OWNER-SIGNING.md)):
   - re-plan at the funded state (nonce 0) and bind it, then run `npm run sign:mainnet` with the
     address read from the Nano screen as `--recipient-verified-on-device`;
   - in Rabby, with the deployer account, approve step 1 (factory, nonce 0) and, after it is verified,
     step 2 (marketplace, nonce 1).

   The tool verifies from chain:
   - each transaction against the reviewed unsigned request;
   - the predicted addresses, `platformRecipient`, the 250 bps fees, `RELEASE_VERSION` and the
     album selectors;
   - the royalty lock: `REQUIRED_ROYALTY_BPS` is 250 on the factory, implementation and
     marketplace, and the implementation's `platformFeeRecipient` is the Nano;
   - the marketplace `registry`, `feeRecipient` and `deploymentChainId`;
   - the runtime code of all three against the compiled artifacts.

   It does not offer the marketplace if the factory or implementation differs.
7. **Record PR.** From the workflow's record artifact, fill `config/mainnet-release-per-contract.json`:
   - factory, implementation and marketplace addresses and their deployment blocks;
   - `source: VoidReleaseFactoryV2Royalty`, `releaseVersion: 2`, `albumCapable: true`;
   - `deployed: true`, `provisioningEnabled: true`, `deploymentAuthorized: true`.

   Then commit `deployments/release-per-contract-mainnet-<factory>.json`.
8. **[APPROVAL] Provision the isolated mainnet infrastructure** (paid):
   - **Supabase:** a new project `The-Void-Mainnet`, region `us-east-2`, in the existing organization.
     Never reuse `qobyzszcydznuutqqhmf` (Fuji).
   - **Render:** create a Blueprint from `deploy/mainnet/render.mainnet.yaml`. It defines
     `the-void-api-mainnet` and `the-void-indexer-mainnet`, both in region ohio with manual deploys.
     Enter its `sync: false` values (table below). Deploy the API, which applies migrations 001–039,
     then the indexer.
   - **Vercel:** a new project from this repository, Root Directory `deploy/vercel-mainnet`. Set:
     - `VITE_MARKETPLACE_CHAIN_ID=43114`
     - `VITE_MARKETPLACE_ADDRESS=<marketplace>`
     - `VITE_MARKETPLACE_FEE_BPS=250`

     If Render's hostname differs from `the-void-api-mainnet.onrender.com`, update the project's
     `vercel.json`.
   - **Check:**
     - `/api/health` and `/api/health/ready` return 200;
     - `/api/indexer/health?chainId=43114` shows the factory and marketplace checkpoints advancing;
     - the site's wallet prompt asks for chain 43114;
     - `/api/releases` returns no Fuji data.
9. **Artist: create the mainnet Forgive & Forget release** in the mainnet Studio, with the artist
   wallet (never the deployer):
   - an open edition (no supply cap);
   - royalty fixed at 2.5% to the artist's wallet.

   The release contract itself refuses any other royalty or payout, and publication fails closed
   unless the transaction records exactly that royalty. The Fuji `-28`
   release is never a mainnet target.
10. **[APPROVAL] Configure the sale and the claim signer.**
    - Choose `claimStart` (T, Unix seconds) at least 10 minutes after the claim deployment can be mined.
    - The artist signs `configureSale(tokenId, 250000000000000000, 0, 0, T + 86400, T + 86400 + 604800 - 1, false)`
      on the release's `VoidPrimarySale`. This makes the public phase open at the claim's end, run
      7 days, cost 0.25 AVAX and have no cap.
    - The owner generates the dedicated signer key offline and provides only its public address.
11. **[APPROVAL] Deploy the Genesis claim** (a separate plan and a separate Rabby signature).
    - Actions → *Plan the Genesis holder claim for C-Chain mainnet*. Inputs:
      - `release_contract`, `primary_sale`, `token_id` from step 9;
      - `claim_start=T`;
      - `claim_admin` (the approved admin);
      - `claim_signer_address`;
      - `expected_deployer_address=0xaBd3…c174`;
      - `expected_deployer_nonce`.
    - The plan verifies the release, the sale schedule and the Genesis collection. It refuses a release
      that the artist wallet does not own and administer.
    - The owner signs the single step in Rabby:
      `npm run sign:mainnet -- --kind genesis-claim-mainnet …`. The tool verifies the mined parameters.
12. **[APPROVAL] Authorize the claim to mint.**
    - The artist sends the `grantRole(ISSUER_ROLE, <claim>)` call from the plan's
      `followUps.issuerGrant`, signed in the artist wallet's own session. The plan verified on chain
      that the artist wallet holds the release's `DEFAULT_ADMIN_ROLE`; neither the deployer nor either
      Ledger holds it. Then `npm run verify:mainnet -- --kind genesis-claim-mainnet …` must report
      `issuerGrant: GRANTED`.
    - Enter the `GENESIS_CLAIM_*` values and `GENESIS_CLAIM_SIGNER_PRIVATE_KEY` on
      `the-void-api-mainnet`. Keep `GENESIS_CLAIM_ENABLED=false`.
    - The API refuses to serve the claim (503 `CLAIM_BINDING_MISMATCH`) until the claim holds
      `ISSUER_ROLE`, its signer matches the key and its schedule matches the sale.
13. **[APPROVAL] Real-mainnet acceptance** (below), then **[APPROVAL] coordinated public
    activation**: set `GENESIS_CLAIM_ENABLED=true` at T, point the production domain at the mainnet
    Vercel project, and announce.

### Sync-false values (Render dashboard)

| Key | Service | Value |
| --- | --- | --- |
| `DATABASE_URL` | both | Mainnet Supabase session-pooler URL |
| `PUBLIC_APP_URL`, `AUTH_DOMAIN`, `AUTH_URI`, `API_ALLOWED_ORIGINS` | API | Mainnet web origin; `AUTH_URI` = `<origin>/reliquary` |
| `PINATA_JWT`, `X_*` | API | Same accounts as Fuji |
| `MEDIA_AUDIT_HASH_SECRET` | API | A **new** random secret (≥ 24 characters) |
| `MARKETPLACE_ADDRESS` | both | Mined marketplace |
| `INDEXER_CONTRACTS_JSON` | indexer | `[{"address":"<factory>","contractType":"RELEASE_FACTORY","startBlock":<block>},{"address":"<marketplace>","contractType":"MARKETPLACE","startBlock":<block>,"platformFeeBps":250}]` |
| `GENESIS_CLAIM_CONTRACT`, `GENESIS_CLAIM_RELEASE_CONTRACT`, `GENESIS_CLAIM_PRIMARY_SALE`, `GENESIS_CLAIM_TOKEN_ID`, `GENESIS_CLAIM_START` | API | From steps 9–11 |
| `GENESIS_CLAIM_SIGNER_PRIVATE_KEY` | API | The dedicated signer key (entered by the owner only) |

## Real-mainnet acceptance gate

Every item needs C-Chain transaction hashes plus matching API, database and website state. Unit
tests, fork rehearsals and Fuji transactions do not count. Each test transaction is approved
separately; none is created only to fill this list.

1. **Primary sale.**
   - The artist creates a release, edition and sale; a second wallet buys.
   - The sale contract credits exactly 2.5% to the Nano S Plus and 97.5% to the edition payout.
   - The purchase, ownership and release appear in `/api/releases` and on the website.
   - Proposed vehicle: a small, separately approved verification release, because the Forgive &
     Forget public sale opens only after its claim window.
2. **Secondary sale.**
   - The buyer lists; a third wallet buys.
   - Receipt balances show 2.5% to the artist payout, 2.5% to the Nano S Plus and 95% to the seller.
   - `ListingSold` amounts match; the listing is `SOLD` and ownership has moved in the indexer, API
     and website.
3. **Genesis claim.**
   - An eligible holder connects; the voucher is issued from live ownership; the claim is redeemed.
   - The Forgive & Forget token is minted directly to the claimant, and the ledger row is `REDEEMED`.
   - A repeat claim and a transfer of the used unit are both rejected.
   - The first real claim can only happen once the claim window opens at T. So this journey is proven
     in a **quiet open**: enable at T, the owner's own Genesis wallet claims and is verified, then the
     public announcement. Before T, rehearse the exact deployed contracts on a C-Chain fork. The owner
     approves this sequencing at step 10.
4. **Cross-system consistency.** The website, API, database, indexer and contracts agree on chain
   43114, the recorded addresses, ownership, listings, sales, fee and royalty recipients, and claim
   state. No Fuji address or chain appears in mainnet responses.

## Failure handling, rollback and recovery

- **Wrong immutable value in V2** (recipient, fee): the contracts are ownerless and cannot be
  changed. Do not record them. Deploy a new pair from the deployer's next nonces after a new dry run,
  and record only the correct pair. The predicted-address and device-confirmation gates exist to
  prevent this.
- **Partial V2 deployment** (factory signed and verified, marketplace not): keep the verified factory.
  If the marketplace step was only rejected in Rabby, re-offer it in the same session. If the session
  ended (a closed terminal or browser), restart it with `--resume <factory transaction hash>`. The
  tool verifies the factory from chain against the reviewed plan, then offers only the marketplace,
  behind the same live checks ([`OWNER-SIGNING.md`](./OWNER-SIGNING.md#recovery)).
- **Claim problems before or during the window:**
  - set `GENESIS_CLAIM_ENABLED=false` to stop new vouchers;
  - the claim admin can `pause()` the claim and `setSigner()` to rotate a compromised signer key;
  - the artist can pause the public sale (`configureSale(..., paused=true)`).

  Genesis tokens are only read, never moved, so there is nothing to unwind on the Genesis collection.
- **Backend:** Render deploys are manual. Roll back by redeploying the previous deploy. Database
  recovery relies on Supabase backups; the plan's PITR and backup schedule must be confirmed in the
  dashboard before launch (UNVERIFIED).
- **Marketplace** (ownerless, no pause): if a defect appears, hide trading in the website and API;
  on-chain listings remain the sellers' to cancel.
- **Royalty rule:** it cannot be bypassed or relaxed after deployment. Every creation path of every
  clone and every listing and sale of the marketplace enforces it. Changing the rate would require
  new contracts. Releases from any other factory, Fuji's included, cannot be listed on the mainnet
  marketplace. ERC-2981 is advisory on third-party marketplaces, but `royaltyInfo` of every mainnet
  edition reports exactly 2.5% to its artist.
- **No partial launch:** if any acceptance journey fails, the production domain stays on the Fuji
  project, claims stay disabled and nothing is announced. Fix, re-verify, and request activation
  again.

## Monitoring (owner to confirm before activation)

- Render `notifyOnFail` for both services, and health checks on `/api/health`.
- Watch `/api/health/ready` and `/api/indexer/health?chainId=43114` (checkpoint lag).
- Snowtrace watch on the factory, marketplace, claim and the Nano S Plus.
- Supabase backups and PITR status (UNVERIFIED).
