# The-Void Release ERC-1155

`VoidRelease1155` is the platform issuance contract for the music-native domain model **Artist → Release → Edition → Experience → Collect**. It is separate from `MusicMarketplace.sol` and does not perform listings, purchases, settlement, or royalties.

## Implementation

The contract targets Solidity **0.8.24**, with Foundry optimizer settings of **200 runs** in `foundry.toml`. It is intentionally self-contained for this repository's minimal toolchain and implements the ERC-1155 surface needed by The-Void: balances, batch balances, approvals, safe single/batch transfers, metadata URI, ERC-165/ERC-1155 interface support, and standard `TransferSingle`/`TransferBatch` events. Protected audio, video, stems, and downloads remain behind the existing authenticated media service.

Each edition stores only its `releaseId`, `editionId`, artist, finite `maxSupply`, `mintedSupply`, and public metadata URI. Metadata is immutable after creation. Unlimited editions are intentionally unsupported for the first release contract so that supply and indexer projections remain explicit.

## Token IDs and roles

The token ID is deterministic and independent of database row order:

```text
uint256(keccak256(abi.encode("the-void:edition:v1", releaseId, editionId)))
```

The zero result is remapped to `1`, and a second edition with the same pair is rejected. `DEFAULT_ADMIN_ROLE` grants and revokes `ARTIST_ROLE` and `ISSUER_ROLE`. An artist creates editions, while an issuer mints them. The deployer is initially granted all three roles so that a deployment can bootstrap safely; production operations should grant artist and issuer roles to dedicated accounts and use role revocation for rotation. Collectors receive standard ERC-1155 transfers and have no issuance authority.

Minting rejects zero quantities, nonexistent editions, paused state, and quantities above the remaining finite supply. The contract has no metadata update or arbitrary burn function, which avoids silent provenance and supply changes in the initial platform release.

## Indexer configuration

The existing indexer already decodes standard ERC-1155 transfer topics and projects them into `blockchain_events`, `transfers`, and `ownership_snapshots`. After a **real** Fuji deployment, configure the environment with the actual address and deployment block; do not use the historical placeholder address or start from block zero:

```json
[{"address":"<REAL_FUJI_ADDRESS>","contractType":"ERC1155","startBlock":<DEPLOYMENT_BLOCK>,"eventTopics":{}}]
```

The contract-specific configuration belongs in `INDEXER_CONTRACTS_JSON`. Do not edit production configuration in source control as part of a local build. The indexer must be restarted after configuration and verified with real `TransferSingle` and `TransferBatch` transactions. Duplicate handling and checkpoint/restart behavior are already keyed by chain, transaction hash, and log index in the existing persistence layer.

## Fuji deployment

Build and test locally first:

```bash
forge build
forge test
npm test
npm run lint
npm run build
```

The deployment command is deliberately explicit and Fuji-only:

```bash
AVALANCHE_FUJI_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
RELEASE_ADMIN_ADDRESS=0x... \
node scripts/deploy-release.mjs
```

It writes `deployments/release-fuji.json` with the address, transaction hash, block when returned by Forge, chain ID `43113`, admin, and bytecode hash. A deployment record is not evidence by itself: independently verify the transaction receipt and deployed bytecode against Fuji RPC before configuring the indexer. This change does not deploy anything, change Render disks, mutate production configuration, or modify the existing Voidcaller C-Chain contract.
