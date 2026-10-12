import { Contract, Interface, getAddress } from "ethers";
import { MAINNET_CHAIN_ID } from "./mainnet-signing-requests.mjs";

// On-chain state checks of the mined release infrastructure against its reviewed plan: the immutable
// fee recipient, the 250 bps fees, the royalty lock, the implementation the factory created and the
// factory the marketplace is bound to. Read-only and browser-safe: the owner deployment page runs
// them after each Rabby-signed step, and the Node verifier runs them together with its runtime-code
// comparison against the compiled artifacts. Each returns a list of problems (empty means it matches).
export const FEE_BPS = 250;
export const ROYALTY_BPS = 250;
const FACTORY = new Interface([
  "function implementation() view returns (address)", "function platformRecipient() view returns (address)",
  "function PLATFORM_FEE_BPS() view returns (uint96)", "function RELEASE_VERSION() view returns (uint8)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)",
]);
const IMPLEMENTATION = new Interface(["function REQUIRED_ROYALTY_BPS() view returns (uint96)", "function platformFeeRecipient() view returns (address)"]);
const MARKETPLACE = new Interface([
  "function registry() view returns (address)", "function feeRecipient() view returns (address)", "function platformFeeBps() view returns (uint256)",
  "function deploymentChainId() view returns (uint256)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)",
]);

/** The mined factory and the implementation it created, against the plan's step 1. */
export async function checkFactoryState(provider, plan, factoryAddress) {
  const recipient = getAddress(plan.transactions[0].constructor.platformRecipient);
  const factory = new Contract(factoryAddress, FACTORY, provider);
  const implementationAddress = getAddress(await factory.implementation());
  const [onChainRecipient, onChainFee, onChainVersion, factoryRoyalty] = await Promise.all([factory.platformRecipient(), factory.PLATFORM_FEE_BPS(), factory.RELEASE_VERSION(), factory.REQUIRED_ROYALTY_BPS()]);
  const implementation = new Contract(implementationAddress, IMPLEMENTATION, provider);
  const [implementationRoyalty, implementationForbidden] = await Promise.all([implementation.REQUIRED_ROYALTY_BPS(), implementation.platformFeeRecipient()]);
  const problems = [];
  if (implementationAddress !== getAddress(plan.transactions[0].predictedImplementation)) problems.push(`implementation ${implementationAddress}`);
  if (getAddress(onChainRecipient) !== recipient) problems.push(`platformRecipient ${onChainRecipient}`);
  if (Number(onChainFee) !== FEE_BPS) problems.push(`PLATFORM_FEE_BPS ${onChainFee}`);
  if (Number(onChainVersion) !== 2) problems.push(`RELEASE_VERSION ${onChainVersion}`);
  if (Number(factoryRoyalty) !== ROYALTY_BPS || Number(implementationRoyalty) !== ROYALTY_BPS) problems.push("royalty lock");
  if (getAddress(implementationForbidden) !== recipient) problems.push(`implementation platformFeeRecipient ${implementationForbidden}`);
  return { problems, facts: { implementationAddress, platformRecipient: recipient, platformFeeBps: FEE_BPS, releaseVersion: 2, requiredRoyaltyBps: ROYALTY_BPS } };
}

/** The mined marketplace, against the plan's step 2 (bound to the step-1 factory). */
export async function checkMarketplaceState(provider, plan, marketplaceAddress) {
  const step = plan.transactions[1];
  const marketplace = new Contract(marketplaceAddress, MARKETPLACE, provider);
  const [registry, feeRecipient, platformFeeBps, deploymentChainId, marketplaceRoyalty] = await Promise.all([marketplace.registry(), marketplace.feeRecipient(), marketplace.platformFeeBps(), marketplace.deploymentChainId(), marketplace.REQUIRED_ROYALTY_BPS()]);
  const problems = [];
  if (getAddress(registry) !== getAddress(step.constructor.releaseFactory)) problems.push(`registry ${registry}`);
  if (getAddress(feeRecipient) !== getAddress(step.constructor.feeRecipient)) problems.push(`feeRecipient ${feeRecipient}`);
  if (Number(platformFeeBps) !== FEE_BPS) problems.push(`platformFeeBps ${platformFeeBps}`);
  if (Number(deploymentChainId) !== MAINNET_CHAIN_ID) problems.push(`deploymentChainId ${deploymentChainId}`);
  if (Number(marketplaceRoyalty) !== ROYALTY_BPS) problems.push(`REQUIRED_ROYALTY_BPS ${marketplaceRoyalty}`);
  return { problems, facts: { factoryAddress: getAddress(registry), feeRecipient: getAddress(feeRecipient), feeBps: FEE_BPS, requiredRoyaltyBps: ROYALTY_BPS } };
}
