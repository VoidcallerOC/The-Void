# Chain Authority Rule

Repository reports, screenshots, handoffs, test reports, indexer records, and operator statements are **historical evidence only**.

When evidence conflicts, prioritize:

1. Fuji on-chain transaction receipts/logs
2. Fuji contract state at the relevant block
3. Verified contract bytecode/source where available
4. Deployment manifests and transaction records
5. Indexer/API records
6. Test reports/screenshots/handoffs
7. Operator recollection

## Hard constraints

- Do **not** treat an operator report saying “E2E passed” as proof by itself.
- Do **not** treat an indexer showing zero activity as proof by itself if direct chain tracing can establish the transaction.
- For every claimed step, provide the strongest available evidence and identify its source.
- If an event or transaction cannot be independently reconstructed from historical evidence, mark that step **UNVERIFIED** rather than inferring it from downstream state.

## Evidence labels

| Label | Meaning |
|---|---|
| `VERIFIED` | Independently reconstructed from tier 1–3 chain evidence |
| `VERIFIED_AT_BLOCK` | True at a cited block; later state may differ |
| `PARTIAL` | Some on-chain evidence exists; the claimed end-state is incomplete |
| `UNVERIFIED` | Cannot be reconstructed from receipts/logs/state; do not infer |
| `CONFLICT` | Lower-tier evidence contradicts higher-tier evidence; higher tier wins |
| `NOT_ACCEPTED_AS_PROOF` | Claim exists only at tier 6–7 |

## Reproduction

```bash
node scripts/fuji-chain-authority-probe.mjs
```

Live results are written under `/tmp` or stdout. The latest applied audit is recorded in `CHAIN-AUTHORITY-FUJI-VERIFICATION.md`.
