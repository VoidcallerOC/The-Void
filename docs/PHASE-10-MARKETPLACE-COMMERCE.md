# Phase 10: Marketplace Deployment and Durable Commerce

## Implemented

The marketplace now fails closed unless a valid environment-specific address and chain ID are configured. The browser reads listings from `/api/listings`, which is backed by database projections of finalized blockchain events; it no longer requires users to discover listings by manually entering numeric IDs. Purchase receipts are validated against the listing, buyer, seller, token, quantity, and settlement amount before the collector state is refreshed.

The `MusicMarketplace` contract retains approval-based ERC-1155 custody semantics, reentrancy protection, exact native-currency payment, fee bounds, and ERC-2981 royalty support. Royalty responses that exceed the amount remaining after the platform fee now revert rather than silently changing settlement economics. ERC-1155 receiver and ERC-165 support are explicit.

The indexer decodes `ListingCreated`, `ListingCancelled`, `ListingExpired`, and `ListingSold` events. Event identity remains `(chain_id, contract_address, transaction_hash, log_index)`. Successful decoded events are projected into listings, listing history, and purchases in the same database transaction; duplicate event insertion does not repeat the projection. Missing contract metadata or inconsistent sale quantities produce reconciliation-required outcomes rather than allowing the database to invent state.

Migration `004_marketplace_commerce.sql` adds confirmation and reconciliation fields to purchases and expands transaction lifecycle states. The client and persistence layers support submitted, pending, observed, confirmed, finalized, failed, reverted, replaced, stale, and reconciliation-required states.

## Deployment

`npm run deploy:marketplace` invokes Foundry with deterministic constructor arguments and writes `deployments/marketplace-fuji.json` or `deployments/marketplace-mainnet.json`. Fuji uses chain ID `43113`; Avalanche C-Chain mainnet uses chain ID `43114`. Mainnet additionally requires `CONFIRM_MAINNET_DEPLOY=yes`. The record includes network, chain ID, contract address, deployment transaction, block number when returned by the deployment tool, bytecode hash when the artifact is available, source verification status, fee recipient, fee basis points, and the supported-token contract list.

No deployment was performed in this task. Therefore this repository does **not** claim that Fuji or mainnet deployment, verification, or source publication is complete. A deployment record must only be committed after the command has actually succeeded and the address and transaction have been independently checked on the target explorer/RPC.

## Verification

The following local checks pass after `npm ci`:

| Check | Result |
|---|---|
| `npm test` | 65 tests passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm audit --omit=dev` | Reports 1 high and 1 moderate React Router advisory |

## Final audit and blockers

The marketplace is **not yet production-ready** despite the code and test improvements. The remaining blockers are operational and security-critical:

1. A real Fuji deployment has not been executed or independently verified in this task.
2. Mainnet deployment, explorer source verification, and supported-token allowlisting have not been executed.
3. No Solidity test runner is present in this repository or sandbox, so the contract test matrix must still be run in a Foundry/Hardhat environment against malicious ERC-1155 receivers, reentrancy attempts, royalty/fee bounds, stale approvals, balance changes, and settlement event correctness.
4. The production indexer still needs an operational worker, RPC credentials, configured marketplace/token contract UUIDs, monitoring, retry alerting, and a reconciliation schedule. The database is not authoritative; the blockchain remains authoritative by design.
5. The API needs production wallet authentication and a deployed blockchain verifier before purchase confirmation can be trusted server-side. The existing injectable trust boundary is preserved, but a missing verifier returns `501`.
6. The dependency audit reports unresolved React Router vulnerabilities and must be remediated or risk-accepted before launch.
7. Rate limits, RPC endpoints, database migrations, secret management, explorer verification, and rollback/runbook procedures must be exercised in the target hosting environment.

Until these blockers are closed, the correct status is **testable commerce implementation / pre-production**, not production commerce.
