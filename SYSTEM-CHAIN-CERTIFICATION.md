# System Chain Certification Ledger — 2026-10-11

**Purpose.** The platform is one chain of dependencies. A change to one link does not certify the chain. This ledger records, link by link, what has been proven end to end on Fuji 43113 and what has not.

**Evidence rules:** [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md). Tier 1 means receipts and logs. Tier 2 means contract state. Tier 5 means API and indexer records. No mocked, simulated or unit-test result counts toward a link.
**Network:** Avalanche **Fuji only**. Nothing here is evidence for C-Chain. C-Chain remains **NO-GO** ([`LAUNCH-GATE.md`](./LAUNCH-GATE.md)).
**Mode:** read-only. No transaction was signed or sent. No configuration was changed.

---

## 1. The chain

| # | Link | What "certified" means |
|---|---|---|
| L1 | **Artist Studio** | A real artist wallet creates a release and its tracks/experiences through the deployed UI. |
| L2 | **API + PostgreSQL** | The release, edition, metadata and contract binding are persisted. They match the chain. |
| L3 | **Release factory → release contract + sale contract** | The canonical factory creates the clone and its sale. The edition is issued, and a collector (≠ artist) buys it. |
| L4 | **Indexer → catalog → marketplace and earnings** | Chain events are projected into the API. Resale settles on canonical V3. The artist's earnings are withdrawable. |
| L5 | **Collector ownership → protected experience** | An authenticated owner receives a media grant. A non-owner receives 403. Private media is served only to the owner. |

The platform is **certified** only when **one fixture** passes L1–L5 in a single traceable run, on the canonical contracts, with evidence for every row.

---

## 2. Ledger, Path A (standalone release) on the album-capable pair

Canonical pair: factory `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8` (implementation `0x45c3…E452`), ReleaseMarketplaceV3 `0xa464edb22C4959943334DB07001e3ba63989C898`.

Fixture: release `forgive-forget-28` (API `release-6a048309…`, `releaseType: "SINGLE"`), clone `0x4b2790791E2Ac123Cb012D33CC8F1ECbdc9b9bB0`, sale `0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3`, token ID `25679935302133066722236771263728427871936411831072189551573738559199048803312`.
Wallets: artist `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a`, collector `0x6a86EfA012fEDA64b70112022487fEE22E67d2fb`.

| Row | Link | Step | Evidence | Tier | Status |
|---|---|---|---|---|---|
| A1 | L3 | `createRelease` through the factory | Tx `0x0dcf2c16…48160`, block 59276295, 2026-10-10T18:20:29Z, from artist. `ReleaseInitialized(key 0xc689…d22f, artist, sale 0xfb13…)`. Artist holds `DEFAULT_ADMIN_ROLE` and `ARTIST_ROLE`. `ISSUER_ROLE` is granted to the sale contract and revoked from the artist. | 1 | **VERIFIED** |
| A2 | L2 | Release bound in the API | `/api/editions` returns `release_contract_address 0x4b27…`, `factory_address 0x3e4e…`, `primary_sale_address 0xfb13…`, `releaseKey` equal to the on-chain key. | 5 | **VERIFIED_AT** 2026-10-11T02:00Z |
| A3 | L3 | `createEdition` | Tx `0x0b62e365…c145`, block 59276831, 2026-10-10T18:43:00Z. `EditionCreated` (open edition, max supply 0), URI `ipfs://QmSTFQ4b…h1xVM`, royalty 250 bps to the artist. | 1 | **VERIFIED**. The metadata-to-Pinata match was not checked. |
| A3b | L3 | Sale configured | 2 sale-contract txs (`0x33a1c0c4…`, `0xccbc21f5…`) emit the same event topic `0xd79fcad8`. The API reports price 0.01 AVAX, per-wallet limit 1, end time 1791660600. | 1 + 5 | **PARTIAL**. The event was not decoded against the ABI. |
| A4 | L3 | Primary purchase, collector ≠ artist | Tx `0x7aff87dd…d4dd`, block 59277724, 2026-10-10T19:22:02Z. 0.01 AVAX. `Purchased`: 0.00975 to the artist, 0.00025 platform fee. Mint `TransferSingle` 0x0 → collector, qty 1. | 1 | **VERIFIED** |
| A4b | L4 | Primary sale reflected in the API | `/api/editions` `primary_sale.sold = "1"`. This matches the chain. | 5 | **VERIFIED_AT** 2026-10-11T02:00Z |
| A5 | L4/L5 | Collector ownership in the API | Not checked: the ownership endpoint needs an authenticated session. | — | **UNVERIFIED** |
| A6 | L5 | Protected media: owner grant succeeds, non-owner gets 403 | No grant or denial exists for this fixture (0 rows on `0x4b27…`). Owner grants and one non-owner 403 exist only on the legacy shared contracts `0x7Bba…` and `0x82b26…` (2026-10-03/04). Holdings now allow a check with no transaction ([`L5-PROTECTED-MEDIA-EVIDENCE.md`](./L5-PROTECTED-MEDIA-EVIDENCE.md) §4). | — | **NOT STARTED** |
| A7 | L4 | Resale on canonical V3 | `ApprovalForAll` tx `0xd4fde44b…`. `ListingCreated` #1 at 0.02 AVAX, tx `0x62a82d0b…9310`. `ListingSold` #1, tx `0x8f8ce11d…a61cc`, block 59278616: royalty 0.0005, fee 0.0005, token collector → **artist**. | 1 | **PARTIAL**. Settlement is proven, but the buyer is the artist, so this was not a third-party resale. |
| A8 | L4 | Artist withdraws earnings | `Withdrawn(artist, 0.00975 AVAX)`, tx `0x0a2ce136…0e46`, block 59278650, 2026-10-10T20:04:06Z. | 1 | **VERIFIED** |
| A9 | L1 | All of the above performed through the deployed Studio UI | The txs are from the artist wallet and the API rows exist. No UI session record links the two. | 6–7 | **UNVERIFIED** |
| A10 | L4 | Indexer covers every canonical contract | `/api/indexer/health` lists both factories, both marketplaces, all 4 clones and all 5 sale contracts. Lag is 15–19 blocks. `last_error: null`. | 5 | **VERIFIED_AT** 2026-10-11T02:00Z |

Current state, Fuji block 59288058: `balanceOf(artist) = 1`, `balanceOf(collector) = 0` for this token.

**Path A verdict: PARTIAL.** L2–L4 are proven on-chain and agree with the API. L5 has never been exercised live. L1 is inferred, not recorded.

---

## 3. Record conflict (correction)

[`ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md`](./ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md) §6 is dated 2026-10-10T22:50Z. It says *"Path A has not been re-run end to end on the new pair."*

That statement is **CONFLICT**: the tier-1 receipts in §2 show A1, A3, A4, A7 and A8 mined between 18:20Z and 20:04Z the same day, before the re-verification. The higher tier wins. That doc now carries a pointer to this correction.

The §6 findings on capability and wiring (S1–S3) stand. So does "Paths B and C NOT STARTED". This probe confirms `albumCreated() = false` on both new clones, and finds no `AlbumCreated` log.

---

## 4. What a component PR does and does not prove

[VoidcallerOC/The-Void#158](https://github.com/VoidcallerOC/The-Void/pull/158) makes Studio Earnings read `releasesOf(wallet)` and `primarySaleOf(release)` from every configured factory. Studio can then find sale contracts the API did not report.

| Claim | Proven by #158? |
|---|---|
| Earnings UI survives an API that omits a binding | Yes, by unit test |
| The configured factory list is the canonical, deployed factory | **No.** It reads whatever `FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS` contains. Per-factory read errors are silently skipped. |
| A release can be created on that factory | No. A1 above proves it, independently of #158. |
| An album can be created | No. Path B is NOT STARTED. |
| A collector can buy and unlock | Purchase: no (A4 proves it independently). Unlock: **no; nothing does yet**. |
| Withdraw works | No. A8 proves it on-chain. Whether the #158 UI found sale `0xfb13…` from the factory is **UNVERIFIED**. |

**Rule going forward.** A PR may claim only the row it moves. For any PR that touches L1–L5, the description must name the ledger row and the evidence tier it changes. "Tests pass" moves no row.

---

## 4b. V3/V5 (provenance at creation): source only, not deployed

`VoidReleaseFactoryV3` + `VoidRelease1155V5` (commit `1e95f5b`) commit the edition's provenance root in the edition-creating transaction. The clone emits the `VoidProvenanceAnchor`-compatible `ProvenanceAnchored` event and exposes `isAnchored`. Root-less creation reverts with `ProvenanceRootRequired`.

| Claim | Status | Evidence |
|---|---|---|
| D3 lifecycle guard in V5 source (`createAlbum` refused after a standalone edition) | **PARTIAL** (PR pending review, not merged) | `contracts/VoidRelease1155V5.sol`; [`RELEASE-CERTIFICATION-TARGET-DECISION.md`](./RELEASE-CERTIFICATION-TARGET-DECISION.md) §4a. V5 changed after the source audit, so a delta review is required before broadcast. |
| Atomic provenance anchoring exists in source | **VERIFIED** (source only) | `contracts/VoidRelease1155V5.sol`, `config/release-network.js` (`PROVENANCE_AT_CREATION_RELEASE_VERSION = 3`) |
| Foundry/unit tests pass | Not counted | Tests are not chain evidence (see evidence rules) and were not re-run for this entry. |
| V3/V5 deployed on Fuji | **NOT STARTED** | No V3/V5 address in `config/fuji-release-per-contract-v2.json`, `config/` or `deployments/`. The active factory is `VoidReleaseFactoryV2` (`releaseVersion: 2`). This is a repository record. It does not prove that no undeclared V3 deployment exists on chain. |
| V3/V5 integrated live (API, indexer, Studio) | **NOT STARTED** | Nothing to integrate against until there is a deployment. |
| An anchored edition was created live | **NOT STARTED** | No V3 factory, so no `ProvenanceAnchored` event from a release clone. |

**Rule.** Source code and passing tests move no row in §2 or §5. V3/V5 rows change only with a deployment record (tier 1 receipt + tier 2 code/state) and a live edition created on that deployment.

### Album acceptance (Path B) on the deployed V2/V4 pair

Probe of 2026-10-11T02:14Z, tip block 59288557: factory `0x3e4E…3aC8` `releaseCount = 2`. `albumCreated() = false` on clone `0xBf75…4CB9` and on clone `0x4b27…9bB0`. **No album has been created on the new V2/V4 factory.** Album acceptance has not begun. Path B: **NOT STARTED**.

---

## 5. Open items blocking certification

Ordered by severity. P0 means it blocks any claim that the chain is certified.

| # | Pri | Item | Owner | Status |
|---|---|---|---|---|
| 1 | P0 | **A6 / L5 never run on a factory clone.** An authenticated owner must get a grant and stream. A non-owner must get 403 with no grant row. Legacy shared contracts: PARTIAL ([`L5-PROTECTED-MEDIA-EVIDENCE.md`](./L5-PROTECTED-MEDIA-EVIDENCE.md)). | Operator + Claude (evidence) | NOT STARTED |
| 2 | P0 | **Protected masters are publicly reachable.** `refs/pull/{1,2,3,5,6,7}/head` still contain 10 full-length MP3s (36.1 MB) in this public repo ([`ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md`](./ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md) §5). Gating cannot be certified while masters are public elsewhere. **Owner decision (2026-10-11): the repository will be made private after mainnet launch; this is not a pre-launch blocker, and no purge or history rewrite is planned.** | Owner | NOT STARTED (privatization follows launch) |
| 3 | P1 | A5: ownership in the API for the current holder | Claude, with an authenticated read | UNVERIFIED |
| 4 | P1 | A7 is a self-resale. It needs a third wallet (≠ artist, ≠ first collector) to buy on V3. | Operator | PARTIAL |
| 5 | P1 | **D1 is still undecided.** The API labels this fixture `releaseType: "SINGLE"`, but on-chain it is a standalone edition, not an album track with `single = true`. The code has **three** meanings (standalone S1, album single S2, linked S3); none is shown in the public UI. Recommendation: keep all three with distinct labels ([`RELEASE-CERTIFICATION-TARGET-DECISION.md`](./RELEASE-CERTIFICATION-TARGET-DECISION.md) §4). | Owner decision | OPEN |
| 6 | P1 | **Which contracts to certify albums on.** V2/V4 is deployed. V3/V5 (with provenance at creation) is on `main` but **not deployed and not integrated live** (§4b). Certifying both doubles the work. If V3/V5 is chosen, deployment comes first. Read-only preflight recommends **deploy V3/V5 first, then certify**. Activation is gated on fixing Studio release creation for in-flight V2 provisioning requests ([`RELEASE-CERTIFICATION-TARGET-DECISION.md`](./RELEASE-CERTIFICATION-TARGET-DECISION.md) §3 7a, §5). | Owner decision | OPEN |
| 7 | P2 | Paths B (album) and C (single). No `albumCreated() = true` on any clone of the V2/V4 factory as of block 59288557. Rows B1–B11, C1–C2 are tracked separately from deployment in [`RELEASE-CERTIFICATION-TARGET-DECISION.md`](./RELEASE-CERTIFICATION-TARGET-DECISION.md) §6. | After items 5 and 6 | NOT STARTED |
| 8 | P2 | Indexer health reports `database_failures: 137` (cumulative counter, cause unknown). `last_error` is null. | Claude: read the Render logs | UNVERIFIED |

---

## 6. Certification protocol (one run, one bundle)

1. **Freeze the target.** Decide items 5 and 6. Record the factory, implementation and V3 addresses and the Vercel/Render deploy SHAs at the start block.
2. **One fixture, three wallets:** artist, collector A and collector B (all distinct).
3. **Run L1→L5 in order through the deployed UI.** Capture each tx hash at the moment it is mined. Mark A9 VERIFIED only if a UI session record links each tx.
4. **After each step,** capture the API read that should reflect it, with a timestamp. That gives the lag.
5. **L5:** collector A gets a grant and plays the stream. Collector B and an anonymous user get 403. After collector A sells to collector B on V3, A's access is revoked and B's is granted.
6. **Close the run** with the read-only probes (`fuji-release-capability-probe.mjs`, plus a receipt decode for the run). Commit one evidence file under `deployments/`.
7. **Status is COMPLETE** only if every row is VERIFIED at tier 1–2 (chain) or tier 5 (API), with a cited source. Otherwise it is PARTIAL.

---

## 7. Reproduction

Read-only; public Fuji RPC `https://api.avax-test.network/ext/bc/C/rpc`.

```bash
node scripts/fuji-release-capability-probe.mjs        # S1–S3, clone list, albumCreated()
# Receipts: eth_getTransactionReceipt on each tx in §2; decode with the event
# declarations in contracts/*.sol plus the OpenZeppelin ERC-1155 / AccessControl events.
curl -sS https://the-void-api-fuji.onrender.com/api/editions
curl -sS https://the-void-api-fuji.onrender.com/api/indexer/health
```

Probe of 2026-10-11T01:58Z: tip block 59288030. `albumCapable = true`, `v3ParityOnChain = true`, factory `releaseCount = 2`, `albumCreated() = false` on both clones.
Probe of 2026-10-11T02:14Z: tip block 59288557. Same result: `releaseCount = 2`, `albumCreated() = false` on both clones, `implementationMatchesConfig = true`.
