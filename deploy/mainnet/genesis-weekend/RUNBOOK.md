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

## Owner signing tool (local only)

Steps 4, 5, 6 and 9 are signed from a local page, never from the production site. The page:

- loads only local files: no remote code, a strict CSP, and a vendored ethers 6.17.0;
- is served on 127.0.0.1 only;
- asks Rabby only for `eth_requestAccounts`, `eth_chainId`, `eth_accounts` and one `eth_sendTransaction` per click;
- never asks for a seed phrase, a private key, an approval or a message signature;
- never sends the next transaction on its own.

**Launch** (on the owner's computer, with Rabby on the artist wallet and on Avalanche C-Chain):

```bash
git fetch origin claude/genesis-weekend-claim && git checkout <reviewed commit>
npm ci
node scripts/genesis-weekend-signing-server.mjs
```

The server refuses to start unless every file matches the committed `deploy/mainnet/genesis-weekend/signing/SHA256SUMS`. Open exactly `http://127.0.0.1:8790/` (not `localhost`, not another port) in the browser profile that has Rabby.

**In Rabby, before signing the deploy:**
- from is `0x284C…180a`;
- there is no "to" (it is a contract creation);
- value is 0;
- gas limit is 2,000,000;
- the nonce equals the one the page logs (191 at manifest time).

**If a deploy was sent but the page did not show "Verified":**
1. Do not deploy again.
2. Paste the contract address into **Load existing claim**. It is verified before use.
3. The deploy check also refuses whenever the artist wallet has already created a contract since the manifest was built.

**For each step:**

1. Press **Check and simulate**. At signing time the page checks the account and chain again, re-simulates, and sends an explicit nonce. The check itself:
   - re-verifies the manifest against the artifact, rebuilding the creation data byte for byte;
   - checks the account, the chain, the pending nonce, the balance against gas ceiling × max fee, and the live roles and supply;
   - simulates the exact transaction against the ceiling.
2. Only then does it arm **Sign**.
3. After the receipt, the page verifies:
   - **deploy:** the address equals the predicted one, the runtime matches with immutables masked, and every immutable equals the plan, with the claim inactive and paused;
   - **revoke:** the role is gone;
   - **grant:** the role is held and the claim is still paused;
   - **activate:** the claim is active.
4. Then stop and report. Each step needs its own owner approval.

**Rebuild the manifest** before signing if the nonce or the live roles changed: `node scripts/genesis-weekend-manifest.mjs --out deploy/mainnet/genesis-weekend/signing/manifest.json`. It refuses to write when any check fails.

| Step | To | Call | Gas ceiling | Simulated |
|---|---|---|---|---|
| Deploy | contract creation | `GenesisWeekendClaim(config)` | 2,000,000 | 1,636,179 |
| Revoke 1 | release `0xF0C0…830e` | `revokeRole(ISSUER_ROLE, 0x7D1a…5363)` | 60,000 | 35,134 |
| Revoke 2 | release `0xF0C0…830e` | `revokeRole(ISSUER_ROLE, 0xd70d…66b8)` | 60,000 | 35,134 |
| Grant | release `0xF0C0…830e` | `grantRole(ISSUER_ROLE, <claim>)` | 80,000 | 52,623 |
| Activate | the claim | `activate()` | 90,000 | simulated live at that step |

All are value 0. The wallet must cover each ceiling × (2 × base fee + 1 gwei) when it signs. That is about 0.014 AVAX in total at a 2.5 gwei base fee; fund about 0.02 AVAX.

## Allowlist entries that cannot claim in practice (kept as reviewed; not regenerated)

- `0x5bC2fc6A8538e6913995741234c2512D3ae6ada7` is a contract. It can claim only if its code can call `claim()`; it is probably unable to.
- `0x000000000000000000000000000000000000dEaD` is a burn address and holds no key. It cannot claim.

Both count toward `eligibleWallets` (481), so the claim cap has two slots that will not be used. This does not affect anyone else's claim.
