# Fuji Genesis claim deployment in Rabby (step 4)

**Status: machinery built and rehearsed on a local fork of Fuji; NO plan exists yet and nothing is
authorized or sent.** This is step 4 of the Fuji Genesis plan in `FORGIVE-FORGET-GENESIS-CLAIM.md` §4a.
Fuji test AVAX only (chain 43113). Mainnet is unaffected: no mainnet plan, nonce or address is involved.

## What it does

The Rabby deployer `0xaBd3…c174` deploys one `GenesisHolderClaim` on Fuji, from the same page as the
probe test (`/fuji-rabby-test`), through a plan approved in GitHub and checked again in the browser.

| Parameter | Value |
|---|---|
| Claim admin (pause, rotate the signer) | the artist wallet `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a`, never the deployer |
| Voucher signer | **PLACEHOLDER** `0x000000000000000000000000000000000000dEaD` (see below) |
| Release, sale, token | the artist's new release, open edition and sale (steps 1-3) |
| Supply | uncapped: claim and public allocations 0 |
| Schedule | claim 300 s from `claimStart`, then 600 s public sale at 0.01 AVAX (Fuji test values) |

## The placeholder voucher signer

The claim needs a signer address when it is deployed. The real server signer is deferred (step 6), so the
claim is deployed with the dead address. Nobody holds a signing key for it, so no signature can recover
to it and `claim()` reverts with `InvalidSignature` for every voucher. The approved-plan validator
refuses a Fuji claim plan with any other signer or any admin other than the artist.

Verified, with the worst case (the artist has already granted the claim `ISSUER_ROLE` and the window is open):
- **Local forge** (`test/GenesisHolderClaimPlaceholderSigner.t.sol`, 6 tests): vouchers signed by any key,
  empty, zero or forged signatures are all refused and nothing mints; the deployer, the Nano, a claimant
  and the placeholder cannot rotate the signer or take the admin; the artist can; after the artist's
  `setSigner` only the new signer's voucher mints, it still refuses before `claimStart` and after the
  window, a zero signer is refused, and a paused claim stays paused.
- **Local fork of Fuji** (deployed through the page): the same results on the claim the page deployed:
  every voucher refused (`InvalidSignature`), `setSigner` refused for the deployer and a claimant
  (`Unauthorized`), the artist's `setSigner` accepted, then the new signer's voucher minted one token,
  another key's voucher was refused, and the claim closed at `claimEnd` (`ClaimWindowClosed`).
- **API:** the claim API serves nothing unless `GENESIS_CLAIM_ENABLED` is set and the contract's signer
  equals the address of the server's own signing key (`server/genesis-claim.js`, binding check). With the
  placeholder in place the two can never match, so it answers 503. The server key and Render
  configuration stay deferred; **claims stay unavailable until the owner separately authorizes activation.**

## What this step does NOT do

The artist's `ISSUER_ROLE` grant to the claim (calldata is in the plan's `followUps.issuerGrant`), the
artist's `setSigner(<real signer>)` rotation, the server signer key, the Render configuration and
activation. These are separate, later steps with their own approvals. The owner page offers contract
creations from the deployer only; the artist-wallet transactions are not on it yet.

## Preparing the plan (after the artist has done steps 1-3 on Fuji)

1. The artist creates the release, the open edition (`maxSupply 0`, `mintEnd = claimStart + 300 + 600 - 1`)
   and the sale (`configureSale(token, 0.01 AVAX, 0, 0, claimStart + 300, claimStart + 899, false)`) in
   Studio, and sends the release address, sale address and token ID.
2. `node scripts/fuji-genesis-claim-plan.mjs --release 0x… --sale 0x… --token <id> --claim-start <unix>`
   (key-less; refuses any `*PRIVATE_KEY` variable). It reads the release, edition and sale from Fuji,
   simulates the constructor, and writes `deploy/fuji/approved-plans/genesis-claim-fuji.json`.
   `claimStart` must be at least 10 minutes ahead when the plan is made and at least 2 minutes ahead
   when the owner signs, or the page refuses (the constructor would revert).
3. Claude presents the exact transaction, cost and pass criteria and STOPS. The owner approves the
   specific transaction in writing before any signing; merging the plan PR is not that approval.

## Pass criteria (read from the public Fuji RPC after Rabby signs)

Receipt status 1; chain 43113; from the deployer; the reviewed nonce; no recipient; value 0; the reviewed
creation data; the created address equals the predicted one; every constructor parameter on the deployed
claim equals the plan (release, sale, token, allocations, schedule, price, eligibility rule, admin = artist,
signer = placeholder); the claim is not paused. The page then states that the claim is not usable yet.

## Evidence so far

| Tier | Result |
|---|---|
| Local unit tests | `test/fuji-genesis-claim-path.test.mjs`: plan generation and its refusals, chain separation in both directions, validator rules (artist admin, placeholder signer, uncapped, artist grant), the page flow (readiness, stale start, failing constructor, moved nonce, other chain, rejection, duplicate hash, mismatched mined claim, failed or foreign transaction, reload). |
| Local forge | `test/GenesisHolderClaimPlaceholderSigner.t.sol` (above). |
| Local Fuji fork | Real Fuji factory, release, sale; plan generated from them; the page with a stand-in wallet deployed the claim (gas used 1,507,776) and verified it; reload kept it confirmed; the placeholder checks above. Fork transactions only, never sent to Fuji. |
| Fuji read-only / real Rabby / mainnet | None for this step. |
