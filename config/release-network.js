import fuji from "./fuji-release.json" with { type: "json" };
import fujiPerContract from "./fuji-release-per-contract.json" with { type: "json" };
import fujiPerContractV2 from "./fuji-release-per-contract-v2.json" with { type: "json" };
import mainnet from "./mainnet-release.json" with { type: "json" };

// One deployment per environment. Fuji is the default; mainnet is an explicit
// opt-in (VITE_RELEASE_NETWORK in the web build, RELEASE_NETWORK on the server)
// and refuses to load until config/mainnet-release.json holds deployed addresses.
export const RELEASE_DEPLOYMENTS = Object.freeze({ fuji, mainnet });
// Individual release addresses are discovered from this factory at runtime;
// this manifest contains only public infrastructure addresses.
export const FUJI_RELEASE_PER_CONTRACT = Object.freeze(fujiPerContract);
// V2 is separate from the existing immutable V1 deployment. Provisioning remains
// disabled until a future, separately authorized deployment is configured.
export const FUJI_RELEASE_PER_CONTRACT_V2 = Object.freeze(fujiPerContractV2);

// Factory V3 (ReleaseCreated version 3) clones VoidRelease1155V5, which records the provenance
// root inside the edition-creating transaction and is its own provenance anchor. Releases from
// version 2 factories keep the separate VoidProvenanceAnchor transaction.
export const PROVENANCE_AT_CREATION_RELEASE_VERSION = 3;
export function anchorsProvenanceAtCreation(releaseVersion) {
  const version = Number(releaseVersion);
  return Number.isSafeInteger(version) && version >= PROVENANCE_AT_CREATION_RELEASE_VERSION;
}

// Every V2 release-per-contract deployment on Fuji: the active (album-capable) factory first,
// then historical ones. Factory clones are immutable and each ReleaseMarketplaceV3 accepts only
// its own factory's releases, so a release always trades on the marketplace of the factory that
// created it. Historical deployments stay fully supported for the releases they already hold.
export const FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS = Object.freeze([
  { factoryAddress: fujiPerContractV2.factoryAddress, implementationAddress: fujiPerContractV2.implementationAddress, marketplaceAddress: fujiPerContractV2.marketplaceAddress, factoryDeploymentBlock: fujiPerContractV2.factoryDeploymentBlock, marketplaceDeploymentBlock: fujiPerContractV2.marketplaceDeploymentBlock, releaseVersion: fujiPerContractV2.releaseVersion, albumCapable: fujiPerContractV2.albumCapable === true, active: true },
  ...(fujiPerContractV2.historicalDeployments || []).map((deployment) => ({ ...deployment, albumCapable: deployment.albumCapable === true, active: false })),
].map((deployment) => Object.freeze({ ...deployment, chainId: Number(fujiPerContractV2.chainId), provenanceAtCreation: anchorsProvenanceAtCreation(deployment.releaseVersion) })));

const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";

export function releaseDeploymentForFactory(factoryAddress) {
  return FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS.find((deployment) => sameAddress(deployment.factoryAddress, factoryAddress)) || null;
}

export function releaseDeploymentForMarketplace(marketplaceAddress) {
  return FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS.find((deployment) => sameAddress(deployment.marketplaceAddress, marketplaceAddress)) || null;
}

function requestedNetwork() {
  const web = typeof import.meta !== "undefined" ? import.meta.env?.VITE_RELEASE_NETWORK : undefined;
  const node = globalThis.process?.env?.RELEASE_NETWORK;
  return String(web || node || "fuji").trim().toLowerCase();
}

export function releaseDeploymentFor(network) {
  const name = String(network || "fuji").trim().toLowerCase();
  const deployment = RELEASE_DEPLOYMENTS[name];
  if (!deployment) throw new Error(`Unknown release network "${network}". Use "fuji" or "mainnet".`);
  if (name === "mainnet" && (!deployment.deployed || !deployment.contractAddress || !deployment.primarySaleAddress)) {
    throw new Error("Mainnet release contracts are not deployed yet: config/mainnet-release.json has no contract addresses.");
  }
  return deployment;
}

export const RELEASE_NETWORK = requestedNetwork();
export const RELEASE_DEPLOYMENT = releaseDeploymentFor(RELEASE_NETWORK);
export const IS_MAINNET_RELEASE = RELEASE_DEPLOYMENT.chainId === 43114;
