# Launch readiness reconciliation — 2026-10-26

Decision: **NOT READY to announce.** No production change, no transaction, no env change.

## Live read-only evidence (2026-10-26 ~02:35 UTC, block 98566276, chain ts 1792982165)

RPC `https://api.avax.network/ext/bc/C/rpc`, `eth_chainId` = 43114.

| Read | Result |
|---|---|
| `VoidPrimarySale(0xB4dAAe78…3845).sales(1)` | price 0.25 AVAX, maxSupply 0, sold 0, perWallet 3, start **1793019600** (2026-10-26 09:00 ET), end 1793710799 (2026-11-03 07:59:59 ET), **paused = true**, configured = true |
| sale `releases()` | `0xF0C091A159DE16cF0F306b2B61D37685EC5A830e` |
| factory `0xEa0c…54B4.primarySaleOf(release)` | `0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845` |
| API `/api/editions` (Forgive & Forget) | same tuple; `primary_availability: "paused"`; edition row `primary_sale_address` = `0xb4daae…3845`, `factory_address` = `0xea0c…54b4`, `token_id` 1 |
| API `/api/health/ready` | `ok: true`; `contracts.primarySale.address` = legacy `0x6ae84a51…aa3`, `addresses` = [legacy, `0xb4daae…3845`]; `contracts.release.address` = legacy `0x9aa6165b…d103`, `addresses` = [legacy, `0xf0c091…830e`] |
| `www.thevoidstudio.xyz` HTML | `access-control-allow-origin: *`; no nosniff / Referrer-Policy / Permissions-Policy / frame protection |
| shipped `main-6rFAL8JN.js` | Fuji manifests (`chainId:43113`, `chainHexId:0xa869`, Fuji factories) and the Hero's Fuji volume identity (`chainId:43113`) |

## Findings

1. **`paused` is the explicit on-chain pause flag**, not "not started". `VoidPrimarySale.purchase()` reverts
   `SalePaused` before it checks the start time, and `primarySaleAvailability` mirrors that order. The sale is both
   paused and before its start. **At 09:00 ET the sale stays closed unless the owner sends a `configureSale` with
   `paused = false`** (owner decision and transaction; not done here).
2. **Legacy health address is reporting-only.** `reportIndexedContracts` reported `addresses[0]`, and static
   `INDEXER_CONTRACTS_JSON` entries (Render env, `sync: false`) come before factory-discovered contracts. Purchase
   routing uses the edition row's `primary_sale_address` (factory-discovered, verified against
   `primarySaleOf`) — it is `0xb4daae…3845`. The legacy sale is still correctly indexed (it holds a real historical
   purchase and fee balance).

## Code corrections (this PR)

- Health: `address` is the latest factory-discovered contract; static entries stay in `addresses` and a new `staticAddresses`.
- Availability: new `window` (`scheduled` / `in-window` / `ended`) beside `state`; API field `primary_sale_window`;
  paused-before-start label "Sale paused · scheduled …".
- Vercel (both projects): nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY, CSP `frame-ancestors 'none'`
  (enforced — `frame-ancestors` is ignored in Report-Only), `Access-Control-Allow-Origin` set to the site's own origin
  instead of Vercel's default `*`. `/api/*` and the two API-proxied asset paths are excluded, so API CORS is unchanged.
- API JSON responses: `x-content-type-options: nosniff`.
- Mainnet build: Fuji manifests replaced with inert stubs (`build/mainnet-network-gate.js`); Hero Fuji volume identity
  is null on mainnet. CI builds mainnet and runs `scripts/check-mainnet-bundle.mjs`.

## Requires owner approval (not done)

- Unpause sale tokenId 1 on `0xB4dA…3845` (owner `configureSale`, preserving price/supply/limit/start/end).
- Optional: remove the legacy pair from Render `INDEXER_CONTRACTS_JSON` only if historical indexing is no longer wanted
  (not recommended; the code fix makes it unnecessary).
- Deploy this PR (Render API + mainnet Vercel project) after review.
