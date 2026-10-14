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
| Voucher signer | **Dedicated** `0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47` (see below) |
| Release, sale, token | the artist's new release, open edition and sale (steps 1-3) |
| Supply | uncapped: claim and public allocations 0 |
| Schedule | claim 300 s from `claimStart`, then 600 s public sale at 0.01 AVAX (Fuji test values) |

## The dedicated voucher signer

How authorization works (read from `contracts/GenesisHolderClaim.sol`): `claim()` accepts a voucher only if the
EIP-712 signature recovers to the contract's `signer` address. There is no signer role. `ISSUER_ROLE` is a
different thing: the right of the claim contract to mint on the release, granted by the release admin (the artist).
`setSigner` is `onlyAdmin` (the artist wallet).

The claim is deployed with `signer = 0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47`, so no `setSigner` call is needed.
The old `0x…dEaD` placeholder is refused by the plan validator and by the server configuration.

Server configuration (fail closed; `server/genesis-claim.js`):
- `GENESIS_CLAIM_SIGNER_ADDRESS=0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47` (public)
- `GENESIS_CLAIM_SIGNER_PRIVATE_KEY=<secret in Render, never in the repo, logs or the frontend>`
- Startup refuses to enable unless the key derives exactly that address, and the binding check refuses unless the
  deployed claim's `signer()` equals it, the artist has granted the claim `ISSUER_ROLE`, and the sale matches.
- Nick must set the secret himself in Render. It is not set by this change and was not requested or seen.

Claims stay unavailable until the owner separately authorizes: the claim deployment, the artist's `ISSUER_ROLE`
grant (calldata in the plan's `followUps.issuerGrant`), the Render secret and `GENESIS_CLAIM_ENABLED=true`.

## What this step does NOT do

The artist's `ISSUER_ROLE` grant to the claim (calldata is in the plan's `followUps.issuerGrant`), the
server signer key, the Render configuration and
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
signer = the dedicated signer); the claim is not paused. The page then states that the claim is not usable yet.

## Evidence so far

| Tier | Result |
|---|---|
| Local unit tests | `test/fuji-genesis-claim-path.test.mjs`: plan generation and its refusals, chain separation in both directions, validator rules (artist admin, dedicated signer, uncapped, artist grant), the page flow (readiness, stale start, failing constructor, moved nonce, other chain, rejection, duplicate hash, mismatched mined claim, failed or foreign transaction, reload). |
| Local forge | `test/GenesisHolderClaimPlaceholderSigner.t.sol` (above). |
| Local Fuji fork | Real Fuji factory, release, sale; plan generated from them; the page with a stand-in wallet deployed the claim (gas used 1,507,776) and verified it; reload kept it confirmed; the placeholder checks above. Fork transactions only, never sent to Fuji. |
| Fuji read-only / real Rabby / mainnet | None for this step. |
