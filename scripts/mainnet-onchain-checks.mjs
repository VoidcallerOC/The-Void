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
  "function releaseFactory() view returns (address)", "function legacyReleaseFactory() view returns (address)", "function feeRecipient() view returns (address)",
  "function genesisCollection() view returns (address)", "function genesisMaxTokenId() view returns (uint256)", "function genesisRoyaltyReceiver() view returns (address)",
  "function deploymentChainId() view returns (uint256)", "function FACTORY_PLATFORM_FEE_BPS() view returns (uint256)", "function FACTORY_ROYALTY_BPS() view returns (uint96)",
  "function GENESIS_PLATFORM_FEE_BPS() view returns (uint256)", "function GENESIS_ROYALTY_BPS() view returns (uint256)",
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

/** The mined VoidUnifiedMarketplace, against the plan's step 2 (bound to the step-1 factory, the production factory and Genesis). */
export async function checkMarketplaceState(provider, plan, marketplaceAddress) {
  const step = plan.transactions[1];
  const expected = step.constructor;
  const marketplace = new Contract(marketplaceAddress, MARKETPLACE, provider);
  const [releaseFactory, legacyReleaseFactory, feeRecipient, genesisCollection, genesisMaxTokenId, genesisRoyaltyReceiver, deploymentChainId, factoryFee, factoryRoyalty, genesisFee, genesisRoyalty] = await Promise.all([
    marketplace.releaseFactory(), marketplace.legacyReleaseFactory(), marketplace.feeRecipient(), marketplace.genesisCollection(), marketplace.genesisMaxTokenId(), marketplace.genesisRoyaltyReceiver(),
    marketplace.deploymentChainId(), marketplace.FACTORY_PLATFORM_FEE_BPS(), marketplace.FACTORY_ROYALTY_BPS(), marketplace.GENESIS_PLATFORM_FEE_BPS(), marketplace.GENESIS_ROYALTY_BPS(),
  ]);
  const problems = [];
  if (getAddress(releaseFactory) !== getAddress(expected.releaseFactory)) problems.push(`releaseFactory ${releaseFactory}`);
  if (getAddress(legacyReleaseFactory) !== getAddress(expected.legacyReleaseFactory)) problems.push(`legacyReleaseFactory ${legacyReleaseFactory}`);
  if (getAddress(feeRecipient) !== getAddress(expected.feeRecipient)) problems.push(`feeRecipient ${feeRecipient}`);
  if (getAddress(genesisCollection) !== getAddress(expected.genesisCollection)) problems.push(`genesisCollection ${genesisCollection}`);
  if (Number(genesisMaxTokenId) !== Number(expected.genesisMaxTokenId)) problems.push(`genesisMaxTokenId ${genesisMaxTokenId}`);
  if (getAddress(genesisRoyaltyReceiver) !== getAddress(expected.genesisRoyaltyReceiver)) problems.push(`genesisRoyaltyReceiver ${genesisRoyaltyReceiver}`);
  if (Number(deploymentChainId) !== MAINNET_CHAIN_ID) problems.push(`deploymentChainId ${deploymentChainId}`);
  if (Number(factoryFee) !== FEE_BPS || Number(factoryRoyalty) !== ROYALTY_BPS) problems.push(`factory economics ${factoryFee}/${factoryRoyalty}`);
  if (Number(genesisFee) !== 0 || Number(genesisRoyalty) !== 500) problems.push(`Genesis economics ${genesisFee}/${genesisRoyalty}`);
  return { problems, facts: { factoryAddress: getAddress(releaseFactory), legacyReleaseFactory: getAddress(legacyReleaseFactory), feeRecipient: getAddress(feeRecipient), feeBps: FEE_BPS, requiredRoyaltyBps: ROYALTY_BPS, genesisCollection: getAddress(genesisCollection), genesisMaxTokenId: Number(genesisMaxTokenId), genesisRoyaltyReceiver: getAddress(genesisRoyaltyReceiver) } };
}
