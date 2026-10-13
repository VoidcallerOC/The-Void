import { getAddress, getCreateAddress, keccak256 } from "ethers";
import { bindPlan } from "./plan-binding-core.mjs";
import { MAINNET_FEE_RECIPIENT } from "./mainnet-signing-requests.mjs";
import { profileFor } from "./network-profiles.mjs";
import { PROBE_CONTRACT, PROBE_LABEL } from "./fuji-rabby-probe.mjs";

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

const deployerOf = (kind, plan) => (kind === "genesis-claim-mainnet" ? plan.deployer : plan.deployer?.address);

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
  }
  if (kind === "rabby-probe-fuji") {
    if (plan.probe.contract !== PROBE_CONTRACT || plan.probe.label !== PROBE_LABEL) fail("The Fuji plan is not the RabbySigningProbe test.");
    if (!requests[0].data.endsWith(PROBE_LABEL.slice(2))) fail("The probe's creation data does not carry its label.");
    if (getAddress(plan.probe.predictedAddress) !== getAddress(requests[0].predictedAddress)) fail("The probe address disagrees with its transaction.");
  }
  return entry;
}
