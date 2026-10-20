# P0 payment architecture correction and artist Earnings view

Status: **PARTIAL**. Code and tests are written and verified on a local mainnet fork. Nothing has been deployed, sent or changed in production. The items under "Human approvals required" are open.

Incident: purchase `0xca613e8b33ffc197d9c04d6cacd6d85f0f6286364f20040f1654529d666c3bb7` on sale `0x6ae84a51f100f10f0535a514555043ae9edf9aa3` (Avalanche C-Chain 43114).

## 1. Premise check: this is not a regression

The instruction assumed the platform share was once transferred automatically and later changed to internal accounting. The history does not support that.

| Evidence | What it shows |
|---|---|
| Commit `fd31295` (2026-09-25), first commit of `contracts/VoidPrimarySale.sol`, PR #22 | `purchase()` already did `balances[platformRecipient] += platformCut; balances[payout] += artistCut;`. No `call{value:}` existed in `purchase()`. The file header already read "Proceeds are pull payments". |
| PR #22 body | "Pull payments via `withdraw`. Platform fee cannot exceed the constructor cap." |
| Later commits `66f4938` (open editions) and `80c32af` (Safe ownership) | Neither touched settlement. |
| `docs/RELEASE-ERC1155.md` | "Proceeds are pull payments." |
| `docs/C-CHAIN-PRODUCTION-RUNBOOK.md` section 9 | Test plan expects "platform and artist pull-payment balances are correct" and "withdrawals succeed only for recorded balances". |
| `deploy/mainnet/README.md` lines 14 to 15 | Platform fee is "Credited on every purchase to the sale contract; collecting it later is a separate treasury operation, outside the launch". Artist remainder is a "pull balance". The platform recipient is a passive Nano S Plus that "signs nothing in the launch". |
| `test/VoidPrimarySale.t.sol` | `testHappyPathMintsAndSplitsFee` asserts both shares as `balances`. |
| `DEPLOYER-AUTHORITY-ROTATION-PLAN.md` | "Proceeds go to `payoutOf(tokenId)` as pull balances." |
| `SYSTEM-CHAIN-CERTIFICATION.md` row A8 | The artist's pull withdrawal was exercised and verified on Fuji. |

The only push-payment settlement in the repo is `ReleaseMarketplaceV3` (resales), documented as push payments. That is the likely source of the expectation.

Conclusion: the deployed behaviour matches the written specification. Automatic platform payment is a **requested design change**, not a bug fix. The deployed sale bytecode was verified identical to `contracts/VoidPrimarySale.sol` (immutables and metadata hash masked).

## 2. Implemented design (not deployed)

`contracts/VoidPrimarySaleSettled.sol`, a separate file. `VoidPrimarySale.sol` is untouched, so the source-to-deployment match for production is preserved.

Difference from `VoidPrimarySale`, and nothing else:

- `purchase()` no longer credits `balances[platformRecipient]`. After the mint and all state changes it pushes `platformCut` to `platformRecipient` with `call{value: platformCut}("")`.
- A failed platform transfer reverts the whole purchase with `PlatformTransferFailed(recipient, amount)`. There is no mint, no credit, no `sold` change, and the buyer keeps the AVAX. This is atomic revert, the stated preference, and no other policy is specified anywhere in the repo.
- `Purchased` is emitted last, only after the platform share has been delivered. Its signature is unchanged, so the indexer decoder works unchanged. A new `PlatformPaid(recipient, amount)` event records the transfer.
- A zero platform cut (fee lowered to 0 bps, or a rounding floor of 0) skips the call.
- The artist share is unchanged: credited to `balances[payoutOf(tokenId)]` and pulled with `withdraw()`. This matches the specification and the verified Fuji A8 evidence. The artist share can never go to the platform wallet.
- The reentrancy guard, fee cap, owner functions and `configureSale` rules are byte-for-byte the same code.

Trade-off to decide: with atomic revert, a platform recipient that later rejects AVAX would block every sale on that contract. The recipient `0xb65C…1ce4` is an EOA with no code today, and it is an immutable constructor argument. A hybrid (try the push, otherwise credit a pull balance) avoids the block but would let a purchase succeed without payment, which was explicitly not wanted.

Tests: `test/VoidPrimarySaleSettled.t.sol`, 12 tests, all passing:

- the platform share is paid inside the purchase;
- artist routing is isolated, and the platform cannot withdraw it;
- the artist withdraws exactly the artist share;
- a payout address equal to the platform recipient still gets both shares, once;
- accounting invariant: escrow plus platform payments equals gross, across purchases and withdrawals;
- fee at 0 bps skips the transfer;
- rounding favours the artist and sums exactly;
- a rejecting platform reverts everything;
- a reentering platform is blocked by the guard and the outer purchase completes exactly once;
- earlier credits survive later purchases and fee changes;
- the legacy contract still credits both shares (documents deployed behaviour);
- wrong payment still reverts.

## 3. Can the deployed contract be upgraded? No.

- The sale is a plain contract created with `new` by the factory. It has no proxy, no upgrade hook, no sweep, and no setter for the platform recipient (`platformRecipient`, `platformFeeCapBps` and `releases` are immutable).
- The live factory `0x262B774cf9a1949170B58E2d57F6189980FE757b` (VoidReleaseFactoryV2Royalty, version 2) imports and embeds `VoidPrimarySale` and is documented as ownerless, with no function to change the sale code.
- The sale's owner is the factory (verified on-chain: `owner() = 0x262b…`), and the factory exposes no function that could act as owner. The owner could only lower the fee anyway.

So existing and any future releases created by that factory always get the pull-payment sale.

### Migration options for future sales

| Option | What it takes | Effect |
|---|---|---|
| A. Accept the documented design | No deployment. Ship the Earnings UI only. Platform collects its credited fee with `withdraw()` as the runbook already describes. | No migration. |
| B. New factory using `VoidPrimarySaleSettled` | Deploy a new release factory, and a new marketplace pairing if resales must work for its releases, because each marketplace accepts only its factory's releases. Existing release, sale and credits stay as they are. | Future releases get automatic platform payment. Requires a mainnet deployment and a recorded manifest, DB `contracts` rows, and indexer config. |
| C. Move the existing release to a new sale | The artist (holds `DEFAULT_ADMIN_ROLE` on the release, verified) would grant `ISSUER_ROLE` to a newly deployed settled sale and revoke it from the old one. | Needs a deployment. The new sale has none of the old sale's `sold` or `walletPurchased` state, so per-wallet limits would reset. Not recommended. The current sale is already sold out (1 of 1) and ended 2026-10-20 09:40:00 UTC. |

Recommendation: A for this release, and B only if the owner decides the new semantics should apply going forward. Do not deploy a replacement sale only to work around the existing one.

## 4. The existing 0.25 AVAX (separate from any code change)

Live reads at block 98,046,247 and now: the sale holds 0.25 AVAX, `balances[0x284C…180a] = 0.24375`, `balances[0xb65C…1ce4] = 0.00625`.

- Artist share: remains valid. `withdraw()` from `0x284C…180a` simulates successfully and is the only way out. Nothing in this change touches it.
- Platform share: stays credited to `0xb65C…1ce4`, withdrawable only by that address through the same `withdraw()` (a signature from the hardware wallet, gas about 40k). Nobody can sweep it, and nothing else can move it. It cannot be double paid, because the new contract never credits a platform balance and the old one is unchanged.
- No code change can deliver the existing platform share automatically. It needs that wallet's own transaction, or a decision to leave it credited.

## 5. Artist Earnings and withdrawal view

### Audit (current state before this change)

An Earnings view **already exists** and is deployed. Production (`the-void-vercel-mainnet`) was built from `main` at `285fe40`, the same tree audited here. It is reachable at `/studio`, action card "03 Earnings", behind a verified-wallet sign-in. Files: `src/components/StudioEarnings.jsx`, `src/lib/sale-earnings.js`, wired in `src/components/ArtistStudioPage.jsx`. The mainnet bundle is built by `deploy/vercel-mainnet/vercel.json` with `VITE_RELEASE_NETWORK=mainnet`, which resolves chain 43114 and factory `0x262B…` (`config/mainnet-release-per-contract.json`). Fuji values are not used in that build. The API binding query reads `release_contracts`, and production has the right DEPLOYED row for this sale.

Verified against a mainnet fork before any change: the unmodified view discovered the sale (from the API and from the factory alone), showed 0.24375 AVAX to the payout wallet, hid it from other wallets, and completed a withdrawal.

Gaps against the requirements, now fixed:

| Gap | Fix |
|---|---|
| No "already withdrawn" figure | `artist_earned_wei` added to the API bindings query (sum of `primary_purchases.artist_cut_wei` for the sale, finalized statuses only). The view shows earned to date and derived already-withdrawn (earned minus still held). When the API does not report earnings it says so and invents nothing. |
| No submitted state; no hash until confirmed | States are: awaiting wallet, submitted (hash link), confirmed, failed or rejected. |
| Success relied on receipt status only | Success now requires this sale's `Withdrawn(account, amount)` event for the connected wallet. The confirmed message shows the amount from the event. |
| No upfront wrong-network state | Wallet chain is read on load and on `chainChanged`. A banner offers a switch (adding the chain if unknown), and Withdraw is disabled until the chain matches. |
| Sale binding trusted without a live check | Before enabling Withdraw, the sale's `releases()` and the factory's `primarySaleOf(release)` must both match, and the RPC chain must match. Otherwise withdrawal is disabled with the reason. |
| Zero shown as "0.0 AVAX" | Formatted as "0 AVAX". |
| Nothing about the platform fee | A note says the fee is taken before the artist share and there is nothing for the artist to claim. The platform's own balance row never appears for an artist wallet. |

Authorization follows the contract's rules. The Withdraw button appears only when the connected wallet is the address holding the balance (`payoutOf(tokenId)` per published token, read live). A Studio login, an artist profile, the deployer or a Safe do not grant it.

### Test evidence

- `src/lib/sale-earnings.test.js` and `src/components/StudioEarnings.test.jsx`: 21 tests. They cover balance display, earned and withdrawn, zero balance (button disabled, nothing sent), wallet rejection, submitted then confirmed, missing `Withdrawn` event, wrong network, unauthorized wallet, and an unverified sale.
- `src/components/StudioEarnings.mainnet-fork.test.jsx`: 7 tests against an anvil fork of the live chain (`MAINNET_FORK_RPC=…`, skipped otherwise). It exercises the real component with mainnet config, the real sale and factory, and the impersonated artist wallet. The withdrawal sends AVAX on the fork only. After it: the artist gains 0.24375 minus gas, the sale keeps exactly 0.00625 for the platform, and the earlier credit state is restored after each test. It also covers a wrong chain, a rejected transaction and a bogus sale address.
- `test/mainnet-fork/earnings-browser-e2e.mjs`: the real mainnet bundle in Chromium with a stub API and an injected wallet routed to the fork: Studio, sign in, Earnings, balance 0.24375 AVAX, Withdraw. The wallet was asked for exactly one transaction, to the sale with calldata `0x3ccfd60b`, and it confirmed with the amount from the event.
- Full suites: JS 1889 passed, 0 failed (lint clean); Foundry 250 passed, 0 failed (6 fork tests skipped without an RPC URL, as before).

## 6. Affected files

- New: `contracts/VoidPrimarySaleSettled.sol`, `test/VoidPrimarySaleSettled.t.sol`, `src/components/StudioEarnings.mainnet-fork.test.jsx`, `test/mainnet-fork/earnings-browser-e2e.mjs`, this document.
- Changed: `src/lib/sale-earnings.js`, `src/components/StudioEarnings.jsx`, `src/lib/sale-earnings.test.js`, `src/components/StudioEarnings.test.jsx`, `server/studio-service.js` (one subquery), `server/studio-service.test.js`.
- Not changed: `contracts/VoidPrimarySale.sol`, factories, `config/*`, fee percentages, recipient addresses, the indexer.

Other places that describe pull payments and would need editing only if option B or C is approved: `docs/RELEASE-ERC1155.md`, `deploy/mainnet/README.md` lines 14 and 15, `docs/C-CHAIN-PRODUCTION-RUNBOOK.md` section 9, `DEPLOYER-AUTHORITY-ROTATION-PLAN.md`. Indexer impact for the settled sale: `Purchased` decodes unchanged. `PlatformPaid` would be stored as an UNKNOWN event row unless a decoder is added.

`config/mainnet-release.json` is stale (`platformFeeBps: 500`, and the artist payout address listed as the fee recipient). The live values are 250 bps and `0xb65C…1ce4`. It is not used by the mainnet release path. Left unchanged: no evidence supports changing it without a decision.

## 7. Production deployment plan for the Earnings view

1. Review and merge the PR.
2. Deploy the API first (Render `the-void-api-mainnet`), because the web view needs `artist_earned_wei`. The view degrades safely without it: it shows the live balance and says history is unavailable.
3. The Vercel mainnet project then redeploys from `main` with its existing build settings. No environment variable changes are needed.
4. Verification that I could not perform: on the deployed site, sign in as the artist wallet, open Studio, Earnings, and confirm 0.24375 AVAX and the earned figure. The actual withdrawal is a real transaction by the artist.

## 8. Human approvals required

1. Decide A, B or C in section 3 (design decision; B and C involve a mainnet deployment).
2. If B or C: explicit authorization for any deployment, role grant or manifest and DB change, and the rejecting-recipient trade-off in section 2.
3. The artist signs the real withdrawal of 0.24375 AVAX from `0x284C…180a` (or declines).
4. The platform wallet owner decides whether and when `0xb65C…1ce4` withdraws 0.00625 AVAX.
5. Approval to deploy the API change and the web change, in that order.

Nothing in this document is marked complete: the code and tests are reviewed only by me, and the production path is unverified until step 4 of section 7 is done on the real site.
