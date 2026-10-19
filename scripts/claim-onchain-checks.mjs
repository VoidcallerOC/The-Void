import { Interface, getAddress } from "ethers";

// On-chain state check of a mined GenesisHolderClaim against its reviewed plan: every constructor
// parameter, including the admin and the voucher signer. Read-only and browser-safe: the owner
// deployment page runs it after the Rabby-signed deployment, and the Node verifier uses it too.
// Returns the problems (empty means it matches) and the facts, including whether the release has
// already granted the claim ISSUER_ROLE (a separate artist operation).
export const CLAIM_INTERFACE = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)", "function publicAllocation() view returns (uint256)", "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)", "function publicSaleStart() view returns (uint256)", "function publicSaleEnd() view returns (uint256)", "function publicPriceWei() view returns (uint256)",
  "function claimWindow() view returns (uint256)", "function publicWindow() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)", "function admin() view returns (address)", "function signer() view returns (address)",
  "function paused() view returns (bool)",
]);
const RELEASE_ROLES = new Interface(["function ISSUER_ROLE() view returns (bytes32)", "function hasRole(bytes32 role,address account) view returns (bool)"]);

async function read(provider, iface, to, name, args = []) {
  return iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name, args) }))[0];
}

/** The parameters a plan commits to, keyed by the claim's view names. */
export function expectedClaimParameters(plan) {
  return {
    releaseContract: plan.target.releaseContract, primarySale: plan.target.primarySale, tokenId: plan.target.tokenId,
    allocation: plan.supply.claimAllocation, publicAllocation: plan.supply.publicAllocation,
    claimStart: plan.schedule.claimStart, claimWindow: plan.schedule.claimWindowSeconds, publicWindow: plan.schedule.publicWindowSeconds,
    claimEnd: plan.schedule.claimEnd, publicSaleStart: plan.schedule.publicSaleStart, publicSaleEnd: plan.schedule.publicSaleEnd, publicPriceWei: plan.schedule.publicPriceWei,
    ELIGIBILITY_RULE: plan.eligibility.rule, admin: plan.roles.admin, signer: plan.roles.signer,
  };
}

export async function checkClaimState(provider, plan, claimAddress) {
  const expected = expectedClaimParameters(plan);
  const onchain = {};
  for (const name of Object.keys(expected)) onchain[name] = await read(provider, CLAIM_INTERFACE, claimAddress, name);
  const problems = Object.keys(expected).filter((name) => String(onchain[name]).toLowerCase() !== String(expected[name]).toLowerCase()).map((name) => `${name} is ${onchain[name]}, not ${expected[name]}`);
  const paused = await read(provider, CLAIM_INTERFACE, claimAddress, "paused");
  const issuerRole = await read(provider, RELEASE_ROLES, plan.target.releaseContract, "ISSUER_ROLE");
  const issuerGranted = await read(provider, RELEASE_ROLES, plan.target.releaseContract, "hasRole", [issuerRole, claimAddress]);
  return { problems, facts: { parameters: expected, paused, issuerGrant: issuerGranted ? "GRANTED" : "PENDING (artist operation)", admin: getAddress(onchain.admin), signer: getAddress(onchain.signer) } };
}
