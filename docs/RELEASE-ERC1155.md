# The-Void Release ERC-1155

`VoidRelease1155` is the platform issuance contract for the music-native domain model **Artist → Release → Edition → Experience → Collect**. It is separate from `MusicMarketplace.sol` and does not perform listings, purchases, settlement, or royalties. The certified Fuji deployment of this contract is unchanged.

## ERC-1155 V2 and primary sale

`VoidRelease1155` is not upgradeable. `VoidRelease1155V2` is a new deployment with the same edition, role, and metadata behavior, plus ERC-2981. The token standard stays ERC-1155. There is no ERC-20 and no conversion to ERC-721.

`royaltyInfo` returns the edition payout address and `salePrice * royaltyBps / 10_000`. Royalty basis points are set in `createEdition` and capped at 1000 (10%). The 4-argument `createEdition` still exists and records the artist as the payout with a zero royalty. `MusicMarketplace` already queries `royaltyInfo` and pays zero when the call reverts, which is what the certified V1 deployment does. Resale royalties require the marketplace to be pointed at V2. This change does not deploy `MusicMarketplace`.

`VoidPrimarySale` is a separate contract. The release admin grants it `ISSUER_ROLE`. An artist configures only their own edition: price in AVAX wei, sale supply, per-wallet limit, optional start and end times, and a pause flag. `purchase` requires the exact AVAX amount, checks supply, wallet limit, and the time window, then mints the ERC-1155 to the buyer. Proceeds are pull payments. The platform fee is capped by the constructor basis points. The owner can lower it and can raise it back up to that cap, but cannot exceed the cap.

V2 and the sale contract are not deployed by committing this source. `config/fuji-release.json` stays on the certified V1 address until an operator runs the Fuji script below.

## Implementation

The contract targets Solidity **0.8.24**, with Foundry optimizer settings of **200 runs** in `foundry.toml`. It is intentionally self-contained for this repository's minimal toolchain and implements the ERC-1155 surface needed by The-Void: balances, batch balances, approvals, safe single/batch transfers, metadata URI, ERC-165/ERC-1155 interface support, and standard `TransferSingle`/`TransferBatch` events. Protected audio, video, stems, and downloads remain behind the existing authenticated media service.

Each edition stores only its `releaseId`, `editionId`, artist, finite `maxSupply`, `mintedSupply`, and public metadata URI. Metadata is immutable after creation. Unlimited editions are intentionally unsupported for the first release contract so that supply and indexer projections remain explicit.

## Token IDs and roles

The token ID is deterministic and independent of database row order:

```text
uint256(keccak256(abi.encode("the-void:edition:v1", releaseId, editionId)))
```

The zero result is remapped to `1`, and a second edition with the same pair is rejected. `DEFAULT_ADMIN_ROLE` is the administrative authority for role grants, revocations, and pause state. `ARTIST_ROLE` authorizes edition creation, while `ISSUER_ROLE` authorizes minting. `ISSUER_ROLE` is currently a trusted platform-level role; it is not automatically restricted to the artist recorded on an edition. The deployer is initially granted all three roles so that a deployment can bootstrap safely; production operations should grant artist and issuer roles to dedicated accounts and use role revocation for rotation. An admin may renounce its own administrative access, with no recovery mechanism intentionally built into this first deployment. Collectors receive standard ERC-1155 transfers and have no issuance authority.

Minting rejects zero quantities, nonexistent editions, paused state, and quantities above the remaining finite supply. The contract has no metadata update or arbitrary burn function, which avoids silent provenance and supply changes in the initial platform release.

## Indexer configuration

The indexer decodes standard ERC-1155 transfer topics into `blockchain_events`, `transfers`, and `ownership_snapshots`. Primary sales are a separate indexer contract type, `PRIMARY_SALE`, and require `tokenAddress` set to the ERC-1155 release. A `Purchased` log writes `primary_purchases` and credits ownership on that ERC-1155. The matching mint `TransferSingle` is stored, but ownership is not credited again when the operator is the sale contract. `/api/health/ready` reports both the ERC-1155 release and the primary sale and is not ready unless both checkpoints are `IDLE` or `RUNNING`.

After a **real** Fuji deployment of V2 and the sale, configure the environment with the actual addresses and deployment blocks. Do not use a placeholder address or start from block zero:

```json
[
  {"address":"<V2_ADDRESS>","contractType":"ERC1155","startBlock":<V2_BLOCK>},
  {"address":"<SALE_ADDRESS>","contractType":"PRIMARY_SALE","tokenAddress":"<V2_ADDRESS>","startBlock":<SALE_BLOCK>}
]
```

The contract-specific configuration belongs in `INDEXER_CONTRACTS_JSON`. Do not edit production configuration in source control as part of a local build. Restart the indexer after configuration. Duplicate handling and checkpoint/restart behavior stay keyed by chain, transaction hash, and log index.

## Fuji deployment

Build and test locally first:

```bash
forge build
forge test
npm test
npm run lint
npm run build
```

The V1 deployment command is deliberately explicit and Fuji-only. It does not rewrite `config/fuji-release.json`:

```bash
AVALANCHE_FUJI_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
RELEASE_ADMIN_ADDRESS=0x... \
node scripts/deploy-release.mjs
```

V2 plus the primary sale, still Fuji only, still ERC-1155, and not run by this change:

```bash
DEPLOY_NETWORK=fuji \
AVALANCHE_FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc \
DEPLOYER_PRIVATE_KEY=... \
RELEASE_ADMIN_ADDRESS=0x... \
PLATFORM_FEE_RECIPIENT=0x... \
PLATFORM_FEE_BPS=250 \
npm run deploy:release-v2
```

`RELEASE_ADMIN_ADDRESS` must be the deployer, because the script grants `ISSUER_ROLE` to `VoidPrimarySale`. The script refuses a non-Fuji chain, a mainnet RPC, and chain id 43114. It rewrites `config/fuji-release.json` with the V2 address and the sale address. After that rewrite, update the tests and README rows that pin `VoidRelease1155` at `0x262B774cf9a1949170B58E2d57F6189980FE757b`, then commit the new config. Independently verify both receipts on the Fuji explorer before starting the indexer. This change does not deploy anything, does not deploy `MusicMarketplace`, and does not modify mainnet configuration.
