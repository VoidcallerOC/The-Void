# L5 protected media: evidence reconciliation (2026-10-11)

**Status:**

| Scope | Status |
|---|---|
| L5 on per-release (factory) contracts, the certification target | **NOT STARTED** |
| Protected media on legacy shared Fuji contracts | **PARTIAL** |
| Owner lifecycle-endpoint check | **NOT STARTED** |

Nothing here was signed, sent or changed. All evidence below is from read-only database `SELECT`s, Fuji RPC reads and Render log reads.

## 1. Where the "completed protected-media journey" comes from

No document in this repository records a completed protected-media journey:
- [`SYSTEM-CHAIN-CERTIFICATION.md`](./SYSTEM-CHAIN-CERTIFICATION.md) A6 and [`RELEASE-CERTIFICATION-TARGET-DECISION.md`](./RELEASE-CERTIFICATION-TARGET-DECISION.md) L5 say NOT STARTED;
- [`THE-VOID-SUMMIT-CERTIFICATION.md`](./THE-VOID-SUMMIT-CERTIFICATION.md) says PARTIAL.

The production database (`experience_grants`, `media_authorizations`, `audit_events`) does hold real grant and stream records from **2026-10-03/04**. They are all on **legacy shared contracts**, never on a factory clone. Any report of a completed journey can only rest on these records. They prove part of L5, on the wrong contracts.

## 2. What the records prove (legacy shared contracts, Fuji 43113)

| Check | Evidence | Result |
|---|---|---|
| Owner gets a grant and the protected object | **Contract `0x7Bba0690…95B6`** (shared release V2):<br>• Token `68295446…6023` minted to collector `0x6a86…d2fb`: tx `0x1b4a07ec0531b5c31a031f15739a407dd976f89d29ae0dd7b76cecdb23fa8b9d`, block 59038107, 2026-10-04T14:59:47Z, status 1.<br>• Experience `experience-e8728692…` (PUBLISHED; requires 1 of that token): 17 `GRANT_ISSUED` and 17 `MEDIA_AUTHORIZED`, reason `SIGNED_OBJECT_URL`, 2026-10-04 15:00:34–16:16:49 UTC. Each grant is 5 minutes, chain 43113, ownership watermark at block 59038107. | **VERIFIED** |
| Same, second contract | **Contract `0x82b26Da2…82e5`**:<br>• Token `25004510…3607` minted to the same collector: tx `0x061166137e7597b4cd5be69bcae9d698f63b3586f72adfbbaaf6077f41124678`, block 59012186, status 1.<br>• Experience `experience-0fe2d5b8…` (now ARCHIVED): 12 grants and 12 `SIGNED_OBJECT_URL` authorizations, 2026-10-03 20:40–22:12 UTC. | **VERIFIED** |
| Authenticated non-owner gets 403 and no grant | Wallet `0x284C…180a` was refused on `experience-e8728692…` with `EXPERIENCE_ENTITLEMENT_REQUIRED` (HTTP 403, `server/media-gateway.js` L97), request `3281e67e-1ebd-4c12-a515-b27ad13851a2`, 2026-10-04T15:24:09Z.<br>• Its balance of the token at Fuji block 59038623 (15:23:55Z) was **0**; the collector's was 1.<br>• There is **no** grant row for `0x284C` on any experience. | **VERIFIED** (one instance) |
| Anonymous user refused a grant | `POST /api/media/grants` without a session returns **401** `UNAUTHORIZED` (`requireWalletAuth`), not 403. That refusal is not written to `audit_events`, so no live record exists. | **UNVERIFIED** live. The criterion says "403"; the code returns 401. The owner should confirm that 401 is acceptable. |
| Unknown or forged grant ID refused | 23 `MEDIA_ACCESS_DENIED` / `GRANT_NOT_FOUND` events on `GET /api/media/:grantId` (404), 2026-09-25 → 2026-10-10 | **VERIFIED** (fails closed) |
| Expired or revoked grant refused | 0 `MEDIA_DENIED` and 0 `REVOKED` rows | **UNVERIFIED** live (unit-tested only) |
| Access moves on resale | No grant for any wallet after a transfer | **NOT STARTED** |

**Not counted as protected media:** 4 grants on chain 43114, for the legacy "voidcaller" tracks. They redirect to public IPFS audio (`PUBLIC_IPFS_URL`), so they prove nothing about private storage.

**A design fact that matters for the resale test:** `GET /api/media/:grantId` does not re-check the wallet or the token balance. It accepts any grant that is unexpired and unrevoked (`openMedia`; the tests call it without a session). Ownership is checked only when the grant is issued. A seller's existing grant therefore keeps working until it expires: `MEDIA_GRANT_TTL_SECONDS`, 300 by default, 900 at most. A resale test must wait out that TTL before it checks that the seller has lost access.

## 3. Factory clone fixture (`0x4b27…bB0`): current state

Fixture: `forgive-forget-28`, token `25679935…3312`, from `SYSTEM-CHAIN-CERTIFICATION.md` §2.

**Two published protected experiences** require 1 of that token:
- `experience-560eb3e3…`: FULL_RECORD, audio;
- `experience-3deee1f8…`: DEMO.

Both protected assets exist in `media_assets`, uploaded 2026-10-10.

**Holders, read at Fuji block 59309979:**
- artist `0x284C…180a` holds **1**;
- collector `0x6a86…d2fb` holds **0**.

The collector bought the token (A4) and sold it back to the artist on the V3 marketplace (A7, block 59278616).

**Grants on this clone: 0.** There are also no denials.

## 4. Smallest safe way to get the missing proof (no transaction)

The current holdings already allow an L5 check on a factory clone with **no transaction at all**. These are only wallet sign-ins in the deployed app, made by the owner with their own wallets:

1. **Holder:** sign in as artist `0x284C…` and open `experience-560eb3e3…`.
   - Expect a grant, then playback.
   - Then `media_authorizations` shows `GRANT_ISSUED` and `MEDIA_AUTHORIZED` with reason `SIGNED_OBJECT_URL` for `0x284c…`.
2. **Former holder:** sign in as collector `0x6a86…` and open the same experience.
   - Expect HTTP 403 `EXPERIENCE_ENTITLEMENT_REQUIRED` and no grant row.
   - Its sale at block 59278616 means this also shows access lost after a resale, in the collector-to-artist direction.
3. **No session:** call `POST /api/media/grants` without a session and record the 401.
4. **Write it down:** note the UTC time of each step. Claude then reads the rows and the Render request IDs and records them under A6.

**What this does not cover:**
- a holder other than the artist;
- the full "collector A → collector B" move.

Both need a third-party resale, which is a transaction. Per `SYSTEM-CHAIN-CERTIFICATION.md` §6, they belong in the authorized V3 certification run.

## 5. Owner lifecycle-endpoint check

**No evidence of an owner call.**
- Render logs record only failed requests to `GET /api/studio/releases/:id/lifecycle-editions` since 2026-10-10:
  - 401 without a session, 2026-10-11T14:22:49Z;
  - 403 `ARTIST_ACCESS_DENIED` for a non-owner on `release-6a048309…`, 2026-10-11T14:23:39Z.
- A successful call writes neither a log line nor an audit event.

**Status: NOT STARTED.** To get the evidence:
1. The owner, signed in as the release's artist, opens `GET /api/studio/releases/release-6a048309-d236-4068-bc63-0ae96eb88d8f/lifecycle-editions` in the deployed app.
2. They save the JSON response, which must have `complete: true`, and the time of the call.
