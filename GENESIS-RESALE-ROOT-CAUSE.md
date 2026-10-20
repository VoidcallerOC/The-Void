# Genesis secondary resale — root cause (2026-10-20)

STATUS: PARTIAL — cause proven on-chain; resale cannot be enabled without a new, audited marketplace deployment.

## Finding
Genesis is `0xD1B4367dd9f235f9ee61878019d66E31511E98eE` (Avalanche C-Chain 43114), an `ERC1155SingleBundle`
proxy (impl `0x2e61967a569bc18affc5e1b9f71e00af93a268c7`, Joepegs-style launchpad contract). It is not a
clone of The Void's release factory.

Mainnet marketplace `ReleaseMarketplaceV4` `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` (read on-chain:
registry = factory `0x262B774cf9a1949170B58E2d57F6189980FE757b`, platformFeeBps = 250, deploymentChainId = 43114):

| Check (eth_call, latest block) | Result |
|---|---|
| `factory.isRelease(Genesis)` | `false` → `list()` reverts `UnsupportedRelease` |
| `Genesis.royaltyBpsOf(0..3)` | reverts (function absent) → `RoyaltyPolicyViolation` |
| `Genesis.payoutOf(0..3)` | reverts (function absent) |
| `Genesis.royaltyInfo(0..3, 1e18)` | `0x284C09a7…2180a`, `5e16` = **500 bps (5%)** (ERC-2981 present; an earlier version of this note wrongly said 250 bps) |

Both gates are in `contracts/ReleaseMarketplaceV4.sol` (`_requireSupportedRelease`, royalty check) and are
immutable on the deployed marketplace. This is a genuine contract limitation, not stale indexer data or an
address mismatch (frontend `config/mainnet-release-per-contract.json`, marketplace and factory agree).

## Frontend defect fixed here
`CollectPanel` showed LIST FOR SALE to every owner while also printing "Secondary resale is unavailable".
The button now renders only when `isReleasePerContractCandidate` is true, and the message states the reason.

## Not done / needs an owner decision
Enabling Genesis resale needs a new marketplace that accepts an explicit allowlist of ERC-2981 collections
(Genesis only) and pays royalty via `royaltyInfo` — new contract, audit, deploy, then the manifest/indexer/UI
addresses. No contract was deployed or changed. Acceptance steps (list, second-account buy, balances, fee and
royalty settlement on mainnet) are UNVERIFIED: they need funded wallets and signed transactions.


See `docs/adr/0001-genesis-legacy-collection-marketplace.md` for the compatibility design.
