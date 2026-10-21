# Unified marketplace: architecture, evidence and deployment readiness (2026-10-21)

STATUS: PARTIAL. Code and tests are ready for owner review. Nothing is deployed. No transaction was signed or
broadcast, no on-chain value was changed, and no production configuration was activated.

## 1. Baseline

| Item | Value |
|---|---|
| Branch / base | `claude/void-unified-marketplace-ox3ldz` from `main` `6f014c8` (clean worktree) |
| Live reads | `api.avax.network`, blocks 98151165–98152363, read-only `eth_call` |
| Production factory `0x262B…757b` | `releaseCount() = 1` (F&F original `0x9aa6…d103`) |
| Production marketplace `0x0e77…F8f5` | `nextListingId() = 1`: **no listing was ever created** |
| Genesis `0xD1B4…98eE` | `royaltyInfo(id, 1e18) = (0x284C…180a, 5e16)` for ids 0, 3 and 4; operator filter `0x0000…AAeB6D7670E522A718067333cd4E` |
| Deployer `0xaBd3…c174` | nonce 3, nothing pending, 0.3968 AVAX |
| Approved plan before this PR | PR #240 (Gate B): factory + `ReleaseMarketplaceV4` bound to it. Not signed. |

PRs: #231, #234, #237, #238, #239, #240 are merged into `main`. #241 (Genesis 0/5/95 on a separate
`LegacyCollectionMarketplace`) is an open draft and is **superseded** by this PR (left open for the owner to close).

## 2. Why ReleaseMarketplaceV4 rejects Genesis

`ReleaseMarketplaceV4.registry` is immutable and every entry point calls `registry.isRelease(token)`; Genesis is
not a factory release, and it has no `royaltyBpsOf`/`payoutOf`. A V4 instance can serve exactly one factory.

## 3. Architecture: `contracts/VoidUnifiedMarketplace.sol`

One ownerless contract. All configuration is immutable (no owner, no setter, no pause, no growable allowlist).
`assetClassOf(token, id)` classifies from immutables only, in this order:

1. `token == genesisCollection` → `GENESIS` if `id <= genesisMaxTokenId`, otherwise `UNSUPPORTED`.
   No registry is consulted for this address, so factory economics can never apply to Genesis.
2. `releaseFactory.isRelease(token)` or `legacyReleaseFactory.isRelease(token)` → `FACTORY_RELEASE`.
   A reverting/malformed registry answer counts as "not registered".
3. Anything else → `UNSUPPORTED` (revert `UnsupportedAsset`).

The Genesis exception is an equality check on one immutable address, so it cannot admit any other contract,
and it never skips the registry or the royalty-policy check for a factory release.

Settlement (`_settlement`), same sale-price basis (`price × quantity`) for every amount:

| Class | Platform | Royalty | Seller | Royalty checks |
|---|---|---|---|---|
| FACTORY_RELEASE | 250 bps to `feeRecipient` | 250 bps to `payoutOf(id)` | remainder (95% + dust) | `royaltyBpsOf == 250`, payout ≠ 0 / fee recipient / marketplace, ERC-2981 must report the same receiver and amount |
| GENESIS | 0 | 500 bps to `genesisRoyaltyReceiver` | remainder (95% + dust) | ERC-2981 must report exactly that receiver and exactly 500 bps; bounded `staticcall` (100k gas, exactly 64 bytes, clean address word) |

Common rules (kept from V4 and from `LegacyCollectionMarketplace`): seller must be `msg.sender`, balance and
approval checked at listing and purchase, settlement validated at listing for 1 unit and the full quantity, expiry,
seller-only cancel, `ListingNotActive` replay protection, self-purchase refused, effects before calls,
`nonReentrant`, NFT delivery verified by the buyer's balance delta, any failed payout or delivery reverts the whole
sale. Events: V4-identical `ListingCreated/Cancelled/Expired/Sold` (existing indexer decodes them unchanged) plus
`SaleSettled(listingId, assetClass, royaltyReceiver, sellerProceeds)`.

Untouched: Genesis (never written; `setRoyaltyInfo` is never called), `GenesisHolderClaim`, the production factory,
its releases and sales, `0x0e77…`, `VoidReleaseFactoryV2RoyaltySettled` (byte-identical init code to PR #240's plan).

## 4. Economic matrix

| Sale | Platform | Artist / royalty | Seller | Mechanism |
|---|---|---|---|---|
| Corrected-factory primary | 2.5% pushed in the purchase tx (reverts if the transfer fails) | 97.5% claimable via `withdraw()` | — | `VoidPrimarySaleSettled` (PR #231/#234, unchanged) |
| Factory secondary (both factories) | 2.5% | 2.5% to edition payout | 95% | `VoidUnifiedMarketplace.buy`, all push, atomic |
| Genesis secondary | 0% | 5% to `0x284C…180a` | 95% | `VoidUnifiedMarketplace.buy`, all push, atomic |
| Production-factory primary (historical) | 2.5% **credited**, not pushed | 97.5% credited | — | `VoidPrimarySale` (unchanged) |

## 5. Test evidence (commands run in this session)

| Command | Result |
|---|---|
| `forge test` | 42 suites, **379 passed, 0 failed, 20 skipped** (fork suites skip without RPC) |
| `MAINNET_FORK_RPC=https://api.avax.network/ext/bc/C/rpc forge test` | **400 passed, 0 failed, 7 skipped** (pre-existing self-skips) |
| `forge test --match-contract VoidUnifiedMarketplaceTest` | 30 passed (2 fuzz × 256 runs) |
| `… --match-contract VoidUnifiedMarketplaceMainnetFork` (fork ≈ block 98151165) | 3 passed: real Genesis 0/5/95 through its real operator filter, royalty unchanged after; Genesis owner raising royalty refuses the sale; real production factory release and corrected factory release both settle 2.5/2.5/95 |
| `npx vitest run` | 191 files, **2040 passed, 0 failed, 87 skipped** (baseline before this change: 2033 + 7 new) |
| `npm run lint` | clean |
| `npm run build` | built |
| `npm run db:validate:migrations` | NOT RUN (needs Postgres; no migration changed) |

New tests: `test/VoidUnifiedMarketplace.t.sol` (balance deltas for all three paths; rounding at 1, 39, 41, 399,
1e30 wei and fuzzed; overflow; arbitrary, look-alike-Genesis, out-of-range-id, fake-factory, lying and reverting
registries; adversarial ERC-2981 (revert, short, dirty address, ×2, gas burn, wrong receiver, 6%, 4%); platform /
seller rejecting AVAX; reentrant royalty receiver and seller; token receiver rejecting; token that does not deliver;
replay, stale approval/balance, expiry, wrong chain, partial fills; primary push / single claim / atomic revert),
`test/VoidUnifiedMarketplaceMainnetFork.t.sol`, `src/lib/unified-marketplace.test.js` (manifest, classification,
routing, listing preflight, indexer config, per-asset fee validation, `SaleSettled` decoding).

Limits: unit and fork tests prove contract behaviour at the fork block, not any live transaction. No browser E2E
of the listing UI against a deployed unified marketplace exists (none can until it is deployed).

## 6. Security findings

| Finding | Status |
|---|---|
| V4's single immutable registry cannot serve Genesis or two factories | Remediated by design (two immutable registries + one pinned Genesis) |
| Genesis is an upgradeable proxy with an owner-settable royalty (up to 2,500 bps) | Mitigated: exact 500 bps and pinned receiver, else the sale reverts (fork-tested). Residual: a proxy upgrade could still lie about balances/transfers; delivery is verified by balance delta, which an actively malicious proxy could also fake. Genesis is a trust assumption, as before. |
| Genesis operator filter (OpenSea registry) could block the new address | Not blocked at the fork block (fork test lists through the real filter). Residual: the filter owner can block it later; the listing preflight surfaces this before approval. |
| Pinned Genesis receiver: if its owner legitimately changes the receiver, Genesis resale stops | Accepted, fail-closed. Requires a new marketplace deployment to change. |
| Historical primary platform credit not pushed (production `VoidPrimarySale`) | Documented in §9; not moved. |

## 7. Deployment plan (supersedes PR #240's step 2)

`deploy/mainnet/approved-plans/release-per-contract-mainnet.json`, kind `release-per-contract-mainnet`, bound to
source commit `d0bb8827930f42b096e55665009bf0a947db4863`, digest
`425a56f98cb4ccda79fc8fadd52a26a8076691f053eaef0ccf742ec9350aec6d`. Merging the PR is the owner's approval of these
exact transactions (repository convention); it does not sign or broadcast anything.

| Step | Nonce | Contract | Constructor | Predicted address | Init code hash | Est. gas |
|---|---|---|---|---|---|---|
| 1 | 3 | `VoidReleaseFactoryV2RoyaltySettled` | `platformRecipient = 0xb65C…1ce4` | `0xE744D58fA8138042f5f00a28d39f89081539C19B` (implementation `0x36c5D31e9A8e9b4dc9F8CB4B7202C70b3E30734D`) | `0xdf03ecde…1c0f6e` (identical to PR #240) | 5,446,177 |
| 2 | 4 | `VoidUnifiedMarketplace` | `feeRecipient 0xb65C…1ce4`, `releaseFactory 0xE744…C19B`, `legacyReleaseFactory 0x262B…757b`, `genesisCollection 0xD1B4…98eE`, `genesisMaxTokenId 3`, `genesisRoyaltyReceiver 0x284C…180a` | `0x75964C44cA586b13e98e7c30E74d2B4114f65b06` | `0x073c9523…2bc324f` | 1,873,984 |

Chain 43114, deployer `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, est. cost 0.0493 AVAX (0.0740 with headroom;
balance 0.3968). No post-deployment role or ownership transactions: both contracts are ownerless.
`scripts/mainnet-onchain-checks.mjs` re-reads every marketplace immutable after step 2 and refuses a mismatch.

Activation after both steps are verified and recorded (one coherent change, in this order):
1. `deployments/release-per-contract-mainnet-0xE744….json` (written by the signing tool from verified receipts).
2. `config/mainnet-release-per-contract.json`: factory `0xE744…`, marketplace `0x7596…`, blocks; move the
   `0x262B…`/`0x0e77…` pair into `historicalDeployments`.
3. `config/unified-marketplace.json`: `deployed: true`, `marketplaceAddress 0x7596…`, `deploymentBlock`,
   `releaseFactoryAddress 0xE744…`, `record`.
4. Vercel `VITE_MARKETPLACE_ADDRESS=0x7596…` (the buy target check requires it); indexer redeploy (it picks the
   unified marketplace up from the manifest with the per-asset fee policy). Studio `createRelease` targets the active
   factory from the manifest.
5. Leave `config/legacy-collection-marketplace.json` at `deployed: false` (never deploy `LegacyCollectionMarketplace`).

Recovery: before any listing, revert the activation commit and env var; the old pair keeps working (it has no
listings). Confirmed deployments cannot be rolled back; ownerless contracts cannot be paused, so the app-level
switch is the only control, and artists can pause their own primary sales.

Immediately before signing: re-run the plan (`npm run owner:deploy` / `scripts/mainnet-owner-signing.mjs`), confirm
nonce 3 with nothing pending; if the nonce moved, every predicted address changes and the plan must be re-approved.

## 8. Existing contract compatibility

- Production-factory releases (F&F original) trade on the unified marketplace with 2.5/2.5/95 (fork-tested with
  the real factory bytecode). They also remain listable on `0x0e77…`, which has no listings, so no migration is needed.
- Holder rights and media access are unaffected: no token contract changes; access reads balances, not marketplaces.
- Genesis: unchanged; resale becomes possible only on the unified marketplace.
- Listing ids restart at 1 per marketplace; the API keys listings by marketplace address.

## 9. Historical payment reconciliation (read-only, block ≈ 98152363)

| Contract | Fact |
|---|---|
| F&F sale `0x6ae84A51F100f10f0535A514555043ae9eDf9aA3` (`VoidPrimarySale`) | `balances(0xb65C…1ce4) = 0.00625 AVAX` credited, not transferred; contract balance = exactly 0.00625 AVAX; `balances(0x284C…180a) = 0` |

Owner action (not done): from `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`, call `withdraw()` on
`0x6ae84A51F100f10f0535A514555043ae9eDf9aA3`. Prerequisite: that wallet signs on C-Chain and holds gas.
Whether other payout wallets were paid is UNVERIFIED here beyond the contract balance being fully explained by the
platform credit.

## 10. Go / no-go

- Code readiness: **GO for owner review.**
- Deployment readiness: **BLOCKED on owner actions**: review and merge (approval of the plan), independent review
  of `VoidUnifiedMarketplace` (new contract, no external audit), nonce re-check, physical confirmation of the fee
  recipient on the device, then owner-signed steps 1 and 2.
- Live production verification: **NOT STARTED.** Needs deployed contracts, activation, and a real list/buy for each
  of the three paths with recipient balance deltas read from chain.
