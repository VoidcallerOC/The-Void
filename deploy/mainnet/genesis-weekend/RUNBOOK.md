# Genesis weekend claim: deployment and activation runbook

Status: **NOT AUTHORIZED.** Every step below that signs a transaction or changes production needs its own owner authorization, given after independent review. Nothing here has been executed.

| Item | Value |
|---|---|
| Contract | `contracts/GenesisWeekendClaim.sol` |
| Chain | Avalanche C-Chain 43114 |
| Release / token | `0xF0C091A159DE16cF0F306b2B61d37685EC5A830e` / 1 |
| Paid sale | `0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845` |
| Close | `1793595599` = 2026-11-02 04:59:59 UTC = Sun 2026-11-01 11:59:59 PM EST. Immutable. |
| Admin and signer for every step | Artist wallet `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` (holds DEFAULT_ADMIN_ROLE on the release) |

## Gates (all must pass, in order)

1. **CI green** on the PR head: Foundry unit and mainnet-fork tests, and vitest.
2. **Independent security review: GO.** Every finding is resolved or explicitly accepted by the owner.
3. **Final snapshot.**
   - `node scripts/genesis-weekend-snapshot.mjs --cchain-block <N> --out deploy/mainnet/genesis-weekend/snapshot.json` exits 0 (`ok: true`).
   - N must be at least 30 minutes old.
   - Commit the file.
   - A second, independent run at the same block must reproduce the identical `merkleRoot` and `snapshotHash`.
   - The run must report two independent indexers (Routescan and Glacier) agreeing on per-id issuance, and every explorer gap repaired from the C-Chain node.
   - Review `eligibleContractWallets`: those addresses can claim only if their contract can call `claim()`.
4. **Deploy.**
   - Simulate the exact initcode from the artist wallet; it must not revert.
   - Owner signs in Rabby.
   - Verify:
     - runtime code hash equals the reviewed build;
     - `merkleRoot`, `snapshotHash`, `eligibleWallets` and both snapshot blocks equal the committed snapshot;
     - `claimEnd() == 1793595599`;
     - `baselineClaimedSupply() == 4`;
     - `admin()` is the artist;
     - `active() == false` and `paused() == true`.
5. **Revoke `ISSUER_ROLE` from the expired claims.** Owner signs both revokes.
   - `revokeRole(ISSUER_ROLE, 0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363)`
   - `revokeRole(ISSUER_ROLE, 0xd70dBA7fF6419481d62D4689bDf271ad441766b8)`
   - Their windows closed on Oct 27 and Oct 28. After the revokes, only the paid sale and the weekend claim can mint.
   - Verify `hasRole` is false for both, and that `/api/claims/config` still returns 200 (PR #355 removed the role requirement after close).
6. **Grant `ISSUER_ROLE` on the release to the new contract.** This must happen **before** step 7: the weekend API refuses (503) while the claim is open but cannot mint, and that would block Artist Studio sale edits.
   - Simulate, then the owner signs.
   - Verify `hasRole(ISSUER_ROLE, claim) == true`.
   - Verify that no other new role holder exists: compare `RoleGranted` events before and after.
7. **API configuration (Render, mainnet API).** Set:
   - `GENESIS_CLAIM_MODE=weekend`
   - `GENESIS_WEEKEND_CLAIM_CONTRACT=<deployed address>`

   Keep `GENESIS_CLAIM_RELEASE_CONTRACT`, `GENESIS_CLAIM_PRIMARY_SALE` and `GENESIS_CLAIM_TOKEN_ID`. After the redeploy, verify:
   - `GET /api/claims/config` returns 200, `mode: "weekend-merkle"`, `active: false`, `paused: true`;
   - `merkleRoot` matches;
   - Artist Studio sale panel loads without "not checked";
   - `/api/editions` is unchanged.
8. **Frontend.** The merged claim page supports `weekend-merkle`. Verify `/claim` shows "has not opened" and no claim button.
9. **Owner activation authorization.** Owner signs `activate()`. Verify:
   - `active() == true`, `paused() == false`, `claimStart()` is set;
   - `/api/claims/config` shows `active: true`.
10. **Authorized end-to-end claim** from an owner-approved eligible wallet. Verify:
   - receipt status 1;
   - `GenesisWeekendClaimed` emitted;
   - the wallet's token-1 balance increases by 1;
   - `claimedSupply` increases by 1;
   - minted equals sold plus claimedSupply.
11. **Paid mint and Studio check.** A simulated `purchase(1, 1)` from a funded wallet succeeds. The Studio sale panel loads.
12. **Announcement** only after steps 1–11 pass.

## Emergency

- `pause()` (admin) stops claims immediately. `unpause()` before close resumes them.
- If the allowlist is wrong, pause and do not unpause. The root is immutable; a corrected allowlist needs a new contract, a new grant and a new authorization.

## After close (2026-11-02 04:59:59 UTC)

1. Revoke `ISSUER_ROLE` on the release from the weekend claim. The expired claims were revoked in step 5.
2. Verify that `/api/claims/config` still returns 200; post-close binding does not require the role.
3. Verify that the Studio sale panel edits freely.

## Gas (simulated on mainnet at block 99,066,061, base fee 2.5 gwei)

| Transaction | Gas | Fee at 2.5 gwei |
|---|---|---|
| Deploy | 1,587,195 | ≈ 0.0040 AVAX |
| `grantRole` | 52,623 | ≈ 0.00013 AVAX |
| `activate()` | ≈ 55,000 (estimate) | ≈ 0.00014 AVAX |
| 3 × `revokeRole` (2 before activation, 1 after close) | ≈ 3 × 30,000 (estimate) | ≈ 0.00023 AVAX |
| **Total** | | **≈ 0.0045 AVAX** |

The artist wallet holds 0.1429 AVAX, so no extra funding is needed. Rabby reserves gas limit × max fee up front: about 0.016 AVAX for the deploy at a 2× margin and 5 gwei.
