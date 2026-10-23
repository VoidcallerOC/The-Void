# Provisional plans (not approvals)

Files here are key-less dry runs for review only. The owner page never offers them, nothing here can be signed, and
merging them approves nothing. An approval is a bound plan under `deploy/mainnet/approved-plans/`, made from the merged
commit once the deployer is funded (see `deploy/mainnet/SEQUENTIAL-LAUNCH.md`).

- `release-per-contract-mainnet.sequential.dry-run.json`: `RELEASE_FACTORY_PROFILE=sequential` plan from live C-Chain
  on 2026-10-23 (deployer nonce 6). Every check passes except deployer funding (0.0000103 AVAX held, 0.0550 AVAX
  required). Its creation data was compiled from the uncommitted working tree; the approved plan is rebuilt from the
  merged commit. Superseded by `deploy/mainnet/approved-plans/release-per-contract-mainnet.json`, rebuilt from merged
  main `7d8485848cf408ad7506d0784d1d0c9e192b35f3` once the deployer was funded; both creation-data hashes are unchanged.
