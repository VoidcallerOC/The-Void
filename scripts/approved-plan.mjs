import { getAddress, getCreateAddress, keccak256 } from "ethers";
import { bindPlan } from "./plan-binding-core.mjs";
import { MAINNET_CHAIN_ID, MAINNET_DEPLOYER, MAINNET_FEE_RECIPIENT } from "./mainnet-signing-requests.mjs";

// An approved plan is a key-less dry-run plan and its binding, committed under
// deploy/mainnet/approved-plans/ through a reviewed PR. Merging that PR is the owner's approval of the
// exact transactions. CI recomputes every transaction's creation data from the compiled source of the
// same commit (test/approved-plans.test.mjs), and the owner deployment page runs this validation again
// in the browser before it offers anything to Rabby. Browser-safe: no I/O and no keys.
export const APPROVED_KINDS = Object.freeze(["release-per-contract-mainnet", "genesis-claim-mainnet"]);

export class ApprovedPlanError extends Error {}
const fail = (message) => { throw new ApprovedPlanError(message); };

const deployerOf = (kind, plan) => (kind === "release-per-contract-mainnet" ? plan.deployer?.address : plan.deployer);

/** Throws unless the entry is internally consistent, bound, for chain 43114 and the defined deployer. */
export function validateApprovedPlan(entry) {
  const { kind, plan, binding } = entry || {};
  if (!APPROVED_KINDS.includes(kind)) fail(`Unknown plan kind ${kind}.`);
  if (binding?.kind !== kind) fail("The binding is for another kind of plan.");
  if (bindPlan(kind, plan, binding.sourceCommit).digest !== binding.digest) fail("The plan does not produce its binding: it was changed after approval.");
  if (plan.chainId !== MAINNET_CHAIN_ID || plan.network !== "mainnet") fail("The plan is not for Avalanche C-Chain (43114).");
  const deployer = getAddress(deployerOf(kind, plan));
  if (deployer !== MAINNET_DEPLOYER) fail(`The plan's deployer is ${deployer}, not the defined deployer ${MAINNET_DEPLOYER}.`);
  const requests = plan.signingRequests || [];
  if (requests.length !== (kind === "release-per-contract-mainnet" ? 2 : 1)) fail("The plan has the wrong number of transactions.");
  requests.forEach((request, index) => {
    if (request.step !== index + 1) fail(`Transaction ${index + 1} is out of order.`);
    if (keccak256(request.data) !== String(request.dataHash).toLowerCase()) fail(`Step ${request.step}: the creation data does not hash to its bound value.`);
    if (getAddress(request.from) !== MAINNET_DEPLOYER || request.chainId !== MAINNET_CHAIN_ID || request.to !== null || String(request.value) !== "0") fail(`Step ${request.step} is not a zero-value contract creation from the deployer on chain 43114.`);
    if (getAddress(request.predictedAddress) !== getCreateAddress({ from: MAINNET_DEPLOYER, nonce: request.nonce })) fail(`Step ${request.step}: the predicted address is not the deployer's CREATE address at nonce ${request.nonce}.`);
    if (index > 0 && request.nonce !== requests[index - 1].nonce + 1) fail("The transactions do not use consecutive nonces.");
  });
  if (kind === "release-per-contract-mainnet") {
    if (getAddress(plan.transactions[0].constructor.platformRecipient) !== MAINNET_FEE_RECIPIENT || getAddress(plan.transactions[1].constructor.feeRecipient) !== MAINNET_FEE_RECIPIENT) fail("The fee recipient is not the recorded Nano S Plus.");
    if (getAddress(plan.transactions[1].constructor.releaseFactory) !== getAddress(requests[0].predictedAddress)) fail("The marketplace is not bound to the factory of step 1.");
  }
  return entry;
}
