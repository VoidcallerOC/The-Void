# Repository cleanup, phase 2 — inventory and branch candidates (2026-11-02)

Follows PR #358. Baseline: `main` at `de99764`. This report records what was checked, what changed, and
what was deliberately left alone. Nothing here changes contracts, deployed addresses, sale or claim
logic, API/indexer behaviour, environment-variable contracts, or Vercel/Render configuration.

## 1. Root inventory (tracked files at `de99764`)

| Path | Files | Bytes | Class | Evidence |
|---|---|---|---|---|
| `.claude/` | 1 | 187 | ACTIVE | `launch.json`: Claude Code preview config (`npm run dev`, port 5173). |
| `.github/workflows/` | 11 | 72,129 | ACTIVE / LEGACY candidates | `ci.yml` runs on push/PR. 10 manual `workflow_dispatch` deploy/verify workflows; see §4. `test/fuji-v2-workflow.test.mjs` and `scripts/deploy-release-per-contract-fuji.test.mjs` read workflow files. |
| `artist-verification/` | 115 | 1,008,078 | ACTIVE | Separate app; excluded from root ESLint (`eslint.config.js`). Not touched. |
| `audit-reports/` | 1 | 6,357 | ARCHIVAL → moved | Single audit doc, linked from 3 docs. Moved to `docs/audits/`. |
| `build/` | 1 | 1,832 | ACTIVE (source, not output) | `build/mainnet-network-gate.js` is imported by `vite.config.js` and `test/mainnet-network-gate.test.mjs`. Not a generated artifact despite the name. |
| `config/` | 11 | 31,272 | ACTIVE | Network/release JSON read by `src/` and `scripts/`; `record` fields point into `deployments/`. |
| `contracts/` | 30 | 298,394 | ACTIVE | Foundry sources (`foundry.toml`). |
| `deploy/` | 34 | 934,147 | ACTIVE + ARCHIVAL | Runbooks, approved/executed signing plans, Genesis weekend signing bundle (`SHA256SUMS`, `manifest.json`), `deploy/mainnet/render.mainnet.yaml`, `deploy/vercel-mainnet/vercel.json` (mainnet Vercel Root Directory). |
| `deployments/` | 6 | 13,180 | ARCHIVAL (machine-written) | Contract deployment records. Referenced by `config/*.json` `record` fields and by workflow artifact paths. |
| `docs/` | 64 | 826,792 | ACTIVE / ARCHIVAL | Index: `docs/README.md`. |
| `private-media/` | 1 | 999 | ACTIVE (boundary) | Only `README.md` tracked; directory is `.gitignore`d. Not moved. |
| `public/` | 83 | 17,735,988 | ACTIVE | Served by Vite/Vercel. |
| `scripts/` | 100 | 931,276 | ACTIVE + some dead | See §3. |
| `server/` | 212 | 2,453,895 | ACTIVE | API + indexer (Render). |
| `src/` | 261 | 2,098,482 | ACTIVE | Frontend. |
| `test/` | 66 | 891,639 | ACTIVE | Foundry `.t.sol` + vitest. |
| `tools/` | 1 | 4,386 | DUPLICATE → removed | See §3. |
| `fuji-rabby-test.html`, `owner-deploy.html` | 2 | 5,879 | ACTIVE | Vite page entries; `/fuji-rabby-test` and `/owner-deploy` rewrites; read by `test/fuji-rabby-path.test.mjs` and `server/mainnet-runtime-config.test.js`. Must stay at root. |
| Other root files | 14 | — | ACTIVE | Tool-required config (`package*.json`, `vite.config.js`, `eslint.config.js`, `foundry.toml`, `Dockerfile`, `render.yaml`, `vercel.json`, `index.html`, `.env.example`, `.gitignore`) and the three preserved docs. |

Totals: 1,014 tracked files, 33 root entries (17 dirs, 16 files) before; 1,012 files, 31 root entries
(15 dirs, 16 files) after, including this report.

## 2. Consolidation decisions

| Pair | Decision | Reason |
|---|---|---|
| `audit-reports/` vs `docs/` | Merged into `docs/audits/` | One file; `docs/audits/` already holds the other audits. Links updated. |
| `scripts/` vs `tools/` | `tools/` removed | Its only file was a byte-identical copy of `public/grant-issuer.html`. |
| `deploy/` vs `deployments/` | **Kept separate** | `deployments/` is written by deploy scripts and referenced by `config/*.json` and workflow artifact globs. Moving it changes deploy tooling output paths and deployment-record locations; that is not a safe cleanup. |
| Root HTML vs test infra | **Kept** | They are live Vite entry pages behind Vercel rewrites, not test harnesses. |
| `build/` | **Kept** | Source code imported by `vite.config.js`, not generated output. Renaming is cosmetic (deferred). |

## 3. Removed files (proof)

| File | Proof it was unnecessary |
|---|---|
| `tools/grant-issuer.html` | SHA-256 `8792378533…a82c4` equals `public/grant-issuer.html`, which is the served and tested copy (`test/grant-issuer-page.test.mjs` reads `public/`). No reference to `tools/` anywhere. |
| `scripts/compile-release.mjs` | Imports `solc`, which is not in `package.json` or `package-lock.json`, so it cannot run. Unreferenced. It compiled only `VoidRelease1155` into `out/`, which `forge build` (`foundry.toml`, CI) produces. |
| `scripts/analyze-leads.mjs` | One-off console analysis of two lead-single candidates. Unreferenced. Reads `public/assets/02-pathway.mp3` / `06-lessons-learned.mp3`, which do not exist and whose location (full masters under `public/`) the media boundary forbids. |
| `opentype.js` (devDependency) | No import anywhere in the repo outside `package.json`/`package-lock.json`. Lockfile diff removes only that package. |

## 4. Retained on purpose

- `deploy/mainnet/executed-plans/*`, `approved-plans/*`, `genesis-weekend/*` (snapshot, historical claims, signing bundle), `deployments/*`: signing manifests and deployment records. Owner approval required for any change.
- 10 manual workflows. `deploy-genesis-claim-fuji.yml`, `deploy-release-fuji.yml`, `deploy-release-v2-fuji.yml`, `deploy-release-factory-v3-fuji.yml`, `deploy-release-per-contract-fuji.yml`, `rehearse-royalty-fuji.yml` sign with `DEPLOYER_PRIVATE_KEY`, which `docs/claims/FORGIVE-FORGET-GENESIS-CLAIM.md` says was deleted. They are LEGACY candidates, but some are read by tests and removal is an owner decision.
- `scripts/Voidcaller-Regular-original.ttf`, `scripts/_glyphs.json`, `scripts/_newK.json`: no consumer script remains, but the `.ttf` may be the only copy of the pre-patch brand font. UNKNOWN; owner to decide.
- `scripts/make-previews.mjs`, `make-previews-ep1.mjs`, `gifs-to-video.mjs`: generators for committed previews and `track-art-vid/`. They expect masters under `public/assets/`, which conflicts with the media boundary. Kept; flagged.
- `scripts/pinata-cert.mjs`, `reconcile-genesis-reservations.mjs`, `settled-sale-code-hash.mjs`: unreferenced but operational (Genesis settlement, sale code-hash profile). Not touched.

## 5. Branch cleanup candidates (no branch was deleted)

Source: `git ls-remote` (227 heads) and the GitHub PR list (365 PRs: 0 open, 353 merged, 12 closed
unmerged), 2026-11-02. "Ahead" counts commits not in `main`; it is inflated for squash-merged branches.
"Files still differing" counts files the branch changed that still differ from `main` today.

Risk key: **LOW** = merged PR with no later commits, or fully contained in `main`. **MEDIUM** = merged PR
but commits were pushed after the merge. **HIGH** = no PR or closed unmerged, with content not in `main`.
**KEEP** = active. Protection status of `main` was not read in this session.

| Category | Risk | Count |
|---|---|---|
| Merged PR, no later commits | LOW | 194 |
| Fully contained in `main` | LOW | 4 |
| Merged PR + commits after merge | MEDIUM | 5 |
| Closed unmerged PR | HIGH | 9 |
| No PR | HIGH | 14 |
| This cleanup branch | KEEP | 1 |
| `main` | KEEP | 1 |

Notable HIGH: `cursor/history-purge-masters-42f8` (history purge, security-relevant),
`codex/genesis-recovery-deployment-record` and `maintenance/genesis-settlement-p0` (Genesis records and
settlement), `cleanup/remove-artist-verification-nested`. Review each before any deletion.

| Branch | PR | PR state | Ahead | Files still differing from `main` | Last commit | Category | Deletion risk |
|---|---|---|---|---|---|---|---|
| `claude/fervent-ride-hi1qgd` | #16 | closed | 125 | 908 | 2026-09-20 | Closed unmerged PR | **HIGH** |
| `claude/forgive-forget-replacement-4l4zr9` | #236 | closed | 778 | 395 | 2026-10-20 | Closed unmerged PR | **HIGH** |
| `claude/loving-hopper-qphbez` | - | - | 934 | 224 | 2026-10-25 | No PR | **HIGH** |
| `claude/nav-integrity-pre-mint` | #228 | closed | 741 | 447 | 2026-10-19 | Closed unmerged PR | **HIGH** |
| `claude/pensive-wozniak-j5cfa0` | #2 | closed | 7 | 944 | 2026-06-17 | Closed unmerged PR | **HIGH** |
| `claude/sleepy-planck-2vc1nq` | #241 | closed | 793 | 406 | 2026-10-21 | Closed unmerged PR | **HIGH** |
| `cleanup/collapse-vercel-api-illusion` | #19 | closed | 139 | 766 | 2026-09-24 | Closed unmerged PR | **HIGH** |
| `cleanup/remove-artist-verification-nested` | - | - | 134 | 773 | 2026-09-24 | No PR | **HIGH** |
| `codex/genesis-recovery-deployment-record` | - | - | 1 | 1 | 2026-10-27 | No PR | **HIGH** |
| `cursor/history-purge-masters-42f8` | - | - | 478 | 611 | 2026-10-07 | No PR | **HIGH** |
| `cursor/pr1-footer-relic-link-abac` | - | - | 630 | 516 | 2026-10-14 | No PR | **HIGH** |
| `cursor/pr2-frontend-a11y-abac` | - | - | 633 | 515 | 2026-10-14 | No PR | **HIGH** |
| `deploy/fuji-certified-36e53ac` | - | - | 66 | 904 | 2026-09-16 | No PR | **HIGH** |
| `feat/claim-eligibility-ui` | - | - | 430 | 630 | 2026-10-05 | No PR | **HIGH** |
| `feat/secondary-listing-owner-flow` | - | - | 431 | 628 | 2026-10-05 | No PR | **HIGH** |
| `fix/baseline-seed-collisions` | - | - | 160 | 744 | 2026-09-25 | No PR | **HIGH** |
| `fix/fuji-marketplace-listing-target` | - | - | 242 | 711 | 2026-10-01 | No PR | **HIGH** |
| `fix/fuji-my-collection-catalog` | - | - | 245 | 709 | 2026-10-02 | No PR | **HIGH** |
| `fix/mobile-header-branding-lockup` | - | - | 2 | 2 | 2026-10-26 | No PR | **HIGH** |
| `maintenance/genesis-settlement-p0` | #354 | closed | 1 | 4 | 2026-10-29 | Closed unmerged PR | **HIGH** |
| `phase10/fuji-staging-completion` | - | - | 24 | 931 | 2026-09-10 | No PR | **HIGH** |
| `task7-grotto-entitlement-ledger` | #352 | closed | 1 | 4 | 2026-10-28 | Closed unmerged PR | **HIGH** |
| `task8-port-live-voidcaller-bridge` | #353 | closed | 1 | 7 | 2026-10-28 | Closed unmerged PR | **HIGH** |
| `feat/provenance-anchor` | #36 | closed/merged | 168 | 736 | 2026-09-25 | Merged PR + commits after merge | **MEDIUM** |
| `feat/provenance-manifest` | #33 | closed/merged | 164 | 740 | 2026-09-25 | Merged PR + commits after merge | **MEDIUM** |
| `feat/provenance-persistence` | #34 | closed/merged | 167 | 737 | 2026-09-25 | Merged PR + commits after merge | **MEDIUM** |
| `feat/studio-provenance-publication` | #37 | closed/merged | 169 | 734 | 2026-09-25 | Merged PR + commits after merge | **MEDIUM** |
| `fix/protected-media-paywall-bypass` | #21 | closed/merged | 132 | 774 | 2026-09-25 | Merged PR + commits after merge | **MEDIUM** |
| `claude/fervent-clarke-lkzair` | - | - | 0 | 0 | 2026-11-01 | ACTIVE (this cleanup PR) | **KEEP** |
| `chore/fuji-workflow-integrity` | #9 | closed/merged | 56 | 919 | 2026-09-16 | Merged PR | **LOW** |
| `chore/release-per-contract-fuji-workflow` | #129 | closed/merged | 414 | 629 | 2026-10-05 | Merged PR | **LOW** |
| `chore/remove-legacy-marketplace-ui` | #62 | closed/merged | 253 | 698 | 2026-10-02 | Merged PR | **LOW** |
| `ci/fuji-v2-primary-sale-workflow` | #35 | closed/merged | 162 | 742 | 2026-09-25 | Merged PR | **LOW** |
| `claude/activate-unified-marketplace` | #244 | closed/merged | 798 | 376 | 2026-10-21 | Merged PR | **LOW** |
| `claude/admiring-maxwell-mk2rjv` | #127 | closed/merged | 411 | 630 | 2026-10-04 | Merged PR | **LOW** |
| `claude/album-factory-wiring` | #152 | closed/merged | 534 | 584 | 2026-10-10 | Merged PR | **LOW** |
| `claude/asset-first-actions` | #247 | closed/merged | 804 | 367 | 2026-10-21 | Merged PR | **LOW** |
| `claude/awesome-brown-aqlm4l` | #256 | closed/merged | 823 | 357 | 2026-10-21 | Merged PR | **LOW** |
| `claude/beautiful-turing-c7ast0` | #289 | closed/merged | 902 | 258 | 2026-10-24 | Merged PR | **LOW** |
| `claude/blissful-bardeen-owyzeq` | #219 | closed/merged | 723 | 460 | 2026-10-18 | Merged PR | **LOW** |
| `claude/bold-planck-aqcxib` | #13 | closed/merged | 131 | 776 | 2026-09-19 | Merged PR | **LOW** |
| `claude/ci-apt-retry` | #277 | closed/merged | 871 | 326 | 2026-10-23 | Merged PR | **LOW** |
| `claude/ci-repair-bridge-nav-grant-page` | #356 | closed/merged | 1 | 2 | 2026-10-31 | Merged PR | **LOW** |
| `claude/clever-cerf-xcecq0` | #154 | closed/merged | 536 | 581 | 2026-10-10 | Merged PR | **LOW** |
| `claude/clever-wright-36374i` | #159 | closed/merged | 550 | 578 | 2026-10-10 | Merged PR | **LOW** |
| `claude/compassionate-carson-nrapg9` | #254 | closed/merged | 819 | 363 | 2026-10-21 | Merged PR | **LOW** |
| `claude/compassionate-dijkstra-pp6j80` | #171 | closed/merged | 597 | 555 | 2026-10-12 | Merged PR | **LOW** |
| `claude/compassionate-johnson-x8095h` | #325 | closed/merged | 11 | 178 | 2026-10-26 | Merged PR | **LOW** |
| `claude/compassionate-planck-bo3112` | #283 | closed/merged | 889 | 274 | 2026-10-23 | Merged PR | **LOW** |
| `claude/cool-euler-kqw57g` | #312 | closed/merged | 959 | 207 | 2026-10-25 | Merged PR | **LOW** |
| `claude/corrected-factory-settled-sale` | #234 | closed/merged | 777 | 395 | 2026-10-20 | Merged PR | **LOW** |
| `claude/deploy-script-settled-factory` | #238 | closed/merged | 778 | 394 | 2026-10-21 | Merged PR | **LOW** |
| `claude/deploy-tooling-album-guards` | #149 | closed/merged | 516 | 596 | 2026-10-10 | Merged PR | **LOW** |
| `claude/deployer-authority-remediation` | #174 | closed/merged | 605 | 541 | 2026-10-12 | Merged PR | **LOW** |
| `claude/direct-token-listing` | #248 | closed/merged | 806 | 367 | 2026-10-21 | Merged PR | **LOW** |
| `claude/discover-upcoming-sales` | #314 | closed/merged | 958 | 207 | 2026-10-25 | Merged PR | **LOW** |
| `claude/edition-integrity` | #215 | closed/merged | 707 | 475 | 2026-10-18 | Merged PR | **LOW** |
| `claude/edition-title-token-row` | #260 | closed/merged | 829 | 351 | 2026-10-22 | Merged PR | **LOW** |
| `claude/exciting-cerf-6ka4a0` | #210 | closed/merged | 698 | 483 | 2026-10-18 | Merged PR | **LOW** |
| `claude/exciting-clarke-uxu2lj` | #270 | closed/merged | 856 | 329 | 2026-10-23 | Merged PR | **LOW** |
| `claude/exciting-knuth-54efc2` | #233 | closed/merged | 772 | 398 | 2026-10-20 | Merged PR | **LOW** |
| `claude/fervent-turing-ogo71g` | #358 | closed/merged | 2 | 0 | 2026-11-01 | Merged PR | **LOW** |
| `claude/fix-create-release` | #265 | closed/merged | 846 | 340 | 2026-10-22 | Merged PR | **LOW** |
| `claude/fix-listing-visibility` | #250 | closed/merged | 810 | 366 | 2026-10-21 | Merged PR | **LOW** |
| `claude/fix-provision-evidence` | #266 | closed/merged | 848 | 338 | 2026-10-22 | Merged PR | **LOW** |
| `claude/fix-release-contract-provenance-anchor` | #143 | closed/merged | 484 | 604 | 2026-10-09 | Merged PR | **LOW** |
| `claude/fix-review-listing` | #249 | closed/merged | 808 | 366 | 2026-10-21 | Merged PR | **LOW** |
| `claude/fix-stale-provisioning-preflight` | #173 | closed/merged | 599 | 554 | 2026-10-12 | Merged PR | **LOW** |
| `claude/forgive-forget-release-acceptance` | #222 | closed/merged | 732 | 456 | 2026-10-19 | Merged PR | **LOW** |
| `claude/friendly-fermi-jiqbmq` | #211 | closed/merged | 700 | 479 | 2026-10-18 | Merged PR | **LOW** |
| `claude/friendly-pascal-m57r46` | #295 | closed/merged | 918 | 233 | 2026-10-25 | Merged PR | **LOW** |
| `claude/fuji-sale-seconds-transfer-pteigo` | #184 | closed/merged | 636 | 513 | 2026-10-14 | Merged PR | **LOW** |
| `claude/full-track-playback` | #230 | closed/merged | 745 | 437 | 2026-10-20 | Merged PR | **LOW** |
| `claude/gallant-keller-nhouz7` | #355 | closed/merged | 2 | 1 | 2026-10-31 | Merged PR | **LOW** |
| `claude/gallant-knuth-laejd8` | #363 | closed/merged | 13 | 2 | 2026-11-01 | Merged PR | **LOW** |
| `claude/genesis-claim-settled-tests` | #261 | closed/merged | 834 | 348 | 2026-10-22 | Merged PR | **LOW** |
| `claude/genesis-concurrent-mint` | #223 | closed/merged | 733 | 452 | 2026-10-19 | Merged PR | **LOW** |
| `claude/genesis-list-for-sale-scroll` | #245 | closed/merged | 800 | 374 | 2026-10-21 | Merged PR | **LOW** |
| `claude/genesis-token-picker` | #246 | closed/merged | 800 | 376 | 2026-10-21 | Merged PR | **LOW** |
| `claude/genesis-unit-consumption-evidence` | #225 | closed/merged | 735 | 452 | 2026-10-19 | Merged PR | **LOW** |
| `claude/genesis-weekend-claim` | #357 | closed/merged | 0 | 0 | 2026-11-01 | Fully contained in main | **LOW** |
| `claude/gracious-hypatia-3rto5b` | #216 | closed/merged | 708 | 475 | 2026-10-18 | Merged PR | **LOW** |
| `claude/gracious-johnson-igqve1` | #275 | closed/merged | 869 | 326 | 2026-10-23 | Merged PR | **LOW** |
| `claude/hopeful-shannon-9qmp7p` | #313 | closed/merged | 958 | 204 | 2026-10-25 | Merged PR | **LOW** |
| `claude/index-album-track-events` | #148 | closed/merged | 516 | 594 | 2026-10-10 | Merged PR | **LOW** |
| `claude/indexer-fairness-claim-planner-gates` | #287 | closed/merged | 899 | 261 | 2026-10-24 | Merged PR | **LOW** |
| `claude/indexer-health-discovered-contracts` | #146 | closed/merged | 527 | 591 | 2026-10-10 | Merged PR | **LOW** |
| `claude/indexer-marketplace-registration` | #145 | closed/merged | 516 | 596 | 2026-10-10 | Merged PR | **LOW** |
| `claude/indexer-unknown-single-topic-events` | #288 | closed/merged | 901 | 261 | 2026-10-24 | Merged PR | **LOW** |
| `claude/inspiring-edison-36aiop` | #212 | closed/merged | 702 | 479 | 2026-10-18 | Merged PR | **LOW** |
| `claude/jolly-cray-csn0x3` | #213 | closed/merged | 704 | 478 | 2026-10-18 | Merged PR | **LOW** |
| `claude/keen-wright-mfhttj` | #329 | closed/merged | 0 | 0 | 2026-10-26 | Fully contained in main | **LOW** |
| `claude/kind-curie-vxakyr` | #326 | closed/merged | 14 | 178 | 2026-10-26 | Merged PR | **LOW** |
| `claude/listing-buy-link` | #255 | closed/merged | 816 | 364 | 2026-10-21 | Merged PR | **LOW** |
| `claude/listing-token-gif` | #252 | closed/merged | 814 | 365 | 2026-10-21 | Merged PR | **LOW** |
| `claude/listing-token-metadata` | #251 | closed/merged | 811 | 366 | 2026-10-21 | Merged PR | **LOW** |
| `claude/loving-euler-9dq2tg` | #269 | closed/merged | 854 | 329 | 2026-10-23 | Merged PR | **LOW** |
| `claude/loving-fermat-36ijus` | #172 | closed/merged | 602 | 553 | 2026-10-12 | Merged PR | **LOW** |
| `claude/loving-gates-psjz5q` | #292 | closed/merged | 910 | 252 | 2026-10-24 | Merged PR | **LOW** |
| `claude/magical-lovelace-6u81ay` | #43 | closed/merged | 181 | 731 | 2026-09-26 | Merged PR | **LOW** |
| `claude/mainnet-fork-acceptance` | #224 | closed/merged | 735 | 452 | 2026-10-19 | Merged PR | **LOW** |
| `claude/modest-gates-3r0q4i` | #365 | closed/merged | 7 | 0 | 2026-11-01 | Merged PR | **LOW** |
| `claude/nav-collection-my-collection` | #271 | closed/merged | 858 | 329 | 2026-10-23 | Merged PR | **LOW** |
| `claude/navigation-integrity` | #227 | closed/merged | 742 | 443 | 2026-10-20 | Merged PR | **LOW** |
| `claude/nice-meitner-gaablg` | #300 | closed/merged | 929 | 224 | 2026-10-25 | Merged PR | **LOW** |
| `claude/optimistic-brahmagupta-dux6q4` | #221 | closed/merged | 730 | 457 | 2026-10-19 | Merged PR | **LOW** |
| `claude/p1-mainnet-labels-contracturi` | #209 | closed/merged | 692 | 487 | 2026-10-16 | Merged PR | **LOW** |
| `claude/peaceful-ptolemy-e9s4dy` | #208 | closed/merged | 692 | 488 | 2026-10-17 | Merged PR | **LOW** |
| `claude/peaceful-wright-x20nvf` | #181 | closed/merged | 629 | 517 | 2026-10-13 | Merged PR | **LOW** |
| `claude/per-edition-publish-guard` | #144 | closed/merged | 516 | 595 | 2026-10-10 | Merged PR | **LOW** |
| `claude/practical-archimedes-3pka15` | #359 | closed/merged | 0 | 0 | 2026-11-01 | Fully contained in main | **LOW** |
| `claude/practical-hamilton-d1g9ev` | #157 | closed/merged | 536 | 583 | 2026-10-10 | Merged PR | **LOW** |
| `claude/reattach-registered-media` | #220 | closed/merged | 728 | 459 | 2026-10-19 | Merged PR | **LOW** |
| `claude/record-unified-marketplace-deployment` | #243 | closed/merged | 796 | 382 | 2026-10-21 | Merged PR | **LOW** |
| `claude/recover-forgive-draft` | #217 | closed/merged | 707 | 475 | 2026-10-18 | Merged PR | **LOW** |
| `claude/relaxed-ramanujan-xh80et` | #10 | closed/merged | 100 | 899 | 2026-09-19 | Merged PR | **LOW** |
| `claude/remove-public-fuji-switch` | #226 | closed/merged | 735 | 447 | 2026-10-19 | Merged PR | **LOW** |
| `claude/remove-registered-media-pickers` | #276 | closed/merged | 868 | 326 | 2026-10-23 | Merged PR | **LOW** |
| `claude/retire-broken-ff-safeguards` | #264 | closed/merged | 844 | 340 | 2026-10-22 | Merged PR | **LOW** |
| `claude/retire-ep-replacement` | #259 | closed/merged | 830 | 349 | 2026-10-22 | Merged PR | **LOW** |
| `claude/reviewer-notifications-header-zy6wet` | #54 | closed/merged | 207 | 722 | 2026-09-27 | Merged PR | **LOW** |
| `claude/sharp-allen-d2rqp7` | #327 | closed/merged | 18 | 172 | 2026-10-26 | Merged PR | **LOW** |
| `claude/sharp-pascal-1ghaga` | #50 | closed/merged | 199 | 730 | 2026-09-27 | Merged PR | **LOW** |
| `claude/single-release-type` | #150 | closed/merged | 529 | 589 | 2026-10-10 | Merged PR | **LOW** |
| `claude/sleepy-bohr-wu5c84` | #189 | closed/merged | 646 | 509 | 2026-10-15 | Merged PR | **LOW** |
| `claude/studio-release-type-reload` | #147 | closed/merged | 516 | 594 | 2026-10-10 | Merged PR | **LOW** |
| `claude/studio-replacement-draft-visible` | #258 | closed/merged | 827 | 352 | 2026-10-22 | Merged PR | **LOW** |
| `claude/studio-single-release-ui` | #151 | closed/merged | 530 | 588 | 2026-10-10 | Merged PR | **LOW** |
| `claude/sweet-rubin-jryp03` | #285 | closed/merged | 887 | 289 | 2026-10-23 | Merged PR | **LOW** |
| `claude/vibrant-mccarthy-vzwf5d` | #257 | closed/merged | 823 | 353 | 2026-10-22 | Merged PR | **LOW** |
| `claude/vigilant-mayer-df23a5` | #366 | closed/merged | 1 | 0 | 2026-11-01 | Merged PR | **LOW** |
| `claude/vigilant-pascal-yzx6vl` | #142 | closed/merged | 512 | 599 | 2026-10-09 | Merged PR | **LOW** |
| `claude/void-mainnet-release-5aacst` | #207 | closed/merged | 689 | 490 | 2026-10-16 | Merged PR | **LOW** |
| `claude/void-unified-marketplace-ox3ldz` | #242 | closed/merged | 794 | 384 | 2026-10-21 | Merged PR | **LOW** |
| `claude/withdraw-original-forgive-forget` | #239 | closed/merged | 778 | 391 | 2026-10-21 | Merged PR | **LOW** |
| `claude/wizardly-franklin-1un7zq` | #192 | closed/merged | 654 | 503 | 2026-10-15 | Merged PR | **LOW** |
| `claude/wonderful-noether-y8s0pl` | #309 | closed/merged | 952 | 209 | 2026-10-25 | Merged PR | **LOW** |
| `claude/youthful-gauss-txdicn` | #304 | closed/merged | 939 | 221 | 2026-10-25 | Merged PR | **LOW** |
| `claude/zealous-keller-hksjv6` | #286 | closed/merged | 897 | 263 | 2026-10-24 | Merged PR | **LOW** |
| `claude/zen-franklin-8cjmzr` | #330 | closed/merged | 0 | 0 | 2026-10-26 | Fully contained in main | **LOW** |
| `claude/zen-shannon-s8a8eb` | #229 | closed/merged | 754 | 426 | 2026-10-20 | Merged PR | **LOW** |
| `config/fuji-v2-platform-fees` | #44 | closed/merged | 183 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `cursor/avalanche-first-wallet-ux-f631` | #205 | closed/merged | 685 | 490 | 2026-10-16 | Merged PR | **LOW** |
| `cursor/connect-chain-before-accounts-f631` | #203 | closed/merged | 680 | 494 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/fuji-secondary-factory-v2-c13d` | #139 | closed/merged | 479 | 610 | 2026-10-08 | Merged PR | **LOW** |
| `cursor/indexer-free-rpc-pacing-575b` | #200 | closed/merged | 674 | 494 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/indexer-rpc-429-backoff-ecc0` | #199 | closed/merged | 672 | 495 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/indexer-rpc-block-range-8762` | #198 | closed/merged | 670 | 495 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/indexer-rpc-post-429-spacing-575b` | #201 | closed/merged | 676 | 494 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/mainnet-auth-https-config-3ad0` | #197 | closed/merged | 667 | 495 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/mainnet-db-tls-self-signed-c931` | #195 | closed/merged | 663 | 497 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/mainnet-fe-auth-config-52a9` | #194 | closed/merged | 661 | 499 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/mainnet-readiness-diagnosis-8bad` | #196 | closed/merged | 665 | 497 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/mainnet-wallet-connect-chain-f631` | #202 | closed/merged | 678 | 494 | 2026-10-15 | Merged PR | **LOW** |
| `cursor/media-boundary-hardening-42f8` | #138 | closed/merged | 470 | 612 | 2026-10-07 | Merged PR | **LOW** |
| `cursor/rabby-connect-chain-evidence-f631` | #204 | closed/merged | 682 | 492 | 2026-10-16 | Merged PR | **LOW** |
| `devin/1789345728-db-baseline-recovery` | #8 | closed/merged | 62 | 905 | 2026-09-17 | Merged PR | **LOW** |
| `docs/canonical-deployment-targets` | #25 | closed/merged | 139 | 759 | 2026-09-25 | Merged PR | **LOW** |
| `feat/artist-verification` | #12 | closed/merged | 129 | 777 | 2026-09-19 | Merged PR | **LOW** |
| `feat/contract-owner-artist-verify` | #28 | closed/merged | 176 | 747 | 2026-09-25 | Merged PR | **LOW** |
| `feat/edition-metadata-anchor` | #38 | closed/merged | 166 | 734 | 2026-09-25 | Merged PR | **LOW** |
| `feat/footer-master-volume` | #117 | closed/merged | 383 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `feat/fuji-lint-pathname` | #7 | closed/merged | 41 | 936 | 2026-09-11 | Merged PR | **LOW** |
| `feat/fuji-nested-api-routes` | #6 | closed/merged | 39 | 936 | 2026-09-11 | Merged PR | **LOW** |
| `feat/fuji-vercel-api` | #5 | closed/merged | 37 | 933 | 2026-09-11 | Merged PR | **LOW** |
| `feat/genesis-rpc-queue` | #342 | closed/merged | 1 | 2 | 2026-10-26 | Merged PR | **LOW** |
| `feat/genesis-rpc-telemetry` | #343 | closed/merged | 1 | 2 | 2026-10-26 | Merged PR | **LOW** |
| `feat/legacy-genesis-mainnet-album` | #27 | closed/merged | 151 | 754 | 2026-09-25 | Merged PR | **LOW** |
| `feat/native-artist-verification` | #15 | closed/merged | 128 | 773 | 2026-09-19 | Merged PR | **LOW** |
| `feat/provenance-publication-on-main` | #40 | closed/merged | 175 | 734 | 2026-09-25 | Merged PR | **LOW** |
| `feat/remove-summit-demo-release` | #14 | closed/merged | 125 | 892 | 2026-09-19 | Merged PR | **LOW** |
| `feat/secondary-listing-owner-merge` | #132 | closed/merged | 432 | 624 | 2026-10-05 | Merged PR | **LOW** |
| `feat/seed-voidcaller-legacy-catalog` | #32 | closed/merged | 157 | 744 | 2026-09-25 | Merged PR | **LOW** |
| `feat/v4-open-edition-source-only` | #136 | closed/merged | 454 | 614 | 2026-10-06 | Merged PR | **LOW** |
| `feat/verification-mark-wallet-copy` | #17 | closed/merged | 130 | 773 | 2026-09-20 | Merged PR | **LOW** |
| `fix/add-track-to-release` | #109 | closed/merged | 354 | 673 | 2026-10-03 | Merged PR | **LOW** |
| `fix/admin-only-publishing-role-controls` | #124 | closed/merged | 399 | 644 | 2026-10-03 | Merged PR | **LOW** |
| `fix/archive-forgive-forget` | #112 | closed/merged | 374 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `fix/artist-portfolio-local` | #122 | closed/merged | 396 | 646 | 2026-10-03 | Merged PR | **LOW** |
| `fix/audio-retry-diagnostics` | #331 | closed/merged | 1 | 1 | 2026-10-26 | Merged PR | **LOW** |
| `fix/claims-config-rpc-503` | #338 | closed/merged | 1 | 2 | 2026-10-26 | Merged PR | **LOW** |
| `fix/collection-card-grid` | #317 | closed/merged | 966 | 200 | 2026-10-25 | Merged PR | **LOW** |
| `fix/discover-grid-auto-fit` | #315 | closed/merged | 965 | 200 | 2026-10-25 | Merged PR | **LOW** |
| `fix/duplicate-open-experience` | #30 | closed/merged | 155 | 746 | 2026-09-25 | Merged PR | **LOW** |
| `fix/experience-upload-types` | #105 | closed/merged | 354 | 675 | 2026-10-03 | Merged PR | **LOW** |
| `fix/fuji-broadcast-assertion` | #131 | closed/merged | 427 | 626 | 2026-10-05 | Merged PR | **LOW** |
| `fix/fuji-edition-tuple-decoding` | #41 | closed/merged | 177 | 733 | 2026-09-25 | Merged PR | **LOW** |
| `fix/fuji-open-edition-addresses` | #108 | closed/merged | 363 | 665 | 2026-10-03 | Merged PR | **LOW** |
| `fix/fuji-v2-isolation-command-check` | #47 | closed/merged | 189 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `fix/fuji-v2-package-script-validation` | #48 | closed/merged | 191 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `fix/fuji-v2-preflight-dispatch-gate` | #46 | closed/merged | 187 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `fix/genesis-claim-late-deployment` | #318 | closed/merged | 967 | 195 | 2026-10-25 | Merged PR | **LOW** |
| `fix/genesis-eligibility-backoff-cache` | #334 | closed/merged | 2 | 2 | 2026-10-26 | Merged PR | **LOW** |
| `fix/genesis-fallback-off` | #340 | closed/merged | 1 | 2 | 2026-10-26 | Merged PR | **LOW** |
| `fix/genesis-getlogs-cap-100` | #333 | closed/merged | 1 | 3 | 2026-10-26 | Merged PR | **LOW** |
| `fix/genesis-head-balance-fallback` | #345 | closed/merged | 2 | 3 | 2026-10-27 | Merged PR | **LOW** |
| `fix/genesis-persisted-scan-checkpoint` | #337 | closed/merged | 1 | 4 | 2026-10-26 | Merged PR | **LOW** |
| `fix/genesis-retry-after-budget` | #341 | closed/merged | 1 | 4 | 2026-10-26 | Merged PR | **LOW** |
| `fix/genesis-rpc-rotation` | #339 | closed/merged | 1 | 3 | 2026-10-26 | Merged PR | **LOW** |
| `fix/hide-archived-title-drafts` | #118 | closed/merged | 388 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `fix/hide-forgive-forget-collect` | #125 | closed/merged | 399 | 645 | 2026-10-03 | Merged PR | **LOW** |
| `fix/hide-unpublish-voidcaller` | #114 | closed/merged | 380 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `fix/indexer-lease-restart-wait` | #26 | closed/merged | 142 | 764 | 2026-09-25 | Merged PR | **LOW** |
| `fix/keep-legacy-unpublish-lock` | #116 | closed/merged | 383 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `fix/main-self-titled-ep-volume-and-token-ownership` | #57 | closed/merged | 238 | 710 | 2026-10-01 | Merged PR | **LOW** |
| `fix/mainnet-rpc-config-and-verify-button` | #29 | closed/merged | 155 | 746 | 2026-09-25 | Merged PR | **LOW** |
| `fix/marketplace-hero-local` | #120 | closed/merged | 392 | 652 | 2026-10-03 | Merged PR | **LOW** |
| `fix/media-stream-premature-close` | #335 | closed/merged | 1 | 1 | 2026-10-26 | Merged PR | **LOW** |
| `fix/mobile-creator-withdraw` | #336 | closed/merged | 1 | 1 | 2026-10-26 | Merged PR | **LOW** |
| `fix/open-edition-window` | #107 | closed/merged | 361 | 667 | 2026-10-03 | Merged PR | **LOW** |
| `fix/plain-supply-choice` | #111 | closed/merged | 371 | 664 | 2026-10-03 | Merged PR | **LOW** |
| `fix/release-hero-edition-artwork` | #316 | closed/merged | 966 | 199 | 2026-10-25 | Merged PR | **LOW** |
| `fix/render-metadata-directory` | #58 | closed/merged | 240 | 710 | 2026-10-01 | Merged PR | **LOW** |
| `fix/rls-lockdown` | #23 | closed/merged | 140 | 764 | 2026-09-25 | Merged PR | **LOW** |
| `fix/studio-open-edition-quantity` | #119 | closed/merged | 390 | 660 | 2026-10-03 | Merged PR | **LOW** |
| `fix/studio-publish-release-id` | #39 | closed/merged | 164 | 742 | 2026-09-25 | Merged PR | **LOW** |
| `fix/unlocked-experience-selector` | #332 | closed/merged | 1 | 1 | 2026-10-26 | Merged PR | **LOW** |
| `fix/unpublish-full-length-previews` | #20 | closed/merged | 131 | 773 | 2026-09-25 | Merged PR | **LOW** |
| `fix/unpublish-mintable-only` | #115 | closed/merged | 382 | 663 | 2026-10-03 | Merged PR | **LOW** |
| `fix/visible-secondary-listing-unavailable` | #133 | closed/merged | 434 | 624 | 2026-10-05 | Merged PR | **LOW** |
| `fuji-primary-sale-v2` | #22 | closed/merged | 136 | 767 | 2026-09-25 | Merged PR | **LOW** |
| `phase-5a-fuji-v2-config` | #49 | closed/merged | 197 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `prepare/fuji-v2-read-only-preflight` | #45 | closed/merged | 185 | 730 | 2026-09-26 | Merged PR | **LOW** |
| `record-mainnet-factory-marketplace` | #193 | closed/merged | 659 | 499 | 2026-10-15 | Merged PR | **LOW** |
| `recover/production-platform-launch-gate` | #4 | closed/merged | 57 | 909 | 2026-09-16 | Merged PR | **LOW** |
| `vercel/install-and-configure-vercel-w-ijih9o` | #56 | closed/merged | 231 | 714 | 2026-10-01 | Merged PR | **LOW** |
| `visual-reliquary` | #135 | closed/merged | 442 | 618 | 2026-10-05 | Merged PR | **LOW** |
