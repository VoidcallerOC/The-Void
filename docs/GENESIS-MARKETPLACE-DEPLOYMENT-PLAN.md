# LegacyCollectionMarketplace — deployment, security gates, rollback, acceptance

Status: NOT DEPLOYED. Nothing here has been broadcast. Every step below needs explicit owner authorization.
Design record: `docs/adr/0001-genesis-legacy-collection-marketplace.md`. Root cause: `GENESIS-RESALE-ROOT-CAUSE.md`.

## What exists today (verified)
- Contract `contracts/LegacyCollectionMarketplace.sol`; 18 unit tests + 4 mainnet-fork tests (real Genesis, real operator filter).
- App wiring is inert while `config/legacy-collection-marketplace.json` has `"deployed": false`.
- Read-only readiness check: `node scripts/verify-legacy-marketplace.mjs` (exit 0 ready, 1 mismatch, 2 not deployed).

## Contract properties (what an auditor must confirm)
| Property | Design |
|---|---|
| Custody | None. Seller keeps tokens; marketplace is an approved operator used only inside `buy`. No `receive`/`fallback`. |
| Admin powers | `allowCollection`, `disableCollection`, `setPaused`, two-step `transferOwnership`. No withdraw, no arbitrary call, no upgrade proxy, cannot cancel/alter listings. |
| Immutable | fee 250 bps, fee recipient, chain id. Constructor reverts on any other fee. |
| Pause / disable | Blocks `createListing` and `buy`. `cancelListing` always works for the seller. |
| Royalty | `royaltyInfo(id, price)` read at listing and sale time by bounds-checked `staticcall` (exactly 64 bytes, clean address word). Must be ≤ the collection's `maxRoyaltyBps` cap (hard ceiling 1000) and, if > 0, to a non-zero receiver that is not the marketplace. Not hardcoded; the cap only protects sellers. |
| Settlement | `fee = ⌊price·250/10000⌋`; royalty as reported; `seller = price − fee − royalty` (seller takes rounding dust). Order: token transfer, fee, royalty, seller. Any failed transfer reverts the whole sale. |
| Reentrancy | `nonReentrant` on `buy`; listing state is updated before any external call. |

## Parameters proposed for owner approval
- `feeRecipient`: `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` (same as V4).
- `platformFeeBps`: `250`.
- `owner`: a Safe, address to be supplied (NOT the deployer EOA). **Required decision — none is recorded in the repo for this contract.**
- Collection: Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE`, tokens `0–3`, `maxRoyaltyBps = 500` (verified current response; Genesis owner can raise it up to 2,500, which would make sales revert until the cap is raised by the Safe or the royalty is lowered).
- Chain: 43114 only.

## Security gates before any broadcast (all required)
1. Independent human/third-party audit of `LegacyCollectionMarketplace.sol`. The AI review recorded in the PR is not a substitute.
2. Reproducible build: `forge build` with `solc 0.8.24`, optimizer 200 runs (see `foundry.toml`); record the bytecode hash and compare with the verified source after deployment.
3. `forge test` (full suite) and `npm test`, `npm run lint`, both production builds green on the release commit.
4. Owner Safe address, fee recipient and collection scope confirmed in writing; the Safe can receive AVAX and sign.
5. Fork rehearsal on the deploy commit: `MAINNET_FORK_RPC=<rpc> forge test --match-path test/LegacyCollectionMarketplaceMainnetFork.t.sol`.
6. Deployment plan reviewed under the repo's existing authority rules (`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`, approved-plans). No private key in chat or logs.

## Deployment steps (do not run without authorization)
1. Deploy `LegacyCollectionMarketplace(feeRecipient, 250, ownerSafe)` from the authorized deployer. Record the address and block.
2. Owner Safe calls `allowCollection(Genesis, 500, 0, 3)`.
3. Verify source on the explorer; compare runtime bytecode with the local build.
4. Update `config/legacy-collection-marketplace.json`: `deployed: true`, `marketplaceAddress`, `deploymentBlock`, `ownerAddress`, `record`. One reviewed PR.
5. Run `node scripts/verify-legacy-marketplace.mjs` — must exit 0.
6. Deploy frontend/API/indexer from that commit. The indexer picks the marketplace up from the manifest (or add it to `INDEXER_CONTRACTS_JSON`); Genesis is already a registered ERC1155 contract (migration 019).

## Rollback / emergency
- Stop new trading immediately: Safe calls `setPaused(true)` (or `disableCollection(Genesis)`). Sellers can still `cancelListing`; nobody's tokens or AVAX are held, so there is nothing to recover.
- UI rollback: revert the manifest PR (`deployed:false`); the LIST FOR SALE action disappears and PR #229 behavior returns. Factory-release trading on V4 is untouched throughout.
- A contract bug means redeploying a fixed marketplace and repointing the manifest; listings on the old one remain cancelable and cannot move tokens once the Safe disables the collection (a stale listing's `buy` reverts).

## Residual risks to accept explicitly
1. Genesis owner (`0x284C…180a`) controls Genesis's operator filter and royalty: filtering this marketplace or raising royalty above the cap stops sales (reverts; nothing is lost).
2. A royalty receiver, seller or fee recipient that rejects AVAX blocks that sale (reverts by design).
3. Buyer front-running tolerance: the exact `msg.value` equals price × quantity, so a royalty change cannot overcharge the buyer; it can only make the sale revert or reduce the seller's proceeds up to the cap.

## Production acceptance procedure (BLOCKED until funded wallets and a deployment exist)
Needs: deployed marketplace, a real Genesis holder wallet (seller), a second funded wallet (buyer), and a third address for plain-transfer checks.
1. Seller opens the Genesis edition; UI shows LIST FOR SALE; seller approves the marketplace and lists 1 unit at a small price (e.g. 0.01 AVAX). Record txs.
2. Indexer/API: listing visible via the API to an unrelated account; `ListingCreated` event at the manifest address.
3. Buyer purchases 1 unit. Record tx. Verify from the receipt/`ListingSold`: fee = 2.5%, royalty = 5% to `0x284C…180a`, seller = 92.5%; token balances (`balanceOf`) moved; no AVAX left in the marketplace.
4. Failed-purchase check: attempt an underpayment (wrong `msg.value`) — must revert with nothing moved.
5. Plain transfer between two wallets still works.
6. Cancellation: seller lists again and cancels; status `CANCELLED` in API.
7. Factory-release listing/purchase on V4 re-verified unchanged.
Record every transaction hash and block here; do not mark COMPLETE without them.
