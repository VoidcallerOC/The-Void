# Mainnet payment fix: verified findings and activation checklist

Status: **PARTIAL**. Repository code and tests are written and verified locally and on forks. Nothing has been deployed, signed, transacted or changed in production. Extends `PAYMENT-ARCHITECTURE-CORRECTION.md` (PR #231) and works inside the existing release, factory and marketplace. None of them is replaced or redeployed.

## 1. Fixed facts, checked against the repository and the chain (chain 43114)

| Item | Value | Evidence |
|---|---|---|
| Existing sale (legacy, immutable) | `0x6ae84a51f100f10f0535a514555043ae9edf9aa3` | `config`/DB `release_contracts`; runtime equals `contracts/VoidPrimarySale.sol` |
| Factory | `0x262B774cf9a1949170B58E2d57F6189980FE757b` | `config/mainnet-release-per-contract.json`; creation tx `0x50642d…f790` |
| Release | `0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103` | `factory.isRelease` true; `releasesOf(artist)` |
| Artist payout | `0x284C09a7CC187E096cbbdc88d99defe6df32180a` | `payoutOf` / `artistOf` for the token |
| Platform fee recipient | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` | sale `platformRecipient()`; marketplace `feeRecipient()`; manifest |

The release address as typed in the task (`0x9Aa6165B…FD103`) fails the EIP-55 checksum. Its lowercase form is the real address. The platform address typed in the task differs from the manifest only in letter case, not in value. Tools in this PR normalise addresses through lowercase.

## 2. Mint revenue

There is no separate mint payment path. Proven three ways:

- **Source:** the only payable contracts are the sales (`VoidPrimarySale`, `…Settled`, `…V2`) and the marketplaces. `VoidCollection1155`, the release and `GenesisHolderClaim` have no payable function.
- **On-chain:** `release.mint(...)` simulated from the authorized issuer succeeds with no value and reverts with 0.01 AVAX attached.
- **Balances:** the release, factory, marketplace, anchor, Genesis collection and release implementation all hold exactly 0 AVAX.

A mint happens only when a sale's `purchase()` calls `release.mint`. Mint revenue is the primary-sale payment, with the same 97.5% artist and 2.5% platform split. There is no second split to invent. The earnings view labels the category "Primary sales (paid at mint)".

## 3. Reconciliation (live, read-only; `node scripts/payment-ledger-reconcile.mjs`)

| Flow | Gross | Artist | Platform | Seller | To wallets | Held | Claimable / withdrawn |
|---|---|---|---|---|---|---|---|
| Mint (= primary) | n/a, see primary | | | | | release holds 0 | |
| Primary, sale `0x6ae8…` (1 purchase, tx `0xca613e8b…bb7`) | 0.25 | allocation 0.24375 | allocation 0.00625 | n/a | **0 to the artist wallet, 0 to the platform wallet** | 0.25 in the contract (0.00625 platform credit + 0.24375 artist credit) | artist claimable 0.24375; withdrawn 0 |
| Secondary, marketplace `0x0e77…` | 0 | 0 | 0 | 0 | 0 | 0 | no sale has ever occurred |

- **No discrepancies:** the contract balance equals gross minus transfers, and the artist's `balances` equals allocation minus withdrawals.
- **Allocation versus transfer:** the platform's 0.00625 AVAX is a contract credit. It is not a wallet receipt.
- **Sources:** primary-sale logs came from an explorer export (three logs: ownership, `SaleConfigured`, `Purchased`). There is no `Withdrawn` event. The marketplace's empty history also came from the explorer export, because the public RPC caps `eth_getLogs` at 100 blocks and rate-limited a full scan. Balances and live credits came from the RPC.
- **Database agreement:** `primary_purchases` holds one FINALIZED row with paid 0.25 and cuts 0.24375 and 0.00625, matching the chain. `purchases` and `listings` have no rows, which matches the marketplace's empty history.

## 4. Platform fee by flow (does the platform wallet receive AVAX without signing?)

| Flow | Mechanism | Automatic? |
|---|---|---|
| Primary, legacy sale `0x6ae8…` | Credited to `balances[platform]`; only `withdraw()` from `0xb65C…` moves it | **No.** The sale is immutable. |
| Primary, `VoidPrimarySaleSettled` | `call{value: platformCut}` to the recipient inside `purchase()`; failure reverts the whole sale | **Yes**, once the sale is authorized for the release (section 6) |
| Secondary, `ReleaseMarketplaceV4` | `_pay(feeRecipient, fee)` inside `buy()`, then the royalty to the edition's payout, then the seller remainder; any failed transfer reverts all (`TransferFailed`) | **Yes.** Already live. No sale has happened yet. |
| Mint | Not a separate flow | n/a |

## 5. Historical 0.00625 AVAX platform credit

- **Path:** `withdraw()` pays `balances[msg.sender]` to `msg.sender`. There is no `withdrawFor`, no approval or delegate, no owner sweep, and no proxy. The credit is keyed to the address `0xb65C…1ce4`.
- **Authorization:** only a transaction signed by that address can move it. Any other caller either reverts `NothingToWithdraw` or pays out only its own balance.
- **Conclusion:** under the fixed constraints the historical platform credit cannot be recovered without a signature from the platform wallet. It is not lost, because nothing can take it. It stays credited until that wallet calls `withdraw()`. The artist's 0.24375 AVAX is separate and is unaffected by it.
- **Proof status:** the fork test in `test/SettledSaleMainnetFork.t.sol` (when present and run) simulates each caller. A fork simulation proves the authorization path, not that anything was transferred on mainnet.

## 6. Authorizing a settled sale on the existing release (activation)

The existing release's `ISSUER_ROLE` is held by the legacy sale. The release's admin is the artist wallet, and `grantRole`/`revokeRole` are admin-callable. The settled sale is attached by the artist, with no change to the release or the factory:

1. **Deploy** `VoidPrimarySaleSettled(release, platformRecipient)`. This is a deployment and needs explicit human authorization. The constructor has no fee argument (fixed 250 bps) and the contract has no owner.
2. **Verify before granting** (read-only): `npm run verify:settled-sale -- --sale <address>` must pass the code hash, `releases()`, `platformRecipient()`, `PLATFORM_FEE_BPS()`, no `owner()`, and the issuer-set checks.
3. **Artist signs** `grantRole(ISSUER_ROLE, newSale)`, then `revokeRole(ISSUER_ROLE, oldSale)`. The old sale then cannot mint. Its credited balances and `withdraw()` are unaffected.
4. **Artist** configures the new sale for the edition (`configureSale`: price, window, per-wallet limit). Limits restart at zero in the new sale; the old sale's history is unchanged.
5. **Indexer:** add one `PRIMARY_SALE` entry to `INDEXER_CONTRACTS_JSON` with `tokenAddress` equal to the release. This is a production env change and needs human approval. The satellite sale is not factory-registered, so the indexer needs this entry to index its purchases.
6. **Re-verify** with the same script after the swap.

Deployment, role transactions and the env change are all human-authorized steps. This PR performs none of them.

## 7. What cannot be fixed on-chain (immutability)

- **Fee bypass through issuer permissions.** The artist is the release's admin and can grant `ISSUER_ROLE` to any contract. A rogue minter mints without paying the primary-sale fee. The release cannot be changed, so this cannot be prevented on-chain. Mitigations that exist in code: the read-only activation verifier fails if any ISSUER holder other than the authorized sale exists, and the Earnings view treats unknown sale code as unauthorized. The secondary-market fee and royalty are enforced by the marketplace itself regardless of who minted.
- **Factory registry.** `factory.primarySaleOf(release)` will always name the legacy sale. A satellite sale is not registered there.
- **The old factory stays callable.** It is ownerless and cannot be disabled. The app stops using it only through the manifest.

## 8. Items intentionally not changed

`config/mainnet-release.json` fee fields (`platformFeeBps: 500`, the artist wallet as "platformFeeRecipient"): no runtime path reads them. `STUDIO_PLATFORM_ARTIST_WALLET` is exported but unused. Editing a file that drives nothing, without deployment evidence for a value, would be speculative.

## 9. Confirmations

No deployment, mainnet transaction, wallet signature, production database or environment mutation, role change, or merge was performed. Forks, scratch EVMs and a disposable local Postgres were used for tests; they prove only the conditions tested.
