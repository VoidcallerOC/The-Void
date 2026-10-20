# ADR 0001 — Marketplace for legacy ERC-1155 collections (Genesis)

Status: PROPOSED (not deployed; needs independent review and explicit deployment authorization)
Date: 2026-10-20

## Context (verified on Avalanche C-Chain 43114 by `eth_call` at the time of writing)
- Genesis `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` is an EIP-1167 clone (45-byte runtime) of
  `0x2e61967a569bc18affc5e1b9f71e00af93a268c7`, source `ERC1155SingleBundle` (Joepegs Launchpeg), compiler 0.8.13.
  Etherscan reports it verified; I did **not** rebuild it and diff against runtime bytecode.
- ERC-165 reports ERC-1155 and ERC-2981 true. It has **no** `royaltyBpsOf` / `payoutOf` and is not factory-registered.
- `royaltyInfo(id, 1e18)` returns receiver `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` and `5e16` for tokens 0–3 and also for
  unminted id 7: **500 bps (5%)**, one contract-wide default. It is owner-mutable (`setRoyaltyInfo`, cap 2,500 bps).
  (The first root-cause note wrongly said 250 bps; this corrects it.)
- Genesis `owner()` is the same `0x284C…180a`. `paused()` is false.
- Genesis enforces an operator filter on `safeTransferFrom`/`safeBatchTransferFrom` when `from != msg.sender` and on
  `setApprovalForAll(operator)`: registry `0x000000000000AAeB6D7670E522A718067333cd4E`. It is registered for Genesis with no filtered
  operators, so any operator is currently allowed (`isOperatorAllowed(Genesis, V4 market) = true`). The Genesis owner can change this.
- `ReleaseMarketplaceV4` `0x0e77…F8f5` is immutable with no owner or allowlist; its registry, 250 bps royalty policy and
  `royaltyBpsOf`/`payoutOf` reads are fixed. Fee 250 bps, fee recipient `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`.

## Options
1. **Extend V4** — impossible: nothing is upgradeable or configurable. Rejected.
2. **Wrapper/adapter token for Genesis** — custody or restricted transfers of holders' assets. Rejected (traps tokens).
3. **Frontend/indexer-only workaround** — cannot make V4 accept Genesis, and would hide a failing transaction. Rejected.
4. **New, separate marketplace with an explicit collection allowlist** — chosen. V4 and the factory-release trust boundary are untouched.

## Decision: `LegacyCollectionMarketplace`
- Non-custodial: the seller keeps the tokens; the marketplace is an approved operator and moves them only inside `buy`.
- Immutable: fee 250 bps, fee recipient, chain id. No upgrade proxy, no arbitrary-call, no fund-withdraw function.
- Owner powers (intended: a Safe): allow a collection with `{maxRoyaltyBps ≤ 1000, tokenId range}`, disable a collection, pause,
  two-step owner transfer. A disabled collection or a pause blocks new listings and purchases, never cancellations.
  The owner cannot move listings, tokens or AVAX.
- Allowing a collection requires code, ERC-165 ERC-1155 and ERC-2981 support. Being ERC-1155/2981 alone grants nothing.
- Settlement in AVAX: `fee = ⌊price·250/10000⌋`; `(receiver, royalty) = token.royaltyInfo(id, price)` read at sale time through
  a bounds-checked `staticcall`; `royalty ≤ price·maxRoyaltyBps/10000`, receiver non-zero when royalty > 0, `fee+royalty ≤ price`;
  `seller = price − fee − royalty` (seller takes rounding dust). Any failed transfer reverts the whole sale, so the buyer never keeps
  the NFT while a payout is unpaid. The royalty percentage is **taken from Genesis, not hardcoded**; the cap only protects
  sellers if the Genesis owner raises the royalty later.
- Proposed Genesis scope: token ids 0–3, `maxRoyaltyBps = 500` (the verified current royalty). Owner decision required.
- Compatible with V4's `createListing/cancelListing/expireListing/buy/getListing` signatures and event shapes so the indexer and
  frontend reuse their decoders.

## Residual risks (must be accepted or mitigated before deployment)
- Operator filter: if the Genesis owner starts filtering this marketplace, `buy` reverts and listings go stale. Readiness check
  `isOperatorAllowed` is added; no on-chain mitigation exists or is attempted.
- Genesis owner can raise royalty up to the cap-exceeding level → purchases revert until the royalty is lowered or the cap raised.
- Royalty receiver that rejects AVAX blocks sales of Genesis (reverts by design; no silent skip).
- Platform fee recipient `0xb65C…1ce4` rejecting AVAX would block every sale; it is an EOA/Safe controlled by the platform.
- Not independently audited.
