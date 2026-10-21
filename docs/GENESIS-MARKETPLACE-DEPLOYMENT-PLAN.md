# LegacyCollectionMarketplace — deployment, security gates, rollback, acceptance

Status: NOT DEPLOYED. Nothing here has been broadcast. Every step below needs explicit owner authorization.
Design record: `docs/adr/0001-genesis-legacy-collection-marketplace.md`. Root cause: `GENESIS-RESALE-ROOT-CAUSE.md`.

**Locked policy (owner, 2026-10-21): Genesis resale = 0% platform fee / full existing 5% royalty / 95% seller at the current royalty rate.** The contract has no fee recipient; `platformFeeBps` is the constant 0. Policy record: `GENESIS-ECONOMIC-POLICY-DECISION.md`.

## What exists today (verified)
- Contract `contracts/LegacyCollectionMarketplace.sol`; unit suites + 10 mainnet-fork tests (real Genesis, real operator filter).
- App wiring is inert while `config/legacy-collection-marketplace.json` has `"deployed": false`.
- Read-only readiness check: `node scripts/verify-legacy-marketplace.mjs` (exit 0 ready, 1 mismatch, 2 not deployed).

## Contract properties (what an auditor must confirm)
| Property | Design |
|---|---|
| Custody | None. Seller keeps tokens; marketplace is an approved operator used only inside `buy`. No `receive`/`fallback`. |
| Admin powers | `allowCollection`, `disableCollection`, `setPaused`, two-step `transferOwnership`. No withdraw, no arbitrary call, no upgrade proxy, cannot cancel/alter listings. |
| Platform fee | **None.** `platformFeeBps` is a compile-time constant 0; there is no fee recipient, no fee parameter and no code path that pays the platform. Constructor takes only the owner. |
| Immutable | chain id. |
| Pause / disable | Blocks `createListingWithMinProceeds` and `buy`. `cancelListing` works for the seller (on the deployment chain). |
| Royalty | `royaltyInfo(id, price)` read at listing and sale time by bounds-checked `staticcall` (exactly 64 bytes, clean address word). Must be ≤ the collection's `maxRoyaltyBps` cap (hard ceiling 1000) and, if > 0, to a non-zero receiver that is not the marketplace. Not hardcoded; the cap only protects sellers. |
| Settlement | `S = price·q`; royalty = `royaltyInfo(id, S)` (capped, paid in full); `seller = S − royalty` (seller takes rounding dust); platform fee = 0. Order: floor check, token transfer, royalty, seller. Any failure reverts the whole sale. |
| Seller floor | `minSellerProceedsPerUnit[listingId]`, mandatory and non-zero on every listing (the only creation path is `createListingWithMinProceeds`); a purchase reverts (`BelowMinimumProceeds`) unless the seller nets ≥ floor × quantity at the live royalty. Seller-only updates, never clearable. Listing/event/query shapes unchanged (no new event). |
| Reentrancy | `nonReentrant` on `buy`; listing state is updated before any external call. |

## Parameters (scope confirmed 2026-10-20, fee policy locked 2026-10-21; owner Safe BLOCKED)
- Constructor: `LegacyCollectionMarketplace(owner)` only. Platform fee 0 (no fee recipient).
- `owner`: a Safe, address to be supplied (NOT the deployer EOA). **Required decision — none is recorded in the repo for this contract.**
- Collection: Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE`, tokens `0–3`, `maxRoyaltyBps = 500` (verified current response; Genesis owner can raise it up to 2,500, which would make sales revert until the cap is raised by the Safe or the royalty is lowered). Genesis keeps its own 5% royalty, paid in full; the 2.5% artist royalty and 2.5% platform fee apply to new factory releases only (see ADR).
- Chain: 43114 only.

## Decisions: confirmed vs. still blocking deployment
Confirmed (2026-10-20, fee locked 2026-10-21; not deployment authority): honor Genesis's own 5% royalty in full; tokens 0–3 only; 500 bps cap; **0% platform fee**; target **0 / 5 / 95**; V4 untouched; deployment gate retained.
Still blocking:
1. **Owner Safe address — BLOCKED** (not in the repo; will not be invented; not the deployer). Validate with `OWNER_SAFE_ADDRESS=0x… node scripts/prepare-legacy-marketplace-deployment.mjs` (dry run; exit 3 = BLOCKED).
2. A completed **human audit** with findings resolved — of the **zero-fee** contract (runtime keccak `0x66b52cf1…cdb202`, see audit package §0). The earlier candidate hashes no longer apply.
3. Seller tolerance: zero is retained as the explicit fail-safe default; changing it is a product decision (not a blocker).
4. Explicit deployment authorization and two funded wallets for the acceptance run.

## Human audit package (to hand to a qualified auditor)
The full package — candidate hashes, build instructions, formulas, invariants, admin powers, assumptions, results and checklist — is `docs/GENESIS-MARKETPLACE-AUDIT-PACKAGE.md`. Summary:
- Scope: `contracts/LegacyCollectionMarketplace.sol` (≈300 lines, no dependencies other than a 3-function ERC-1155 interface).
- Spec: `docs/adr/0001-genesis-legacy-collection-marketplace.md` (formulas, trust assumptions, open decisions).
- Tests: `test/LegacyCollectionMarketplace.t.sol` (19), `…MinProceeds.t.sol` (18), `…GenesisPolicy.t.sol` (10, three fuzz), `…ListingPaths.t.sol` (10), fork tests `…MainnetFork.t.sol` (10; need `MAINNET_FORK_RPC`, skipped without it).
- Questions to put to the auditor: reentrancy across `createListingWithMinProceeds`/`cancelListing`/`setMinSellerProceeds` during `buy`; royalty-read assembly (`staticcall`, 100k gas, 64-byte buffer); the floor invariant under partial fills and rounding; forced-AVAX / accounting; interaction with Genesis's operator filter; owner-power liveness (pause/disable/narrow);  the delivery check and the self-purchase rule.
- The two AI reviews recorded in the ADR and audit package are not a substitute for this audit.

## Allowlist vetting rule for any collection (current and future)
Allowlisting is the trust boundary (audit package §8a). Before `allowCollection` for any collection the Safe's signers must confirm: (1) its source is verified and its `royaltyInfo` reads no `gasleft`/`tx.origin`/`block.*`/caller-dependent state; (2) its code is immutable or its upgrade authority is accepted as part of the trust; (3) `node scripts/verify-legacy-marketplace.mjs` (invariance check) passes for every allowlisted token id — a sampling aid, not proof; (4) the cap and token range are the smallest that serve the use. Genesis meets (1)–(2) (immutable EIP-1167 clone of a verified implementation).

## Security gates before any broadcast (all required)
1. Independent human/third-party audit of `LegacyCollectionMarketplace.sol` including the seller-floor logic. The AI reviews recorded in the ADR are not a substitute.
2. Reproducible build: `forge build` with `solc 0.8.24`, optimizer 200 runs (see `foundry.toml`); record the bytecode hash and compare with the verified source after deployment.
3. `forge test` (full suite) and `npm test`, `npm run lint`, both production builds green on the release commit.
4. Owner Safe address and collection scope confirmed in writing; the Safe can sign. (There is no fee recipient.)
5. Fork rehearsal on the deploy commit: `MAINNET_FORK_RPC=<rpc> forge test --match-path test/LegacyCollectionMarketplaceMainnetFork.t.sol`.
6. Deployment plan reviewed under the repo's existing authority rules (`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`, approved-plans). No private key in chat or logs.

## Deployment steps (do not run without authorization)
1. Deploy `LegacyCollectionMarketplace(ownerSafe)` from the authorized deployer. Record the address and block. Read back `platformFeeBps() == 0`; `feeRecipient()` must not exist.
2. Owner Safe calls `allowCollection(Genesis, 500, 0, 3)`.
3. Verify source on the explorer; compare runtime bytecode with the local build.
4. Update `config/legacy-collection-marketplace.json`: `deployed: true`, `marketplaceAddress`, `deploymentBlock`, `ownerAddress`, `record`. One reviewed PR.
5. Run `node scripts/verify-legacy-marketplace.mjs` — must exit 0.
6. Deploy frontend/API/indexer from that commit. Listings from the app use `createListingWithMinProceeds`; confirm the first test listing's `minSellerProceedsPerUnit` view equals the floor shown in the UI. The indexer picks the marketplace up from the manifest (or add it to `INDEXER_CONTRACTS_JSON`); Genesis is already a registered ERC1155 contract (migration 019).

## Rollback / emergency
- Stop new trading immediately: Safe calls `setPaused(true)` (or `disableCollection(Genesis)`). Sellers can still `cancelListing`; nobody's tokens or AVAX are held, so there is nothing to recover.
- UI rollback: revert the manifest PR (`deployed:false`); the LIST FOR SALE action disappears and PR #229 behavior returns. Factory-release trading on V4 is untouched throughout.
- A contract bug means redeploying a fixed marketplace and repointing the manifest; listings on the old one remain cancelable and cannot move tokens once the Safe disables the collection (a stale listing's `buy` reverts).

## Residual risks to accept explicitly
1. Genesis owner (`0x284C…180a`) controls Genesis's operator filter and royalty: filtering this marketplace or raising royalty above the cap stops sales (reverts; nothing is lost).
2. A royalty receiver or seller that rejects AVAX blocks that sale (reverts by design).
3. Buyer front-running tolerance: the exact `msg.value` equals price × quantity, so a royalty change cannot overcharge the buyer; it can only make the sale revert or reduce the seller's proceeds up to the cap.

## Production acceptance procedure (BLOCKED until funded wallets and a deployment exist)
Needs: deployed marketplace, a real Genesis holder wallet (seller), a second funded wallet (buyer), and a third address for plain-transfer checks.
1. Seller opens the Genesis edition; UI shows LIST FOR SALE; seller approves the marketplace and lists 1 unit at a small price (e.g. 0.01 AVAX). Record txs.
2. Indexer/API: listing visible via the API to an unrelated account; `ListingCreated` event at the manifest address.
2b. Read `minSellerProceedsPerUnit(listingId)` on-chain and confirm it equals `⌊price·(10000−500)/10000⌋` (95% at today's royalty).
3. Buyer purchases 1 unit. Record tx. Verify from the receipt/`ListingSold`: `platformFee` = 0 and the platform wallet's balance is unchanged, royalty = 5% to `0x284C…180a`, seller = 95%; token balances (`balanceOf`) moved; no AVAX left in the marketplace.
4. Failed-purchase check: attempt an underpayment (wrong `msg.value`) — must revert with nothing moved. (The royalty-increase revert needs the Genesis owner's cooperation and is rehearsed only on the fork; do not ask the real Genesis owner to change royalties for a test without their explicit consent.)
5. Plain transfer between two wallets still works.
6. Cancellation: seller lists again and cancels; status `CANCELLED` in API.
7. Factory-release listing/purchase on V4 re-verified unchanged (2.5% platform / 2.5% artist royalty / 95% seller).
Record every transaction hash and block here; do not mark COMPLETE without them.
