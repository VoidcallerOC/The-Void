# The Void — Canonical Fuji Contract Configuration Remediation

**Date:** 2026-10-04 00:47 EDT  
**Status:** **BLOCKED**  
**Workspace:** Render `My Workspace` (`tea-dahg5av40ujc73aiu5sg`)

## CONFIG UPDATED

**No.** No production environment variable, deployment, restart, database row, checkpoint, code, or contract was modified.

The approved current values remain:

```text
Chain:          43113
Release:        0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6
Release block:  59015108
Sale:           0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA
Sale token:     0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6
Sale block:     59015114
```

## RENDER SERVICES CONFIRMED

| Role | Service | ID | State before attempted update |
|---|---|---|---|
| API | `the-void-api-fuji` | `srv-dahhjtek1f9s73favktg` | Live; auto-deploy off |
| Worker | `the-void-indexer-fuji` | `srv-dahhqdu7bikc73e8gvp0` | Live; auto-deploy on |

## BLOCKER

`INDEXER_CONTRACTS_JSON` is Render-managed as a `sync: false` secret on both services. The connected Render MCP exposes an environment-variable **update** operation, but no read operation. The service inspection response does not include environment values.

The Render dashboard was opened through the connected authenticated browser. It exposed the service settings and deployment pages, but not a safe machine-readable copy of the existing secret value. The exact Marketplace object remains unavailable.

The user’s approved rule requires:

- preserve the Marketplace entry exactly;
- do not reconstruct, simplify, delete, or otherwise modify it;
- update only Release and Sale entries.

Submitting a newly reconstructed JSON array would violate that rule and could remove unknown Marketplace fields or change its start block. Therefore no update was attempted.

## RENDER DEPLOYMENT

**Not triggered.** Neither API nor worker was restarted or redeployed.

## WORKER / API

No runtime changes were made. Existing production behavior remains unchanged.

## CHECKPOINTS

- New release checkpoint: **not created**
- New sale checkpoint: **not created**
- Old checkpoints preserved: **yes; untouched**

## INDEXING

**Unverified after remediation** because remediation did not occur. No crash-loop, ABI, wrong-chain, decoding, or database-constraint signal was introduced by this task.

## FORGIVE & FORGET API

No post-remediation verification was possible.

- Expected before remediation: `forgive-forget-23` → HTTP 404
- Direct Fuji RPC remains the authoritative confirmation that the current release and sale exist.

## USER-FACING FLOWS

Not re-tested after remediation because no remediation was applied:

| Flow | Result |
|---|---|
| Catalog | UNVERIFIED |
| Release | UNVERIFIED |
| Ownership | UNVERIFIED |
| Marketplace | UNVERIFIED |
| Gated content | UNVERIFIED |
| Persisted Studio | UNVERIFIED |

## PRIMARY SALE

**Not modified.** The existing direct Fuji RPC behavior remains the expected:

- configured;
- 0.01 AVAX;
- uncapped;
- per-wallet limit 2;
- not paused.

## VERIFIED

- The Render connector is enabled.
- The confirmed Render workspace is `My Workspace`.
- The API and worker service IDs were identified.
- Both services use a Render-managed `INDEXER_CONTRACTS_JSON` secret.
- The available Render update tool merges environment variables but cannot reveal the existing JSON.
- The Marketplace configuration therefore cannot be preserved exactly from the available interface.
- No production configuration or data was changed.

## UNVERIFIED

- Complete current API `INDEXER_CONTRACTS_JSON`.
- Complete current worker `INDEXER_CONTRACTS_JSON`.
- Marketplace `startBlock`, `platformFeeBps`, and any optional fields.
- New checkpoint creation and indexing progress.
- Post-remediation API and user-flow behavior.

## BLOCKERS

1. Need a safe way to obtain the existing `INDEXER_CONTRACTS_JSON` from both Render services without exposing it or replacing it.
2. The exact Marketplace object must be retained byte-for-byte/field-for-field.

## ROLLBACK REQUIRED

**No.** No change was made, so no rollback is required.

## DO NOT REDO

- Do not call `update_environment_variables` with a guessed or partial `INDEXER_CONTRACTS_JSON`.
- Do not omit or reconstruct the Marketplace entry.
- Do not trigger a deployment before the complete JSON is captured.
- Do not delete, reset, or rewrite checkpoints.

## NEXT ACTION

**Use the Render dashboard’s environment-variable editor, or provide a secure read/export capability, to capture the complete existing `INDEXER_CONTRACTS_JSON` for both services; then replace only the Release and Sale objects and preserve the Marketplace object exactly.**
