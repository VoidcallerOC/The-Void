# Collect Diagnosis

**Date:** 2026-09-18  
**Network:** Avalanche Fuji  
**RPC:** `https://api.avax-test.network/ext/bc/C/rpc`

## Result

The live failure is **not a receipt-handling or gas problem**. The certified contract is deployed and active, but the Summit edition has never been created on-chain. The frontend was attempting to mint a deterministic token ID that does not exist in the contract’s `_editions` mapping.

## Verified state

| Field | Value |
|---|---|
| Chain ID | `43113` |
| Current Fuji block | `58472078` at diagnosis time |
| Certified contract | `0x262B774cf9a1949170B58E2d57F6189980FE757b` |
| Contract bytecode present | Yes |
| Configured release ID | `summit-demo-release` |
| Configured edition ID | `summit-demo-edition` |
| Token ID from authoritative repository config | `74113628307887823943648072209060426363147404996786075096676516481552574685730` |
| `paused()` | `false` |
| Summit `edition(tokenId)` | Reverted with `EditionNotFound` |
| Matching `EditionCreated` event | None |

The token ID displayed by the deployed app matches the repository’s deterministic configuration. The shorter token ID in the original diagnostic prompt does **not** match the authoritative repository/config value and was not used.

## Edition event history

The certified contract has two `EditionCreated` events, but neither is Summit:

| Transaction | Block | Release / edition | Token ID |
|---|---:|---|---:|
| `0xba9a1bbce4517954dd1b986724a28400e8ad85f5383435ff5f1ba18b95ab4e92` | 58428588 | `r0619450` / `e0619450` | `97690192765976437095733412815169390430130656459828224509545046326735018025409` |
| `0x1f51589fa0c6a79f9de51ce657e18f1b4c2e6efbc880e441e04ab823f861008e` | 58428600 | `u0619450` / `after` | `72157986047679671921981286406417393594483712814093999514201457261490109111248` |

No Summit `EditionCreated` transaction hash exists.

## Transaction path diagnosis

The deployed frontend’s `CollectPanel` performs these checks before submission: wallet connection, wallet authentication, certified contract and chain, `paused()`, and `ISSUER_ROLE`. It then encodes `mint(address,uint256,uint256,bytes)` with BigInt-safe token ID handling.

The missing precondition was an on-chain edition existence check. The mint contract executes `_consumeSupply(tokenId, amount)`, which first checks `_editions[tokenId].exists` and reverts with `EditionNotFound(tokenId)` when absent. Therefore, no valid mint can succeed for Summit until `createEdition()` is executed and confirmed.

No live transaction hash was available for independent receipt inspection during this diagnosis; the browser wallet was not connected in the inspected session, so no transaction was sent by this investigation. The failure is deterministically reproduced through read-only `edition(tokenId)` against Fuji.

## Fix applied

The smallest safe fix was applied:

1. Added `readFujiEdition()` to perform a read-only `eth_call` to `edition(tokenId)` and decode `EditionNotFound` as a missing edition.
2. Updated `CollectPanel` to stop before mint submission and show: **“Edition has not been created on Fuji yet. Create the Summit edition before collecting.”**
3. No role was granted, no contract was deployed, no transaction was bypassed, and no ownership or success was fabricated.

The operational flow remains:

> Create Edition → successful receipt → verify `EditionCreated` → Mint → successful receipt → verify `balanceOf()`.

## Regression

| Check | Result |
|---|---|
| `npm test` | PASS — 27 files, 176 passed, 12 skipped |
| `npm run lint` | PASS |
| `npm run build` | PASS |

## Final status

**PARTIAL / BLOCKED** — the frontend now reports the actual root cause and will not submit an impossible mint. Summit Collect cannot be reported as working until an authorized artist executes `createEdition()` on the certified contract, the receipt succeeds, `EditionCreated` is independently verified, and a subsequent authorized mint receives a successful receipt followed by a positive `balanceOf()` check.

## Important authorization note

The connected wallet’s `ISSUER_ROLE` was not observable because the inspected browser session was not connected. The chain-level blocker above occurs before authorization can make the Summit mint valid. After edition creation, the wallet used for Collect must still be checked for `ISSUER_ROLE`; no role should be granted automatically.

## Diagnostic script

The read-only diagnostic used for this report is [`scripts/diagnose-fuji-collect.mjs`](scripts/diagnose-fuji-collect.mjs).

## Changed files

- `src/lib/fuji-release.js`
- `src/components/CollectPanel.jsx`
- `scripts/diagnose-fuji-collect.mjs`
- `COLLECT-DIAGNOSIS.md`

No private keys or secrets were exposed.

> Collect works only after a real Fuji transaction has a successful receipt and `balanceOf()` subsequently proves ownership. That condition is not yet met.
