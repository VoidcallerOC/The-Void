# Release contract administration: operator safety (INFO-02)

**Status:** guidance only. **No contract change.** Nothing here alters on-chain behavior.

**Source:** finding INFO-02 of the internal V5 / Factory V3 review (PASS WITH FINDINGS). That internal review is **not** the independent review that [`V5-DELTA-REVIEW-PACKET.md`](./V5-DELTA-REVIEW-PACKET.md) §1 requires.

**Applies to:**
- `VoidRelease1155V5` clones from Factory V3 (not deployed);
- `VoidRelease1155V4` clones from the live Factory V2 `0x3e4E…3aC8`, which behave the same way here.

Line references are to `main` at `e7dc8e8`.

## 1. Who holds what

When the factory creates a release clone, the roles are set as follows (`VoidCollection1155.sol` L93–96, `VoidRelease1155V5.sol` L79–93):

| Role | Holder | What it allows |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` (`0x00`) | the artist only | `grantRole`, `revokeRole`, `pause`, `unpause`, `createAlbum`, `approveExpandedRelease`, `closeAlbum`; required, together with ARTIST, for `createAlbumTrack` |
| `ARTIST_ROLE` | the artist | `createEdition`, `createEditionWithMintEnd`, `createAlbumTrack` |
| `ISSUER_ROLE` | the release's primary-sale contract (revoked from the artist) | `mint`, `mintBatch` |

**The platform, the factory and the deployer hold no role on a clone.** This is deliberate. It also means **the platform cannot repair any state described below.**

There is no on-chain list of role holders. The current admin set comes only from `hasRole(role, account)` checks and from the `RoleGranted` / `RoleRevoked` event history.

## 2. Contract pause and sale pause are different

| | Contract pause (`pause()` on the release clone) | Sale pause (`VoidPrimarySale.configureSale(..., paused)`) |
|---|---|---|
| Who | `DEFAULT_ADMIN_ROLE` on the clone | the sale configuration for one token |
| In Studio | **not exposed**; direct wallet call only | yes: "Pause sale" / "Unpause sale" |
| Blocks | every new edition and album track, every mint (so all primary purchases), **every transfer** (`safeTransferFrom` / `safeBatchTransferFrom`), so secondary sales and gifts also stop | primary purchases of that one token only |
| Does not block | `grantRole`, `revokeRole`, `renounceRole`, `unpause`, `createAlbum`, `approveExpandedRelease`, `closeAlbum` (INFO-03: same as V4) | transfers, resale, other tokens |

**To stop selling one edition, use the sale pause in Studio, not the contract pause.**

## 3. Hazardous states

Studio has no control for contract `pause`, `renounceRole`, `revokeRole` or `closeAlbum`; none appears in `src/`. Its only role call is reviewer tooling (`encodeFujiGrantRole`, `src/lib/fuji-release.js` L760–770). That tooling grants `ARTIST_ROLE` or `ISSUER_ROLE` on the legacy shared Fuji contract and never grants `DEFAULT_ADMIN_ROLE`. Each hazard below needs a direct wallet call from the artist's admin wallet, for example through a block explorer.

| # | Action | Result | Reversible? |
|---|---|---|---|
| H1 | The **only** admin calls `renounceRole(0x00)`, or `revokeRole(0x00, self)`, **while the contract is paused** | The contract stays paused forever. No holder can transfer or resell a token, no mint or purchase can happen, and no edition can be created. Holders keep their balances but can never move them. | **No.** Nobody can call `unpause`. |
| H2 | The only admin gives up `DEFAULT_ADMIN_ROLE` while the contract is **not** paused | Sales and transfers continue. Nobody can ever pause in an emergency, grant or revoke roles (for example to restore ISSUER to the sale contract), add album tracks, approve expanded limits or close the album. Standalone `createEdition` still works while ARTIST is held and no album exists. | **No.** |
| H3 | The admin grants `DEFAULT_ADMIN_ROLE` to a second address | That address is a full peer. It can revoke the artist's admin role and take sole control, including pause (which leads to H1). | Only while a trusted admin remains |
| H4 | `closeAlbum` with **zero tracks**, or before every planned track exists | No track can ever be added (`AlbumAlreadyClosed`). Standalone editions are refused too, because an album exists (`AlbumTrackPathRequired`). Limits can't be raised (`InvalidExpandedLimits`). With zero tracks, the release contract can never hold any edition. | **No.** The only way forward is a new release (a new clone) in Studio. |
| H5 | The admin revokes `ISSUER_ROLE` from the primary-sale contract | Every purchase for that release fails. | Yes: re-grant it, while an admin exists |

**How this was verified (2026-10-11):** H1–H4 and the "while paused" row in §2 were reproduced on a local Factory V3 / V5 clone. One exception: H2's note on standalone editions is read from the code, not reproduced. I used a temporary Foundry test (forge 1.3.1, the version CI pins): 6 probe cases passed, and the file was deleted, not committed. The existing V5 suite also passed.

## 4. Safe operator procedure

**Before any admin call:**
1. Read `paused()`, `albumCreated()`, `albumClosed()`, `albumTrackCount()`, `albumSingleCount()`, and `hasRole(0x00, <every intended admin>)` on the clone.
2. Write down the expected value of each after the call.

**Rules:**
1. **Never renounce or revoke the last `DEFAULT_ADMIN_ROLE`.** There is no on-chain guard (`renounceRole` has no last-admin check).
2. **Never renounce or revoke any admin role while `paused()` is true.** Unpause first, confirm that `paused()` is false, then change roles.
3. **Handing admin to another wallet, for example the artist's own Safe:**
   1. `grantRole(0x00, new)`;
   2. confirm `hasRole(0x00, new)` is true;
   3. have the new wallet sign one reversible admin call to prove it can act: `pause()` then `unpause()` while no sale is live, or a grant and revoke of a test role;
   4. only then renounce the old admin.
4. **Grant `DEFAULT_ADMIN_ROLE` only to a wallet you would trust to remove you** (H3).
5. **Use the contract pause only in an emergency.** It freezes every holder's transfers. To stop a sale, use the sale pause in Studio.
6. **Before `closeAlbum`:**
   1. `albumTrackCount()` is at least 1 and equals the final track list shown in Studio;
   2. every track that should exist does exist;
   3. the decision is final, because nothing can be added afterwards.

   Mint deadlines already set stay in force after closing.
7. **After every admin call:** read the same values again and compare them with step 2 of "Before any admin call".

## 5. If a hazardous state happens

- **H1:** the contract is permanently frozen. Tell holders plainly that the tokens can't be moved. Any reissue on a new release is a business decision for the artist and the owner; the contract can't migrate or burn the old tokens.
- **H2:** the release keeps working for existing sales and transfers. Any new album or tracks need a new release.
- **H4:** create a new release in Studio for the tracks. The empty album contract stays on-chain as is.
- **Support:** the platform holds no role, so support can't undo any of these. Don't promise a fix.

## 6. Out of scope here

These would need an owner decision, and a Solidity change would need a re-review and a new dry run:
- adding warnings to Studio or the indexer when an admin role is renounced, or an album is closed with zero tracks;
- adding a last-admin guard in a future contract version.

This document changes neither the contracts nor the reviewed scope.
