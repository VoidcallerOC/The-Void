# The Void — Primary Sale State Forensic Audit

**Audit date:** 2026-10-04 00:36 EDT  
**Repository:** `VoidcallerOC/The-Void` at `1cd67c5` (`main`)  
**Scope:** Forgive & Forget Studio primary-sale display

## STATUS

**PARTIAL — on-chain state verified; exact authenticated Studio/API database payload was not fully replayed from this sandbox.**

The important stop condition is satisfied: the displayed claim is **correct on-chain for the current published token**. This is not a false-positive UI claim for that token, so no application-state fix was applied.

## REPRODUCED

**Yes, at the code-path and authoritative-chain level.**

The current Studio flow is:

```text
User opens /studio?release=<release id>
→ GET /studio/catalog (authenticated)
→ mapPublishedCatalog(payload)
→ studioCatalogForConnectedWallet(...)
→ resumeOwnedRelease(catalog, requestedReleaseId)
→ choose the persisted PUBLISHED/AVAILABLE edition carrying tokenIds[0]
→ setPublishedTokenId(resumed.tokenId)
→ setStep("sale")
→ createFujiPublicProvider()
→ readPrimarySale(publicProvider, publishedTokenId, wallet.account)
→ eth_call sales(publishedTokenId) against FUJI_RELEASE_CONFIG.primarySaleAddress
→ decodeSale(...).configured
→ configuredSale.configured === true
→ render "Primary sale configured"
```

Relevant code:

- `src/components/ArtistStudioPage.jsx:161-175` — persisted release recovery and token selection.
- `src/components/ArtistStudioPage.jsx:177-199` — authenticated catalog load and direct public-RPC sale read.
- `src/lib/primary-sale.js:255-285` — `decodeSale` and `readPrimarySale`.
- `src/components/ArtistStudioPage.jsx:861-866` — exact UI condition and text.

## UI SOURCE

The exact render condition is:

```jsx
{configuredSale?.configured ? (
  <div role="status">
    <strong>Primary sale configured</strong>
    ...
  </div>
) : (...)}
```

The UI does **not** use a database sale flag, an indexer sale flag, React session state, or a persisted `primarySale` boolean for this message. `configuredSale` is populated from `readPrimarySale()` using a direct read against the configured primary-sale contract.

## BOOLEAN SOURCE

**Variable:** `configuredSale.configured`  
**Origin:** `sales(tokenId)` return tuple on the configured primary-sale contract  
**Persistence:** not persisted in the browser or database; recomputed on Studio sale-step load  
**Authority:** direct Fuji JSON-RPC `eth_call` at the time of the read

`readPrimarySale()` calls:

```text
sales(uint256 tokenId)
```

and decodes the eighth return value as `configured`.

## IDENTITIES

### Current live sale represented by the displayed state

| Field | Value | Evidence |
|---|---|---|
| Release ID | `forgive-forget-23` | Live `edition(tokenId)` read |
| Edition ID | `forgive-forget` | Live `edition(tokenId)` read |
| Published token ID | `5539478311145551066997171016458124004742133628133122798593311459807321372836` | Live sale event and `edition(tokenId)` read |
| Contract | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `config/fuji-release.json` and live edition read |
| Chain | Avalanche Fuji, chain ID `43113` | `config/fuji-release.json` and live RPC network read |
| Primary sale contract | `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA` | `config/fuji-release.json` and live sale read |
| Sale configuration event | `0x2102efa7a767b0c4b51210a09ab4a921e346ff105c0162afc9516d8434525601` | Live `SaleConfigured` event |
| Sale configuration block | `59022663` | Live event |

The token ID was independently recomputed from the on-chain identifiers using the application’s documented derivation:

```text
keccak256(abi.encode(
  "the-void:edition:v1",
  bytes32("forgive-forget-23"),
  bytes32("forgive-forget")
))
= 5539478311145551066997171016458124004742133628133122798593311459807321372836
```

The computed value matches the live token exactly.

### Older persisted/archive record in repository history

The repository also contains a distinct older Forgive & Forget record:

| Field | Value |
|---|---|
| Release ID | `release-b96d6a64-3379-4da0-b834-ae2e00bf9571` |
| Edition ID | `edition-e2e5abb4-bf03-42d1-9aea-c0b8492c3267` |
| Token ID | `25004510451461692631068377573407424988089298285712621798954341372639713583607` |
| Contract | `0x82b26Da27136935454Bdf1e40801190B521b82e5` |
| Chain | Avalanche Fuji, `43113` |
| Lifecycle | Archived by migration `030_archive_forgive_forget_18.sql` |

This is **not** the same release, edition, token, or contract as the current `forgive-forget-23` sale.

## ON-CHAIN STATE — AUTHORITATIVE

A read-only live Fuji RPC audit was performed against `https://api.avax-test.network/ext/bc/C/rpc`.

For token `5539478311145551066997171016458124004742133628133122798593311459807321372836`:

| Sale field | Live value |
|---|---:|
| `priceWei` | `10000000000000000` |
| Price | `0.01 AVAX` |
| `maxSupply` | `0` — uncapped/open sale |
| `sold` | `0` at audit time |
| `perWalletLimit` | `2` |
| `startTime` | Unix `1791082800` |
| `endTime` | Unix `1791083700` |
| `paused` | `false` |
| `configured` | `true` |

Therefore the rendered text:

```text
Primary sale configured
Price 0.01 AVAX · Open until it stops · 2 per person
```

is an accurate representation of the authoritative sale state for the current live token.

The current release-contract read for the same token also returned:

- `exists: true`
- release ID `forgive-forget-23`
- edition ID `forgive-forget`
- `maxSupply: 0`
- `mintedSupply: 0`
- artist `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a`

## COMPARISON OF REPRESENTATIONS

| Source | Value / finding | Status |
|---|---|---|
| UI state | `configuredSale.configured === true`; 0.01 AVAX, open, limit 2 | Verified from code path and live result |
| API response | Authenticated `/studio/catalog` response was not replayed; public API is a separate older deployment/configuration | Partially verified |
| Database | Current production row was not directly queried from this sandbox | Unverified |
| Indexer | Public readiness endpoint reports old release/sale contracts, not the current V2 frontend contracts | Verified |
| Persisted release | Repository history contains older archived `forgive-forget-18`; current live chain contains `forgive-forget-23` | Verified from code/history and chain |
| Contract | Current V2 release + current primary sale contract report a real configured sale for token `5539…2836` | Authoritatively verified |
| Transaction/event | `SaleConfigured` at block `59022663`, tx `0x2102…5601` | Authoritatively verified |

## FIRST DIVERGENCE

There are two separate situations and they must not be conflated:

1. **For the current `forgive-forget-23` Studio token:** no incorrect value was found. The UI reads the current V2 sale contract and matches the chain.
2. **Between the current frontend/V2 deployment and the public API/indexer deployment:** configuration drift exists. The public API readiness endpoint reports:
   - release contract `0x82b26da27136935454bdf1e40801190b521b82e5`
   - primary-sale contract `0xcc26cd6d6dc25654652d1fbb64db5f61e20f60f1`

   The frontend repository configuration uses:
   - release contract `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6`
   - primary-sale contract `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA`

The public API query for the archived old release returned an empty edition list, and the readiness endpoint showed the old indexer contracts. This is a real deployment/configuration divergence, but it is not evidence that the current Studio claim is false.

## ROOT CAUSE

**No false-positive root cause was established because the claim is correct on-chain for the current published token.**

The user’s observation is explained by an identity/version discrepancy:

- The current live sale is for `forgive-forget-23` / `forgive-forget` / token `5539…2836` on the V2 release and V2 sale contracts.
- Repository history and public API/indexer configuration still contain the older archived `forgive-forget-18` identity and older contract addresses.
- Those are different on-chain objects. Comparing the old record to the current sale will make the state appear inconsistent, but it is not a UI lie for the current token.

## RECENT PUBLISH-SALE FIX CHECK

Commit `226ce8b` (`Fix reload-safe primary sale recovery`) changed the reload path as follows:

### Before

- Studio loaded the catalog but did not automatically reopen a requested published release.
- A published token depended on in-memory/session selection state.
- The sale configuration panel exposed an editable token ID.
- `configureSale` used whatever `publishedTokenId` remained in component state.

### After

- `GET /studio/catalog` is mapped into a wallet-owned catalog.
- `resumeOwnedRelease(catalog, requestedReleaseId)` finds the persisted published/available edition.
- The persisted edition’s `tokenIds[0]` becomes `publishedTokenId`.
- The token field is no longer an editable input in the sale panel.
- `readPrimarySale()` reads the live sale state for that recovered token.
- `configureSale` performs a live sale read before submitting and avoids duplicate configuration.

The fix **did change the data path**, but the current live token recovered by that path is valid and matches the chain. No evidence shows that the fix caused the configured sale display.

## FIX

**No code fix applied.**

Applying any of the following would be incorrect:

- changing the UI text;
- forcing `configured = false`;
- replacing the direct chain read with database state;
- deleting or rewriting sale state;
- repointing production contracts or indexers without a separately approved deployment/configuration change.

The correct next engineering action is to reconcile the frontend V2 deployment with the public API/indexer deployment, after confirming which deployment is intended to be authoritative. That is deployment/configuration work and was intentionally not performed under this audit’s scope.

## REGRESSION TESTS

Focused existing tests were run:

```text
npm test -- --run src/lib/studio-selection.test.js src/lib/studio-resume.test.js src/lib/primary-sale.test.js

3 test files passed
26 tests passed
```

The existing tests cover reload recovery, persisted token association, open-edition quantity restoration, sale encoding, sale supply validation, and RPC/preflight behavior.

No new regression test was added because the investigated UI claim is correct on-chain and no application bug was proven. The deployment drift should receive a separate integration test once the intended release/sale deployment target is decided.

## VERIFIED

- Exact UI render condition and source function identified.
- Direct chain-read behavior verified in source.
- Current live chain ID, release contract, sale contract, token ID, edition identity, sale fields, and configuration event verified.
- Current token ID independently recomputed and matched.
- Older archived Forgive & Forget identity proven distinct from current live identity.
- Recent reload-safe recovery diff inspected; it is not shown to be the cause.
- Focused test suite passed: 26/26.
- Public API readiness endpoint verified to be indexing older contract addresses.

## UNVERIFIED

- The exact authenticated `/studio/catalog` response used by the user’s live Studio session.
- The current production database rows for the active `forgive-forget-23` release.
- The exact browser session screenshot/state that produced the user’s observation.
- Whether the user intended the current `forgive-forget-23` token or the older archived `forgive-forget-18` token.

## BLOCKERS

1. Frontend V2 contract configuration and public API/indexer contract configuration are different.
2. No direct production database access was available in this sandbox.
3. The requested business expectation (“does not correspond”) is not specific enough to distinguish the current live V2 token from the older archived Forgive & Forget record.

## DO NOT REDO

- Do not treat `configuredSale` as a stale React/database boolean; it is populated from a direct live RPC read.
- Do not treat the current `forgive-forget-23` sale as unverified; it is confirmed by the live `SaleConfigured` event and `sales(tokenId)` read.
- Do not attribute the result to the reload-safe recovery fix without new evidence.
- Do not compare the archived `forgive-forget-18` token/contract to the current `forgive-forget-23` sale as if they were the same object.
- Do not modify smart contracts, migrations, production data, RLS, Fuji settings, credentials, Render configuration, or deployment architecture as part of this audit.

## NEXT ACTION

**Confirm which Forgive & Forget identity is intended to be authoritative—current V2 `forgive-forget-23` token `5539478…2836`, or archived prior `forgive-forget-18` token `2500451…3607`—then reconcile the public API/indexer deployment to that same contract set before making any code change.**
