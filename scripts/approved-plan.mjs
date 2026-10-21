import { getAddress, getCreateAddress, keccak256 } from "ethers";
import { bindPlan } from "./plan-binding-core.mjs";
import unifiedManifest from "../config/unified-marketplace.json" with { type: "json" };
import { MAINNET_FEE_RECIPIENT } from "./mainnet-signing-requests.mjs";
import { profileFor } from "./network-profiles.mjs";
import { PROBE_CONTRACT, PROBE_LABEL } from "./fuji-rabby-probe.mjs";
import { FUJI_CLAIM_ARTIST, FUJI_GENESIS_VOUCHER_SIGNER } from "./fuji-genesis-claim.mjs";

// An approved plan is a key-less dry-run plan and its binding, committed under
// deploy/mainnet/approved-plans/ through a reviewed PR. Merging that PR is the owner's approval of the
// exact transactions. CI recomputes every transaction's creation data from the compiled source of the
// same commit (test/approved-plans.test.mjs), and the owner deployment page runs this validation again
// in the browser before it offers anything to Rabby. Browser-safe: no I/O and no keys.
// A Fuji test plan (deploy/fuji/approved-plans/) is validated against the Fuji profile only; neither
// network accepts the other's plans.
export const APPROVED_KINDS = profileFor("mainnet").kinds;

export class ApprovedPlanError extends Error {}
const fail = (message) => { throw new ApprovedPlanError(message); };

// The release-infrastructure plan that created the first mainnet pair (factory 0x262B…, credit-only primary
// sales). It stays committed as the record of that deployment; any other release-infrastructure plan must
// deploy the factory whose releases pay the platform fee during the purchase.
export const EXECUTED_RELEASE_FACTORY = "0x262B774cf9a1949170B58E2d57F6189980FE757b";
export const RELEASE_FACTORY_CONTRACT = "VoidReleaseFactoryV2RoyaltySettled";
export const UNIFIED_MARKETPLACE_CONTRACT = "VoidUnifiedMarketplace";

const deployerOf = (kind, plan) => (kind.startsWith("genesis-claim") ? plan.deployer : plan.deployer?.address);

/** Throws unless the entry is internally consistent, bound, for the network's chain and the defined deployer. */
export function validateApprovedPlan(entry, network = "mainnet") {
  const profile = profileFor(network);
  const { chainId: CHAIN_ID, deployer: DEPLOYER } = profile;
  const { kind, plan, binding } = entry || {};
  if (!profile.kinds.includes(kind)) fail(`Unknown plan kind ${kind} for ${profile.name}.`);
  if (binding?.kind !== kind) fail("The binding is for another kind of plan.");
  if (bindPlan(kind, plan, binding.sourceCommit).digest !== binding.digest) fail("The plan does not produce its binding: it was changed after approval.");
  if (plan.chainId !== CHAIN_ID || plan.network !== network) fail(`The plan is not for ${profile.name} (${CHAIN_ID}).`);
  const deployer = getAddress(deployerOf(kind, plan));
  if (deployer !== DEPLOYER) fail(`The plan's deployer is ${deployer}, not the defined deployer ${DEPLOYER}.`);
  const requests = plan.signingRequests || [];
  if (requests.length !== (kind === "release-per-contract-mainnet" ? 2 : 1)) fail("The plan has the wrong number of transactions.");
  requests.forEach((request, index) => {
    if (request.step !== index + 1) fail(`Transaction ${index + 1} is out of order.`);
    if (keccak256(request.data) !== String(request.dataHash).toLowerCase()) fail(`Step ${request.step}: the creation data does not hash to its bound value.`);
    if (getAddress(request.from) !== DEPLOYER || request.chainId !== CHAIN_ID || request.to !== null || String(request.value) !== "0") fail(`Step ${request.step} is not a zero-value contract creation from the deployer on chain ${CHAIN_ID}.`);
    if (getAddress(request.predictedAddress) !== getCreateAddress({ from: DEPLOYER, nonce: request.nonce })) fail(`Step ${request.step}: the predicted address is not the deployer's CREATE address at nonce ${request.nonce}.`);
    if (index > 0 && request.nonce !== requests[index - 1].nonce + 1) fail("The transactions do not use consecutive nonces.");
  });
  if (kind === "release-per-contract-mainnet") {
    if (getAddress(plan.transactions[0].constructor.platformRecipient) !== MAINNET_FEE_RECIPIENT || getAddress(plan.transactions[1].constructor.feeRecipient) !== MAINNET_FEE_RECIPIENT) fail("The fee recipient is not the recorded Nano S Plus.");
    if (getAddress(plan.transactions[1].constructor.releaseFactory) !== getAddress(requests[0].predictedAddress)) fail("The marketplace is not bound to the factory of step 1.");
    const executed = getAddress(requests[0].predictedAddress) === EXECUTED_RELEASE_FACTORY;
    // Every new release-infrastructure plan deploys the single unified marketplace, bound to that factory, the production
    // factory and the Genesis collection at its existing royalty receiver (config/unified-marketplace.json).
    const market = plan.transactions[1];
    if (!executed && (market.contract !== UNIFIED_MARKETPLACE_CONTRACT || requests[1].contract !== UNIFIED_MARKETPLACE_CONTRACT || plan.artifacts?.marketplace?.path !== `out/${UNIFIED_MARKETPLACE_CONTRACT}.sol/${UNIFIED_MARKETPLACE_CONTRACT}.json`)) fail(`A new release-infrastructure plan must deploy ${UNIFIED_MARKETPLACE_CONTRACT}.`);
    if (!executed && (getAddress(market.constructor.legacyReleaseFactory) !== EXECUTED_RELEASE_FACTORY || getAddress(market.constructor.genesisCollection) !== getAddress(unifiedManifest.genesis.address) || Number(market.constructor.genesisMaxTokenId) !== Number(unifiedManifest.genesis.maxTokenId) || getAddress(market.constructor.genesisRoyaltyReceiver) !== getAddress(unifiedManifest.genesis.royaltyReceiver))) fail("The unified marketplace is not bound to the production factory and the recorded Genesis collection, token range and royalty receiver.");
    if (!executed && (plan.transactions[0].contract !== RELEASE_FACTORY_CONTRACT || requests[0].contract !== RELEASE_FACTORY_CONTRACT || plan.artifacts?.factory?.path !== `out/${RELEASE_FACTORY_CONTRACT}.sol/${RELEASE_FACTORY_CONTRACT}.json`)) fail(`A new release-infrastructure plan must deploy ${RELEASE_FACTORY_CONTRACT}.`);
  }
  if (kind === "genesis-claim-fuji") {
    if (getAddress(plan.roles.admin) !== FUJI_CLAIM_ARTIST) fail(`The Fuji claim admin must be the artist wallet ${FUJI_CLAIM_ARTIST}, not ${plan.roles.admin}.`);
    if (getAddress(plan.roles.signer) !== FUJI_GENESIS_VOUCHER_SIGNER) fail(`This Fuji claim plan must deploy the dedicated voucher signer ${FUJI_GENESIS_VOUCHER_SIGNER}, not ${plan.roles.signer}.`);
    if (plan.supply.claimAllocation !== "0" || plan.supply.publicAllocation !== "0") fail("The Fuji claim must be an uncapped open edition (both allocations 0).");
    if (getAddress(plan.followUps?.issuerGrant?.from) !== FUJI_CLAIM_ARTIST) fail("The ISSUER_ROLE grant must come from the artist wallet.");
    if (getAddress(plan.predictedClaimAddress) !== getAddress(requests[0].predictedAddress)) fail("The claim address disagrees with its transaction.");
  }
  if (kind === "rabby-probe-fuji") {
    if (plan.probe.contract !== PROBE_CONTRACT || plan.probe.label !== PROBE_LABEL) fail("The Fuji plan is not the RabbySigningProbe test.");
    if (!requests[0].data.endsWith(PROBE_LABEL.slice(2))) fail("The probe's creation data does not carry its label.");
    if (getAddress(plan.probe.predictedAddress) !== getAddress(requests[0].predictedAddress)) fail("The probe address disagrees with its transaction.");
  }
  return entry;
}
