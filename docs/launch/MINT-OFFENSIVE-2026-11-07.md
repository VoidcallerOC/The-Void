# Forgive & Forget mint offensive — live verification, conversion audit, outreach kit

Evidence date: 2026-11-07 12:50–12:55 UTC. Chain state read at C-Chain block 99,673,579 (indexer checkpoint) and via explorer logs.
Status vocabulary: COMPLETE | PARTIAL | BLOCKED | UNVERIFIED | NOT STARTED. Nothing in this pass wrote to production, the chain, the database, Render or Vercel.

## 1. Live verification (chain authority order: receipts/logs → contract state → API → docs)

| # | Question | Answer | Status | Source |
|---|---|---|---|---|
| 1 | Is the sale open now? | **Yes.** Window `startTime` 1793019600 (2026-10-26 13:00 UTC) → `endTime` 1794315540 (**2026-11-10 12:59 UTC**), `paused` false, `configured` true. ~72 h left at evidence time. | VERIFIED_AT_BLOCK | `SaleConfigured` logs on sale `0xb4daae78a53c33f52c6eb573c4d6efc7b86f3845`, last at block 99,061,195 (tx `0x6d98f518…fa06`); `/api/editions` mirrors the same values |
| 2 | Price / limits | **0.25 AVAX** (250000000000000000 wei), open edition (`maxSupply` 0), **3 per wallet**, platform fee 250 bps. | VERIFIED_AT_BLOCK | same logs |
| 3 | Paid mints so far | **2** (`Purchased` events): tx `0x529d14e2…8711` block 98,632,166 (2026-10-26 15:28 UTC) buyer `0xb4f6…cee9`; tx `0xd877ec4c…d7b4` block 99,028,648 (2026-11-02 14:14 UTC) buyer `0xe109…5206`. Each qty 1, paid 0.25 AVAX. | VERIFIED | explorer logs, topic `0xb38e1187…f7b0` |
| 4 | Revenue | Gross **0.5 AVAX**. Artist cut 0.24375 ×2 = **0.4875 AVAX**, withdrawn by `0x284C…180a` (two `Withdrawn` events, txs `0xe7f6c176…28ca`, `0xc1bf3031…2160`). Platform 0.00625 ×2 = 0.0125 AVAX (`PlatformPaid` to `0xb65C…1ce4`). At 8.24 USDT/AVAX (Crypto.com ticker, 12:53 UTC) gross ≈ US$4.12. | VERIFIED | explorer logs |
| 5 | Free claims (never counted as paid) | **11** Genesis claims minted token 1 via claim contracts `0x7D1a…5363` (2), `0xd70d…66b8` (2), `0x6a25…4f4a` (7). Claim window closed 2026-11-02 14:18:40 GMT. Total token 1 supply = 13 (2 paid + 11 claimed). | VERIFIED | `TransferSingle` from 0x0 on release `0xf0c091a159de16cf0f306b2b61d37685ec5a830e`; /claim page |
| 6 | Are the two paid buyers independent? | Both wallets have organic Avalanche history since 2021 (first funding Feb 2021 and Sep 2021, prior third-party NFT mints). Neither is the deployer, artist, or platform wallet. | VERIFIED (history) / independence of persons UNVERIFIED | explorer tx lists |
| 7 | Sale deadline history | Originally configured to end 2026-11-03 13:17 UTC; reconfigured 2026-10-31 16:32 UTC (block 99,039,737) to 2026-11-10 12:59 UTC. The Oct 26 launch post said "open for 7 days", so public copy must now state the Nov 10 date explicitly. | VERIFIED | `SaleConfigured` logs |
| 8 | User-facing mint path | Production `https://www.thevoidstudio.xyz` (Vercel project `the-void-vercel-mainnet`, API `the-void-api-mainnet.onrender.com`, readiness `ok:true`, indexer lag 35 blocks, `last_error` null). Site-wide mint banner, home mint hero, edition page with `COLLECT · 0.25 AVAX`, deadline, per-wallet limit, playable preview. No console errors, no failed requests, desktop and iPhone viewport. A wallet transaction was **not** executed in this pass. The Nov 2 purchase is the latest end-to-end proof the path works. | PARTIAL (UI verified; tx path proven by a third party on 2026-11-02) | Playwright run, screenshots in session scratchpad |
| 9 | Prior outreach | Found: Oct 26 launch post on X (`@VoidcallerOC`: 24-hour free claim for first-relic holders, then 7 days at 0.25 AVAX) and a follow-up aimed at Avalanche/Grotto holders ("a key waiting"). No outreach found after that. No Gmail threads, no campaign docs in Drive. Discord "The Grotto": 779 members, 101 online at check time. War Room log not readable from this session (401 without token). | PARTIAL | web search, Discord invite API, Gmail/Drive search |

Pipeline from the claim: 620 C-Chain Genesis candidate wallets + 11 Grotto wallets in the snapshot; 11 claimed. ~609 known holders of the first relic have not acted on this release.

## 2. Conversion audit (buyer's view). Ranked. No code was changed.

| Rank | Friction | Evidence | Fix owner |
|---|---|---|---|
| P1 | **Mobile browser cannot mint.** Connect requires an injected provider only; no WalletConnect. Safari/Chrome on phone gets "No wallet detected. Install MetaMask or Core." | `src/lib/wallet-connect-flow.js:54`; no WalletConnect dependency in `src/` | Dev (code). Until fixed, every outreach message must say: *on mobile, open thevoidstudio.xyz inside the Core or MetaMask app browser.* |
| P1 | **Sale and release contracts unverified on Snowtrace.** Wallets show an "unverified contract" warning at the moment of payment. | Etherscan API: "Contract source code not verified" for `0xb4da…3845`; acceptance doc notes the same for the release implementation | Owner: publish source verification (foundry `forge verify-contract`, no on-chain change, no funds) |
| P2 | **Three wallet prompts to buy**: connect → sign-in signature ("Authenticate the connected wallet before collecting") → transaction. The sign-in step is unexplained. | `src/components/CollectPanel.jsx:188,299` | Dev (copy or flow) |
| P2 | **Mobile banner loses title and price**: reads "MINTING NOW · 3 DAYS LEFT · MINT →". | iPhone 13 viewport capture | Dev (CSS) |
| P2 | **No "how do I get AVAX" or USD reference** on the edition page; the nav item BRIDGE is for legacy editions and reads like a step in the purchase. | edition page text; /bridge page | Dev (copy). Outreach copy covers it meanwhile. |
| P3 | **Home page below the hero sells the old relic**: hardcoded "477 bearers / 1,620 relics forged", footer contract `0xd1b4…98ee` (Genesis), block "47,118,302". | `src/data.js:40-48` | Dev (data). Not a blocker. |
| P3 | **Operator language above the fold on mobile** after the Collect button: "Offers are loaded from the indexed backend… READY → WALLET_CONFIRMATION → …". | edition page | Dev (copy) |

What works: price, deadline and per-wallet limit are visible on every page; preview plays without a wallet; pages load in 4–6 s; the sale window, price and supply shown on the site match on-chain state exactly.

## 3. Outreach kit (artist voice: short lines, declarative, no hype, no emoji walls, relic/bearer vocabulary)

Facts every message must keep true: price 0.25 AVAX; closes **Mon 10 Nov, 12:59 UTC**; open edition; 3 per wallet; Avalanche C-Chain; the Genesis free claim is closed; minting unlocks the full track and the "Stranger Things" demo in the Reliquary. Never state demand, scarcity or counts that are not on chain.

### A. X — main post (publish now)
```
Forgive & Forget is minting until Monday, 10 Nov, 12:59 UTC.

0.25 AVAX · open edition · 3 per wallet · Avalanche C-Chain.
Mint it and the full track and the Stranger Things demo open in your Reliquary.

thevoidstudio.xyz

On your phone: open the link inside the Core or MetaMask app browser.
```

### B. X — reply to the Oct 26 launch post (same day as A)
```
Update to this: the mint window was extended. It now closes Monday 10 Nov, 12:59 UTC.
The 24-hour Genesis claim is closed. The 0.25 AVAX mint is open to everyone until then.
```

### C. X — for first-relic holders who missed the claim (quote the Grotto/avax "key waiting" post)
```
If you held the first relic and missed the 24-hour claim: the claim is over, no second window.
The mint is open to you the same as anyone, 0.25 AVAX, same wallet, Avalanche C-Chain, until Monday 10 Nov, 12:59 UTC.
```

### D. Discord — The Grotto, public channel (one post, pinned if allowed)
```
FORGIVE & FORGET — mint closes Monday 10 Nov, 12:59 UTC

Open edition, 0.25 AVAX, up to 3 per wallet, Avalanche C-Chain.
Minting puts the full track and the Stranger Things demo in your Reliquary on thevoidstudio.xyz.

How to mint
1. Wallet: Core or MetaMask, switched to Avalanche C-Chain.
2. Hold at least 0.3 AVAX there (0.25 + gas).
3. Desktop: thevoidstudio.xyz → Mint. Phone: open that link inside the Core or MetaMask app browser; a normal phone browser cannot connect.
4. Connect → sign the login message (no cost) → confirm the 0.25 AVAX transaction.

The Genesis free claim closed on 2 Nov and will not reopen.
Questions here; I'll answer.
```

### E. X — final 24 hours (Sun 9 Nov, ~13:00 UTC)
```
Last day for Forgive & Forget. Mint closes tomorrow, Monday, 12:59 UTC.
0.25 AVAX · thevoidstudio.xyz
```

### F. X — after close (Mon 10 Nov, after 13:00 UTC). Fill with on-chain numbers only.
```
Forgive & Forget mint is closed.
[N] minted at 0.25 AVAX, [M] claimed by first-relic bearers. [N+M] copies exist.
Thank you to every bearer. The chain remembers.
```

### G. Reply template for "how much is that in dollars?"
```
0.25 AVAX. At today's rate about US$[x]; the price is fixed in AVAX, so check your wallet at the moment you mint.
```
(At 12:53 UTC on 7 Nov, 0.25 AVAX ≈ US$2.06.)

### Rules of engagement
- Post only from the official account (`@VoidcallerOC`) and the artist's own Discord identity. No DMs to strangers; reply to anyone who asks.
- No paid promotion, no engagement groups, no "almost sold out" (it is an open edition), no price predictions.
- Communities: only ones where the artist already has standing (The Grotto; Avalanche music/NFT spaces the artist already follows). Post under each community's rules; one post per community.
- Agents: Grok has brand assets (kit v1.3, 2026-10-25, in Drive) and can cut a 1080×1080 from `07-Marketing-Templates`; Manus can run the Snowtrace verification runbook if authorized; Muse is not needed for this window. Do not duplicate this kit elsewhere.

## 4. Measurement (re-run before each report; never count claims as paid)

- Paid mints: count `Purchased` logs (topic0 `0xb38e11876b1b665d8cb9ffd958cc1cd3641c05af15d5ceddad4b1065eeaaf7b0`) on `0xb4daae78a53c33f52c6eb573c4d6efc7b86f3845` from block 98,367,434.
- Revenue: sum `paid` in those logs; artist share = `artistCut`; withdrawn = `Withdrawn` logs to `0x284C…180a`.
- Free claims: `TransferSingle` from 0x0 on `0xf0c091a159de16cf0f306b2b61d37685ec5a830e` where `operator` ≠ the sale contract.
- Quick check: `GET https://the-void-api-mainnet.onrender.com/api/editions` → `primary_sale.sold` (indexer view; chain logs win on conflict).
- Baseline at this report: paid 2 · gross 0.5 AVAX · claims 11 · published outreach since 26 Oct: 0 found.

## 5. Handoff

- STATUS: PARTIAL
- TASK: Forgive & Forget mint offensive — live verification, conversion audit, outreach kit, measurement baseline.
- VERIFIED: sale open to 2026-11-10 12:59 UTC at 0.25 AVAX, 3/wallet, open edition; 2 paid mints, 0.5 AVAX gross, 0.4875 AVAX withdrawn by the artist; 11 free claims; production site renders the mint path with correct figures; API and indexer healthy.
- CHANGED: this document only.
- EVIDENCE: on-chain log tx hashes above; `/api/health/ready`, `/api/editions`; Playwright captures of home and edition pages (desktop and iPhone).
- UNVERIFIED: a mint transaction from a fresh wallet in this pass (not executed); whether the two buyers are unconnected people; War Room priorities (log not readable here); any outreach done outside X/Discord.
- BLOCKERS: no X/Discord posting credentials in this session (publishing is the artist's action); mobile-browser minting needs a code change; Snowtrace verification needs the owner.
- DO NOT REDO: chain reconciliation above; site audit; outreach drafts A–G.
- NEXT ACTION: Nick publishes post A on X and post D in The Grotto today, with the mobile instruction included verbatim.
