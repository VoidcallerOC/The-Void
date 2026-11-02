# The Void — documentation index

One index for the repository's runbooks, contract records, launch history, audits and archived reports.

**How to read these documents.** Every report here is historical evidence from the date it was written. A status
written inside a document (PARTIAL, BLOCKED, READY FOR OWNER DECISION and so on) is the status on that date, not
today. On-chain state wins over any document: see the evidence rules in [`CHAIN-AUTHORITY.md`](../CHAIN-AUTHORITY.md).
Current priorities and handoffs are tracked outside this repository (War Room / `MASTER.md`); this index does not
replace them.

## Entry points (repository root)

These stay at the root on purpose.

| Document | Purpose |
| --- | --- |
| [`README.md`](../README.md) | Product, architecture and repository overview |
| [`LAUNCH-GATE.md`](../LAUNCH-GATE.md) | Launch prerequisites, verified scope and recovery runbooks |
| [`CHAIN-AUTHORITY.md`](../CHAIN-AUTHORITY.md) | Evidence-tier rule: which source wins when evidence conflicts |

## Active runbooks — deployment and signing

The owner signs mainnet transactions in Rabby. No mainnet key belongs in GitHub.

| Document | Purpose |
| --- | --- |
| [`deploy/mainnet/OWNER-SIGNING.md`](../deploy/mainnet/OWNER-SIGNING.md) | Owner signing in Rabby (C-Chain mainnet): `npm run sign:mainnet` |
| [`deploy/mainnet/README.md`](../deploy/mainnet/README.md) | Coordinated Avalanche C-Chain (43114) launch runbook |
| [`deploy/mainnet/DEPLOYMENT-AUTHORITY.md`](../deploy/mainnet/DEPLOYMENT-AUTHORITY.md) | Mainnet deployment authority |
| [`deploy/mainnet/SEQUENTIAL-LAUNCH.md`](../deploy/mainnet/SEQUENTIAL-LAUNCH.md) | Forgive & Forget sequential-ID launch: irreversible steps for owner approval |
| [`deploy/mainnet/GENESIS-CLAIM-PUBLISHED-RELEASE.md`](../deploy/mainnet/GENESIS-CLAIM-PUBLISHED-RELEASE.md) | Deploying the Genesis claim against an already-published release |
| [`deploy/mainnet/FUJI-FIRST-GATE.md`](../deploy/mainnet/FUJI-FIRST-GATE.md) | Fuji-first gate for the royalty-locked launch candidate |
| [`deploy/mainnet/PREFLIGHT-2026-10-12.md`](../deploy/mainnet/PREFLIGHT-2026-10-12.md) | Mainnet preflight, 2026-10-12 (read-only) |
| [`deploy/vercel-mainnet/README.md`](../deploy/vercel-mainnet/README.md) | Mainnet web build (Avalanche C-Chain) |
| [`deploy/fuji/GENESIS-CLAIM-DEPLOY.md`](../deploy/fuji/GENESIS-CLAIM-DEPLOY.md) | Fuji Genesis claim deployment in Rabby |
| [`deploy/fuji/RABBY-TEST.md`](../deploy/fuji/RABBY-TEST.md) | Fuji Rabby test of the owner-signing page |
| [`C-CHAIN-PRODUCTION-RUNBOOK.md`](C-CHAIN-PRODUCTION-RUNBOOK.md) | Avalanche C-Chain production runbook |
| [`DB-RECOVERY-RUNBOOK.md`](DB-RECOVERY-RUNBOOK.md) | Database migration recovery (Render / Fuji) |
| [`FUJI-STAGING.md`](FUJI-STAGING.md) | Fuji staging runbook |

## Genesis claim records — [`claims/`](claims/)

| Document | Purpose |
| --- | --- |
| [`GENESIS-RECOVERY-FINAL-SIGNING-CHECKLIST-2026-10-27.md`](claims/GENESIS-RECOVERY-FINAL-SIGNING-CHECKLIST-2026-10-27.md) | Genesis recovery final signing checklist (most recent signing package) |
| [`FORGIVE-FORGET-GENESIS-CLAIM.md`](claims/FORGIVE-FORGET-GENESIS-CLAIM.md) | Forgive & Forget Genesis claim + open edition design and evidence |
| [`GENESIS-RESALE-ROOT-CAUSE.md`](claims/GENESIS-RESALE-ROOT-CAUSE.md) | Genesis secondary resale root cause (2026-10-20) |
| [`FORGIVE-FORGET-RELEASE-ACCEPTANCE.md`](FORGIVE-FORGET-RELEASE-ACCEPTANCE.md) | Forgive & Forget (single) release acceptance checklist |
| [`GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md`](GENESIS-MARKETPLACE-DEPLOYMENT-PLAN.md) | LegacyCollectionMarketplace deployment, security gates, rollback |
| [`GENESIS-MARKETPLACE-AUDIT-PACKAGE.md`](GENESIS-MARKETPLACE-AUDIT-PACKAGE.md) | LegacyCollectionMarketplace human audit package |
| [`adr/0001-genesis-legacy-collection-marketplace.md`](adr/0001-genesis-legacy-collection-marketplace.md) | ADR: Genesis legacy collection marketplace |

**Bridge.** The fail-closed Grotto bridge path is covered by the Genesis recovery signing checklist above. The
legacy Grotto bridge web page (commit `79d6b96`, `src/components/BridgePage.jsx`) has no dedicated Markdown record.

## Contract, payment and release decision records — [`contracts/`](contracts/)

| Document | Purpose |
| --- | --- |
| [`PAYMENT-ARCHITECTURE-CORRECTION.md`](contracts/PAYMENT-ARCHITECTURE-CORRECTION.md) | P0 payment architecture correction and artist Earnings view |
| [`PAYMENT-FIX-ACTIVATION.md`](contracts/PAYMENT-FIX-ACTIVATION.md) | Mainnet payment fix: verified findings and activation checklist |
| [`FACTORY-FEE-FIX.md`](contracts/FACTORY-FEE-FIX.md) | Corrected factory: automatic 2.5% platform settlement on primary sales |
| [`UNIFIED-MARKETPLACE-READINESS.md`](contracts/UNIFIED-MARKETPLACE-READINESS.md) | Unified marketplace architecture, evidence and deployment readiness |
| [`DEPLOYER-AUTHORITY-ROTATION-PLAN.md`](contracts/DEPLOYER-AUTHORITY-ROTATION-PLAN.md) | Deployer authority rotation: P0 review and unsigned package |
| [`P0-PRE-EXECUTION-DECISION.md`](contracts/P0-PRE-EXECUTION-DECISION.md) | P0 pre-execution decision report: deployer authority rotation (Fuji) |
| [`FUJI-SAFE-REPLAY-PLAN.md`](contracts/FUJI-SAFE-REPLAY-PLAN.md) | Deploying the owner's 2-of-3 Safe on Fuji |
| [`FUJI-V3-OWNER-DECISIONS.md`](contracts/FUJI-V3-OWNER-DECISIONS.md) | Factory V3 owner decisions D2 and D5, and dry-run evidence |
| [`V5-DELTA-REVIEW-PACKET.md`](contracts/V5-DELTA-REVIEW-PACKET.md) | VoidRelease1155V5 / Factory V3 independent delta review packet |
| [`RELEASE-ADMIN-SAFETY.md`](contracts/RELEASE-ADMIN-SAFETY.md) | Release contract administration: operator safety (INFO-02) |
| [`RELEASE-CERTIFICATION-TARGET-DECISION.md`](contracts/RELEASE-CERTIFICATION-TARGET-DECISION.md) | Release certification target: V3/V5 preflight and decision record |
| [`RELEASE-ARCHITECTURE-RECOVERY.md`](contracts/RELEASE-ARCHITECTURE-RECOVERY.md) | Release architecture recovery (2026-10-09) |
| [`ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md`](contracts/ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md) | Album / single redeploy package and acceptance matrix |
| [`RELEASE-ERC1155.md`](RELEASE-ERC1155.md) | The-Void release ERC-1155 |
| [`PROVENANCE-AT-PUBLICATION.md`](PROVENANCE-AT-PUBLICATION.md) | Provenance at publication (Factory V3 / VoidRelease1155V5) |

Deployment transaction records stay in [`deployments/`](../deployments/) and approved/executed signing plans in
[`deploy/mainnet/`](../deploy/mainnet/) and [`deploy/fuji/`](../deploy/fuji/). They were not moved.

## Launch history — [`launch/`](launch/)

| Document | Purpose |
| --- | --- |
| [`LAUNCH-READINESS-RECONCILIATION-2026-10-26.md`](launch/LAUNCH-READINESS-RECONCILIATION-2026-10-26.md) | Launch readiness reconciliation, 2026-10-26 |
| [`LAUNCH-PATH-RECONCILIATION.md`](launch/LAUNCH-PATH-RECONCILIATION.md) | Launch-path reconciliation: primary-sale fee fix without breaking Genesis (2026-10-21) |
| [`FINAL-LAUNCH-REPORT.md`](launch/FINAL-LAUNCH-REPORT.md) | Final launch report (2026-09-10) |

## Certification and chain evidence — [`certification/`](certification/)

| Document | Purpose |
| --- | --- |
| [`SYSTEM-CHAIN-CERTIFICATION.md`](certification/SYSTEM-CHAIN-CERTIFICATION.md) | System chain certification ledger (Fuji 43113) |
| [`CHAIN-AUTHORITY-FUJI-VERIFICATION.md`](certification/CHAIN-AUTHORITY-FUJI-VERIFICATION.md) | Fuji chain-authority verification |
| [`FUJI-MARKETPLACE-RECONCILIATION.md`](certification/FUJI-MARKETPLACE-RECONCILIATION.md) | Fuji marketplace reconciliation and canonical V3 authority audit |
| [`L5-PROTECTED-MEDIA-EVIDENCE.md`](certification/L5-PROTECTED-MEDIA-EVIDENCE.md) | L5 protected media evidence reconciliation |
| [`FUJI-CERTIFICATION.md`](certification/FUJI-CERTIFICATION.md) | Fuji staging certification (2026-09-12) |
| [`FUJI-CONTRACT-DEPLOYMENT-VERIFICATION.md`](certification/FUJI-CONTRACT-DEPLOYMENT-VERIFICATION.md) | Fuji contract deployment verification (2026-09-10) |
| [`FUJI-INFRASTRUCTURE-VERIFICATION.md`](certification/FUJI-INFRASTRUCTURE-VERIFICATION.md) | Fuji staging infrastructure verification (2026-09-10) |
| [`FUJI-STAGING-REPORT.md`](FUJI-STAGING-REPORT.md) | Fuji staging report |

## Audits and forensics — [`audits/`](audits/)

| Document | Purpose |
| --- | --- |
| [`MAINNET-INDEXER-LATENCY.md`](audits/MAINNET-INDEXER-LATENCY.md) | Mainnet indexer latency measurement and settlement fix |
| [`MARKETPLACE-COMPATIBILITY-AUDIT.md`](audits/MARKETPLACE-COMPATIBILITY-AUDIT.md) | Marketplace compatibility: Genesis + corrected-factory collections |
| [`PRODUCTION-CONTRACT-ADDRESS-DRIFT-AUDIT.md`](audits/PRODUCTION-CONTRACT-ADDRESS-DRIFT-AUDIT.md) | Production contract address drift audit |
| [`PRIMARY-SALE-STATE-FORENSIC-AUDIT.md`](audits/PRIMARY-SALE-STATE-FORENSIC-AUDIT.md) | Primary sale state forensic audit |
| [`INDEXER-CONTRACT-DRIFT-REMEDIATION-READINESS.md`](audits/INDEXER-CONTRACT-DRIFT-REMEDIATION-READINESS.md) | Indexer contract drift remediation readiness |
| [`INDEXER-CONTRACT-DRIFT-REMEDIATION-EXECUTION.md`](audits/INDEXER-CONTRACT-DRIFT-REMEDIATION-EXECUTION.md) | Canonical Fuji contract configuration remediation |
| [`CLEAN-FUJI-E2E-FORENSICS.md`](audits/CLEAN-FUJI-E2E-FORENSICS.md) | Clean Fuji end-to-end forensics |
| [`CREATE-RELEASE-SELECTOR-FORENSICS.md`](audits/CREATE-RELEASE-SELECTOR-FORENSICS.md) | Create Release selector forensics |
| [`WALLET-MODAL-DISMISSAL-FORENSICS.md`](audits/WALLET-MODAL-DISMISSAL-FORENSICS.md) | Wallet popup dismissal regression forensics |
| [`PROTECTED-MEDIA-SECURITY.md`](audits/PROTECTED-MEDIA-SECURITY.md) | Protected media security report |
| [`PRODUCTION-INFRASTRUCTURE-AUDIT.md`](PRODUCTION-INFRASTRUCTURE-AUDIT.md) | Production infrastructure audit (2026-09-09) |
| [`SUPABASE-RENDER-CONSOLIDATION-AUDIT-2026-10-23.md`](SUPABASE-RENDER-CONSOLIDATION-AUDIT-2026-10-23.md) | Supabase → Render consolidation audit |
| [`THE-VOID-DATABASE-RLS-INVESTIGATION.md`](THE-VOID-DATABASE-RLS-INVESTIGATION.md) | Database connectivity and RLS investigation |
| [`NAVIGATION-AUDIT-2026-10-19.md`](NAVIGATION-AUDIT-2026-10-19.md) | Navigation integrity audit |
| [`audits/01-release-per-contract-implementation.md`](audits/01-release-per-contract-implementation.md) | Release-per-contract implementation audit |
| [`audits/REPO-CLEANUP-PHASE-2-2026-11-02.md`](audits/REPO-CLEANUP-PHASE-2-2026-11-02.md) | Repository cleanup phase 2: inventory, removals, branch candidates |

## Product and feature design

| Document | Purpose |
| --- | --- |
| [`PHASE-3-MARKETPLACE-LISTINGS.md`](PHASE-3-MARKETPLACE-LISTINGS.md) | Phase 3: marketplace listings |
| [`PHASE-5-COLLECTOR-EXPERIENCE.md`](PHASE-5-COLLECTOR-EXPERIENCE.md) | Phase 5: collector experience |
| [`PHASE-6-EXPERIENCES.md`](PHASE-6-EXPERIENCES.md) | Phase 6: experiences |
| [`PHASE-7-FINAL-PLATFORM.md`](PHASE-7-FINAL-PLATFORM.md) | Phase 7: final platform foundation |
| [`PHASE-10-MARKETPLACE-COMMERCE.md`](PHASE-10-MARKETPLACE-COMMERCE.md) | Phase 10: marketplace deployment and durable commerce |
| [`metadata-publishing.md`](metadata-publishing.md) | Metadata publishing |
| [`primary-experience.md`](primary-experience.md) | Primary experience |
| [`studio-registered-media.md`](studio-registered-media.md) | Re-attaching registered media in Studio |
| [`X-ACCOUNT-LINKING.md`](X-ACCOUNT-LINKING.md) | Optional X account linking |

## Archive — [`archive/`](archive/)

Superseded material kept as historical evidence. Nothing here has been deleted.

| Document | Why archived |
| --- | --- |
| [`summit/THE-VOID-SUMMIT-CERTIFICATION.md`](archive/summit/THE-VOID-SUMMIT-CERTIFICATION.md) | Summit was an internal Fuji demo fixture, not a public release (marked historical in the document) |
| [`summit/SUMMIT-VERTICAL-SLICE-STATUS.md`](archive/summit/SUMMIT-VERTICAL-SLICE-STATUS.md) | Same: Summit historical certification record |
| [`summit/COLLECT-DIAGNOSIS.md`](archive/summit/COLLECT-DIAGNOSIS.md) | Same: Summit historical certification record (2026-09-18) |
| [`duplicates/PRODUCTION-INFRASTRUCTURE-AUDIT.root-copy.md`](archive/duplicates/PRODUCTION-INFRASTRUCTURE-AUDIT.root-copy.md) | Former root copy of [`PRODUCTION-INFRASTRUCTURE-AUDIT.md`](PRODUCTION-INFRASTRUCTURE-AUDIT.md). Content identical except link paths. Candidate for deletion; kept until the owner approves. |

## File locations changed on 2026-11-01

Root-level reports moved into the folders above with `git mv`, so `git log --follow <new path>` shows their full
history. Code and scripts that name these files (for example as a `source:` label in
`scripts/fuji-chain-authority-probe.mjs`) refer to them by file name only; every file name is unchanged.
