# Genesis claim (24 hours from activation): deployment and activation runbook

Status: **NOT AUTHORIZED.** Every step below that signs a transaction or changes production needs its own owner authorization, given after independent review of the exact commit. Nothing here has been executed.

| Item | Value |
|---|---|
| Contract | `contracts/GenesisWeekendClaim.sol` (source commit `12cc469`) |
| Chain | Avalanche C-Chain 43114 |
| Release / token | `0xF0C091A159DE16cF0F306b2B61d37685EC5A830e` / 1 |
| Paid sale | `0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845`, ends `1794315540` (2026-11-10 12:59:00 UTC) |
| Claim window | Exactly **24 hours (86,400 s) from the activation block**. Set on-chain by `activate()`. It cannot be extended, reset or reopened, and pausing does not stop the clock. |
| Activation deadline | `1793768399` = 2026-11-04 04:59:59 UTC = **Tue 2026-11-03 11:59:59 PM EST**. Owner-proposed; owner must confirm. `activate()` reverts after it. Latest possible close: 2026-11-05 04:59:59 UTC. |
| Admin and signer for every step | Artist wallet `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` (holds DEFAULT_ADMIN_ROLE on the release) |

## Activation and expiry design

- **Deploy:** paused and inactive. `claimStart() == 0`, `claimEnd() == 0`.
- **Constructor bounds on `activationDeadline`:** it must be in the future and at most 7 days after deployment (`MAX_ACTIVATION_DELAY`). The latest possible window, `activationDeadline + 86400`, must close no later than the paid sale's end at deployment (`ClaimWouldOutlastSale`).
- **`activate()`, admin only, once, at or before `activationDeadline`:**
  - re-checks the live sale end, so the window cannot outlast the sale;
  - re-checks the supply invariant;
  - then sets `active = true`, `paused = false`, `claimStart = block.timestamp` and `claimEnd = claimStart + 86400`.
- **`claim()`:** requires active, not paused and `block.timestamp < claimEnd`.
  - `unpause()` is refused at or after `claimEnd`.
  - A second `activate()` reverts (`AlreadyActive`).
- **Never activated by the deadline:** the contract can never open. Revoke its role.
- **Sale compatibility:** the claim mints through its own ISSUER_ROLE and only reads `sales(1).sold` for the supply invariant.
  - `configureSale` never changes `sold`, so sale edits cannot break claim accounting.
  - The window is still kept inside the sale window, so the "claim, then paid mint only" phase order holds. Artist Studio blocks sale end-time edits while the claim can still be activated or is open.
- **API, claim page and Studio** read `active`, `claimStart`, `claimEnd` and `activationDeadline` from the contract.
  - The countdown targets the contract's `claimEnd` and nothing else.
  - The API rejects any state other than inactive-paused-with-no-window, or active with `claimEnd == claimStart + 86400`.

## Snapshot reuse (unchanged allowlist)

The new contract takes the same snapshot fields, with the same leaf, campaign and rule. The manifest's constructor arguments carry the committed snapshot unchanged:

| Field | Value |
|---|---|
| Root | `0x30bd03f5dae8be86fc796a166a68b5629423a7138c5b268f285624db82790f98` |
| Hash | `0x995ca68ef725aedb7f63894dc5ce7310dfaa934452c6fe4c1c0a891c77726eca` |
| Eligible wallets | 481 |
| Blocks | C-Chain 99059260, Grotto 151791 |

**Reproduction evidence (recovered; transcript-only):**
- **Candidate run:** started 2026-10-31 19:30:17 UTC. The generator ran at C-Chain block 99059260 and printed `EXIT 0`, 481 wallets, the root above and the hash above.
- **Rerun:** `--cchain-block 99059260`, started 19:53:01 UTC and finished by 20:33:09 UTC. `EXIT 0`, the same root, hash and count. The automatic comparison printed `IDENTICAL`.
- **Source:** the authoring session's transcript (`session_01A7HbEZDHWV62HhpQFwQTvA`).

**Limitations:**
- The rerun used the same script and the same data sources (explorer, node, Glacier). It was not a separate implementation.
- Its output file (`snapshot-repro.json`) and log were in an ephemeral container and are lost, so there is no file hash to check.
- An independent reviewer separately rebuilt the root from the committed wallet list.

**Exclusions are still valid (2026-11-01, block ~99,124,600):**
- The prior claims' `claimedSupply` is 0 / 2 / 4, unchanged. Their windows are closed.
- All 4 historical claimants are recorded on-chain: `0x6a86…` and `0xaBd3…` on `0x7D1a` and `0xd70d`; `0x920E…` and `0x7077…` on `0xd70d`.
- The contract re-checks all three prior claims on every claim.

## Gates (all must pass, in order)

1. **CI green** on the PR head: Foundry unit and mainnet-fork tests, and vitest.
2. **Independent security review of the modified contract: GO.** The earlier PR #357 GO does not cover this bytecode.
3. **Owner confirms** the activation deadline `1793768399` and the reuse of the Oct 31 snapshot. Holders who acquired Genesis after block 99059260 are not included.
4. **Fund** the artist wallet.
   - The manifest ceiling reservation is 0.01428 AVAX: 2,380,000 gas at 6 gwei.
   - Expected actual spend is about 0.005–0.007 AVAX.
   - **Fund 0.02 AVAX.** This covers the ceilings up to about 8.4 gwei.
5. **Rebuild the manifest** if the nonce, base fee or roles changed: `node scripts/genesis-weekend-manifest.mjs --out deploy/mainnet/genesis-weekend/signing/manifest.json`. Then update `signing/SHA256SUMS` and commit. Require `ok: true` and `funding.sufficient: true`.

## Owner signing order (each numbered write needs its own owner authorization)

| # | Step | To | Call | Gas ceiling | Simulated (block 99,124,576) |
|---|---|---|---|---|---|
| 1 | **[AUTH] Deploy** | contract creation | `GenesisWeekendClaim(config)` | 2,000,000 | 1,672,721 |
| 2 | **[AUTH] Revoke 1** | release | `revokeRole(ISSUER_ROLE, 0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363)` | 60,000 | 35,134 |
| 3 | **[AUTH] Revoke 2** | release | `revokeRole(ISSUER_ROLE, 0xd70dBA7fF6419481d62D4689bDf271ad441766b8)` | 60,000 | 35,134 |
| 4 | **[AUTH] Grant** | release | `grantRole(ISSUER_ROLE, <claim>)` | 80,000 | 52,623 |
| 5 | **[AUTH] Merge** the PR, then **[AUTH] Render**: `GENESIS_CLAIM_MODE=weekend`, `GENESIS_WEEKEND_CLAIM_CONTRACT=<claim>` | — | — | — | — |
| 6 | **[AUTH] Activate** | the claim | `activate()` | 180,000 | about 140,500 on the fork (119,538 execution + 21,000 base) |

All transactions are value 0 and come from the artist wallet. The manifest at block 99,124,576 has nonce 191 and predicts the deploy address `0x6A251b2F591Df265A8D2B42991b4e672236e4F4A`. Deploy data is 10,525 bytes, keccak `0x982c7b92…d526`.

**Checks after each step:**
- **After 1:**
  - runtime code equals the reviewed build (artifact runtime keccak `0x77bb6803…14ba`, immutables masked);
  - root, hash, 481 and both blocks match;
  - `activationDeadline() == 1793768399`;
  - `CLAIM_DURATION() == 86400`;
  - `claimStart() == 0` and `claimEnd() == 0`;
  - baseline 4, admin is the artist, `active() == false`, `paused() == true`.
- **After 2–3:** `hasRole` is false for both expired claims. `/api/claims/config` still returns 200.
- **After 4:**
  - `hasRole(ISSUER_ROLE, claim) == true`;
  - the claim is still inactive and paused;
  - no other new role holder appears in the `RoleGranted` events.
- **After 5:**
  - `GET /api/claims/config` returns 200 with `mode: "weekend-merkle"`, `active: false`, `claimStart: "0"`, `claimEnd: "0"`, `activationDeadline: "1793768399"` and the matching root;
  - `/claim` shows "The Genesis claim has not opened" and no claim button;
  - the Studio sale panel loads;
  - `/api/editions` is unchanged.
- **After 6:**
  - `active() == true`, `paused() == false`;
  - `claimEnd() == claimStart() + 86400`;
  - `/api/claims/config` shows the same `claimStart` and `claimEnd`;
  - the `/claim` countdown targets that `claimEnd`.

**Activation timing:**
- Activate only when holders can be told immediately. The 24 hours start at the activation block, not at the announcement.
- The page shows the close the transaction will produce before Rabby opens.

## Production acceptance checklist (after activation)

1. **[AUTH] Authorized end-to-end claim** from an owner-approved eligible wallet. Verify:
   - receipt status 1;
   - `GenesisWeekendClaimed` emitted;
   - the wallet's token-1 balance increases by 1;
   - `claimedSupply` increases by 1;
   - minted equals sold plus claimedSupply.
2. Eligibility for the same wallet then returns `ALREADY_CLAIMED`. A prior claimant returns `ALREADY_CLAIMED`. A non-snapshot wallet returns `NOT_IN_SNAPSHOT`.
3. A simulated `purchase(1, 1)` from a funded wallet succeeds. The Studio sale panel loads, and end-time edits are blocked while the claim is open.
4. The `/claim` countdown matches `claimEnd() - now` within a few seconds.
5. **[AUTH] Announcement**, stating the exact close in UTC and EST.
6. **At `claimEnd`:**
   - eligibility returns 409 `CLAIM_WINDOW_CLOSED`;
   - `/claim` shows the closed state with the paid mint still open;
   - a claim simulation reverts with `ClaimWindowClosed`.

## Emergency

- `pause()` (admin) stops claims immediately. `unpause()` resumes them before `claimEnd`. **Pausing does not extend the window.**
- If the allowlist is wrong, pause and do not unpause. The root is immutable; a corrected allowlist needs a new contract, a new grant and a new authorization.

## After close (or after the activation deadline if never activated)

1. **[AUTH]** Revoke `ISSUER_ROLE` on the release from the claim.
2. Verify that `/api/claims/config` still returns 200 (after the close the role is not required) and that the Studio sale panel edits freely.

## Owner signing tool (local only)

- Steps 1–4 and 6 are signed from the local page, never from the production site.
- The server refuses to start unless every file matches `signing/SHA256SUMS`.
- Launch and safety rules are unchanged from the previous review:
  - 127.0.0.1:8790 only;
  - vendored ethers 6.17.0;
  - one `eth_sendTransaction` per click;
  - an explicit nonce;
  - simulation against the ceiling before Sign is armed.
- Activation requires ticking the authorization box and typing `ACTIVATE 24-HOUR CLAIM`.

```bash
git fetch origin <reviewed branch> && git checkout <reviewed commit>
npm ci
node scripts/genesis-weekend-signing-server.mjs
```

**In Rabby, before signing the deploy:**
- from is `0x284C…180a`;
- there is no "to";
- value is 0;
- gas limit is 2,000,000;
- the nonce equals the one the page logs.

**If a deploy was sent but the page did not show "Verified":**
1. Do not deploy again.
2. Use **Load existing claim**.

## Reproducible build

```bash
npm install --prefix /tmp/solc-0.8.24 solc@0.8.24
node scripts/genesis-weekend-artifact.mjs --solc /tmp/solc-0.8.24/node_modules/solc --source-commit 12cc4694b4ce50021318c53fd19de5ea95738576
```

- Expected: initcode keccak `0xe6624547…0c11`, runtime keccak `0x77bb6803…14ba`, source keccak `0xadd08221…ed2a`.
- The same script rebuilds the previously reviewed artifact (`cc1535f`) byte for byte. Forge 1.3.1's runtime matches apart from the metadata hash.

## Allowlist entries that cannot claim in practice (kept as reviewed; not regenerated)

- `0x5bC2fc6A8538e6913995741234c2512D3ae6ada7` is a contract. It can claim only if its code can call `claim()`.
- `0x000000000000000000000000000000000000dEaD` is a burn address.

Both count toward `eligibleWallets` (481).
