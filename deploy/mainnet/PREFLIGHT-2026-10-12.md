# Mainnet preflight, 2026-10-12 (read-only)

Read-only; no key used. Nothing was signed or broadcast, nothing was funded, no secret or production
setting changed. Manifest `config/mainnet-release-per-contract.json` stays at `deployed: false` and
`deploymentAuthorized: false`, with the factory, implementation and marketplace addresses unset.

**RPC:** `https://api.avax.network/ext/bc/C/rpc`, chain 43114. Block **97,386,555**
(`0x53035c29…7e8f69`), block time 2026-10-12 19:40:55 UTC, read 19:40:56 UTC. Base fee 5 gwei.

| Check | Result | Value |
|---|---|---|
| Deployer is the defined Rabby deployer | PASS | `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174` |
| Deployer is an EOA | PASS | no code |
| Nonce latest / pending | PASS | 0 / 0 (the approved plan expects 0) |
| Balance | PASS | 0.5 AVAX (`500000000000000000` wei) |
| Fee data | — | maxFeePerGas 10,000,000,150 wei, priority 150 wei, gasPrice 5,000,000,150 wei |
| Predicted factory `0x262B774cf9a1949170B58E2d57F6189980FE757b` empty | PASS | recomputed `CREATE(deployer, 0)` |
| Predicted implementation `0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006` empty | PASS | recomputed `CREATE(factory, 1)` |
| Predicted marketplace `0x0e77116142844478a55EEd2Ab79de9F93770F8f5` empty | PASS | recomputed `CREATE(deployer, 1)` |
| Fee recipient is the Nano S Plus | PASS | `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4` in both constructors; no code on C-Chain |
| Fee recipient confirmed on the device screen | UNVERIFIED | owner's physical check (view only; the device signs nothing) |
| Platform fee 250 bps | PASS | factory `PLATFORM_FEE_BPS` 250 sealed; marketplace `platformFeeBps` 250 and `REQUIRED_PLATFORM_FEE_BPS` 250 |
| Royalty 250 bps locked to an artist wallet | PASS | `REQUIRED_ROYALTY_BPS` 250 in implementation and marketplace; implementation forbids the fee recipient as royalty payee |
| Clean rebuild with pinned Foundry | PASS | forge 1.3.1 (`08d3a4a`), solc 0.8.24, `forge clean && forge build`, the same version as CI |
| Factory init-code hash | PASS | `0xbecbf25576122981e916ec28dc65d990b693f8b8a4586152a7261a82015c3071` = approved |
| Implementation runtime-code hash | PASS | `0x52dc13a50021c00e2dd52e4ce5bd2697d9a85ef2ce8e9b07963330235035dec0` = approved |
| Marketplace init-code hash | PASS | `0x7c63f9e7eed6a96ad04eacd1f8f669cc03b2e5f65e3f3a1d28997dd4a81ab58a` = approved |
| Creation-data hashes | PASS | step 1 `0xad060fa5…4ab698`, step 2 `0xf056efd7…c33669`, both equal to the approved plan |
| Constructor arguments | PASS | identical to the approved plan (`recipient`; `recipient, 250, factory`) |
| Fresh plan reproduces the approved binding | PASS | digest `3bc016d61b9a517b4048668ec3c2332de214516d6d23a097c2e4fcad7a83425f` on source commit `0046c71` |
| Binding fails closed when stale | PASS | changed creation data → refused (`signingRequests`); nonce 1 → refused (`deployerNonce`); another commit → refused |
| Gas, with headroom | PASS | estimates 5,567,350 + 1,501,932 gas; Rabby gas limits 6,680,820 + 1,802,318 (+20%). Cost at the current max fee 0.0707 AVAX, or 0.106 AVAX with the 50% funding headroom; worst case at 25 gwei over the full limits 0.212 AVAX. The 0.5 AVAX covers all three. |
| Plan readiness | PASS | dry-run `readyToBroadcast: true`; all checks PASS except the device confirmation (UNVERIFIED) |
| Genesis claim plan separate | PASS | no `genesis-claim-mainnet` approved plan exists; this preflight covers release infrastructure only |
| No private key in this environment | PASS | no `*PRIVATE_KEY*` variable is set; the planner refuses to run if one is |
| Deployer key never held outside Rabby | **FAIL (historical)** | Repository records show the Fuji workflows' `DEPLOYER_PRIVATE_KEY` secret signed as this address; the last such run (`rehearse-royalty-fuji.yml`, run 38252855896) succeeded on 2026-10-12 13:01 UTC. Deleting the secret cannot undo this. See below. |
| `DEPLOYER_PRIVATE_KEY` repository secret present now | PASS (owner-confirmed, 2026-10-13) | The owner inspected Settings → Secrets and variables → Actions → Repository secrets; their screenshot shows `DEPLOYER_PRIVATE_KEY` absent. Not independently verified by Claude (secrets API 403). Environment-level secrets, other repositories, local copies and the deleted Render cron's former environment were not checked. |
| Deployer address retained | Owner decision (2026-10-13) | The owner keeps `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`, accepting the historical exposure above. Custody: the key stays in Rabby only. No replacement wallet. |
| Real Rabby path proven | UNVERIFIED | only stand-in wallets so far; the Fuji Rabby test (`deploy/fuji/RABBY-TEST.md`) is not yet authorized |

## Legacy key-based workflows (owner cleanup)

These workflows read `secrets.DEPLOYER_PRIVATE_KEY` to sign on Fuji. According to the repository's
own Fuji records (`ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md` D5, `FUJI-MARKETPLACE-RECONCILIATION.md`),
that key controls `0xaBd3…c174`, the mainnet deployer:

- `deploy-genesis-claim-fuji.yml`
- `deploy-release-factory-v3-fuji.yml`
- `deploy-release-fuji.yml`
- `deploy-release-per-contract-fuji.yml`
- `deploy-release-v2-fuji.yml`
- `rehearse-royalty-fuji.yml`

The two mainnet workflows (`deploy-release-per-contract-mainnet.yml`, `deploy-genesis-claim-mainnet.yml`)
only check that no `MAINNET_DEPLOYER_PRIVATE_KEY` secret exists and refuse to run if one does; they
never sign.

**Why this blocks launch:** the rule for this launch is that the deployer key exists only in Rabby.
Any workflow run, repository admin or leaked runner log with access to that secret can sign as the
mainnet deployer: it could spend the 0.5 AVAX or take nonce 0 before the owner. The plan binding
would then refuse to sign (fail closed), but the launch would be blocked. Deleting the secret stops
future use. It cannot undo the fact that the key was stored in GitHub, and, per D5, possibly in the
suspended (now deleted) Render cron's environment. Whether to keep this deployer address is the
owner's decision; Claude does not change wallet responsibilities. The owner's options:

1. Delete the `DEPLOYER_PRIVATE_KEY` repository secret, and disable or delete the six workflows
   (GitHub → Settings → Secrets and variables → Actions), and keep `0xaBd3…c174`, accepting the
   historic exposure; or
2. also designate a new deployer created only in Rabby, which needs a new approved plan
   (new addresses) and new owner authorization.

This session cannot list or delete secrets (the GitHub API returns 403) and has never read the value.
Whether the secret still exists is UNVERIFIED. To confirm it is gone, the owner checks Repository
secrets in Settings, or runs any of the six workflows: once the secret is deleted, its signing step
fails before sending anything.
