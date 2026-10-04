# The Void — Avalanche C-Chain Production Runbook

This runbook is for the **V2 release path only**:

- chain: Avalanche C-Chain (`43114`)
- release: `VoidRelease1155V2`
- primary sale: `VoidPrimarySale`
- provenance: `VoidProvenanceAnchor`
- legacy collection `0xd1b4367dd9f235f9ee61878019d66e31511e98ee`: **out of scope**

Fuji (`43113`) remains the staging environment and must not be repointed.

## 0. Current go/no-go status

**NO-GO.** `config/mainnet-release.json` is intentionally incomplete because no real C-Chain deployment has been performed. Do not replace nulls with placeholders.

The current reviewed `contracts/VoidPrimarySale.sol` exposes `owner` but does not expose `transferOwnership(address)`. The mainnet deployment script therefore refuses to broadcast before deployment. This is intentional: the required Safe ownership handoff cannot be proven with the current contract artifact. A reviewed contract change adding a safe ownership transfer path, followed by Solidity review and regression tests, is required before deployment readiness.

## 1. Prerequisite checks

Record evidence for each item in the release ticket:

- [ ] certified commit SHA is checked out and PR #127 remains open/unmerged
- [ ] `forge build`, `forge test`, `npm test`, `npm run lint`, and `npm run build` pass
- [ ] RPC endpoint is an HTTPS Avalanche C-Chain endpoint and reports chain ID `43114`
- [ ] deployer EOA is known, funded, and not the Safe
- [ ] `ADMIN_SAFE_ADDRESS` is the intended Safe and is not zero
- [ ] `PLATFORM_FEE_RECIPIENT` and reviewed `PLATFORM_FEE_BPS` are approved
- [ ] no legacy collection address appears in release configuration
- [ ] `config/mainnet-release.json` still has `deployed: false` and null deployment fields before broadcast

Required secrets are supplied only through the workflow secret manager:

```text
AVALANCHE_MAINNET_RPC_URL
DEPLOYER_PRIVATE_KEY
RELEASE_ADMIN_ADDRESS
ADMIN_SAFE_ADDRESS
PLATFORM_FEE_RECIPIENT
PLATFORM_FEE_BPS
```

## 2. Deployer and Safe verification

Before any broadcast, verify locally and in the workflow:

```bash
DEPLOY_NETWORK=mainnet CONFIRM_MAINNET_DEPLOY=yes npm run deploy:release-v2-mainnet
```

The script must stop before broadcast if the chain, funding, artifact, or Safe gates fail. Never paste private keys into logs or chat.

## 3. C-Chain deployment

Use `.github/workflows/deploy-release-v2-mainnet.yml` with the exact confirmation input:

```text
I_CONFIRM_MAINNET_DEPLOY
```

The deployment path creates only the reviewed release, sale, and provenance-anchor contracts. It does not deploy or modify the marketplace or legacy collection.

## 4. Role and ownership handoff

The deployment must verify on-chain, after receipts are mined:

- `VoidRelease1155V2.DEFAULT_ADMIN_ROLE` is held by the Safe
- deployer no longer holds `DEFAULT_ADMIN_ROLE`
- deployer no longer holds `ARTIST_ROLE` or `ISSUER_ROLE`
- `VoidPrimarySale.owner()` is the Safe
- `VoidPrimarySale.releases()` equals the deployed release address
- `VoidProvenanceAnchor.releaseContract()` equals the deployed release address

If any read differs, stop. Do not record the deployment as production-ready.

## 5. Configuration recording

Only after successful receipts and verification, the script atomically records real values in `config/mainnet-release.json`:

- deployment addresses, transactions, and blocks
- issuer grant transaction
- provenance anchor address, transaction, and block
- Safe address and handoff transactions
- reviewed fee recipient and fee basis points

Never record guessed blocks, addresses, transaction hashes, or provenance evidence.

## 6. Production environment switch

Switch the application only after the deployment record is reviewed:

```text
RELEASE_NETWORK=mainnet
VITE_RELEASE_NETWORK=mainnet
INDEXER_CHAIN_ID=43114
INDEXER_RPC_URL=<reviewed C-Chain RPC>
INDEXER_CONTRACTS_JSON=<only the recorded V2 release and primary-sale contracts>
PROVENANCE_ANCHOR_CHAIN_ID=43114
PROVENANCE_ANCHOR_NETWORK=mainnet
PROVENANCE_RELEASE_CONTRACT=<recorded V2 release address>
PROVENANCE_ANCHOR_ADDRESS=<recorded anchor address>
PROVENANCE_ANCHOR_RPC_URL=<reviewed C-Chain RPC>
AUTH_ALLOWED_CHAIN_IDS=43114
```

The API and frontend must be released as one network-consistent change. Fuji auth, Fuji indexer contracts, and the legacy C-Chain collection must not be mixed into this environment.

## 7. Private test mint

Using a dedicated test artist wallet and a private metadata URI:

1. create one small private edition through the reviewed publishing flow
2. verify `EditionCreated` and the deterministic token ID
3. verify the edition artist and payout address
4. record the transaction and block
5. do not publish the test asset in the public catalog

## 8. Pause test and unpause

With Safe-controlled administration:

1. pause the release contract
2. prove a protected mutation reverts while paused
3. record the pause transaction and receipt
4. unpause through the Safe
5. prove the protected mutation resumes
6. record both receipts

## 9. Primary-sale test

Configure a bounded sale with the approved fee settings, then verify:

- purchase mints the expected ERC-1155 balance
- payment equals price times quantity
- platform and artist pull-payment balances are correct
- wrong payment, zero quantity, pause, sold-out, and wallet-limit cases fail closed
- withdrawals succeed only for recorded balances

## 10. Indexer verification

After the configured confirmation depth:

- confirm both contract addresses and exact start blocks
- confirm `ERC1155` and `PRIMARY_SALE` event projections
- confirm ownership snapshots and synchronization watermark
- confirm no Fuji or legacy contract appears in the mainnet worker configuration

## 11. Provenance verification

For the private test edition:

1. publish the canonical provenance manifest
2. prepare the anchor calldata
3. submit the artist-signed transaction to the recorded anchor address
4. verify chain ID, target, signer, calldata, receipt, event, block timestamp, and `isAnchored` state
5. record the anchor transaction and block

A prepared or pending transaction is **not** verified provenance.

## 12. Go/no-go decision

**GO** requires all of the following evidence:

- real `43114` deployment receipts
- bytecode and artifact review
- Safe admin and sale-owner reads
- deployer role renouncement reads
- real provenance anchor event and state read
- private mint, pause/unpause, and primary-sale tests
- indexer and readiness evidence
- production configuration review showing no mixed-network values

Any missing evidence is **NO-GO**. Keep `config/mainnet-release.json` incomplete and keep the production gate closed.
